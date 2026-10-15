"""End-to-end test against a running CloudWorm API (deployed stack or local dev server).

Skipped unless CLOUDWORM_API_URL and CLOUDWORM_ACCESS_CODE are set:

    CLOUDWORM_API_URL=http://127.0.0.1:3001 CLOUDWORM_ACCESS_CODE=local-dev-code \
        .venv/bin/python -m pytest tests/integration -v

It uploads random bytes standing in for ciphertext (the server never sees
plaintext, so it cannot tell the difference), downloads them back through the
presigned URLs, compares them byte for byte, then deletes the transfer.
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import urllib.error
import urllib.request

import pytest

API = os.environ.get("CLOUDWORM_API_URL", "").rstrip("/")
CODE = os.environ.get("CLOUDWORM_ACCESS_CODE", "")
CHUNK = 8 * 1024 * 1024
TAG = 16

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not (API and CODE), reason="set CLOUDWORM_API_URL and CLOUDWORM_ACCESS_CODE"),
]


def call(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("x-owner-token", token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def put(url: str, payload: bytes) -> str:
    req = urllib.request.Request(url, data=payload, method="PUT")
    # urllib would otherwise default to a form content type; browsers send none for binary bodies.
    req.add_header("content-type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.headers["ETag"]


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as resp:
        return resp.read()


def ct_size(size: int) -> int:
    return size + TAG * max(1, -(-size // CHUNK))


def test_full_transfer_lifecycle():
    sizes = [1234, CHUNK + 4321]  # one single-PUT file, one 2-part multipart file
    blobs = [secrets.token_bytes(ct_size(s)) for s in sizes]
    enc = base64.urlsafe_b64encode(secrets.token_bytes(40)).decode().rstrip("=")

    status, cfg = call("GET", "/config")
    assert status == 200 and cfg["chunkBytes"] == CHUNK

    status, err = call("POST", "/transfers", {"accessCode": "wrong", "expiresInHours": cfg["defaultExpiryHours"],
                                              "files": [{"size": 1, "encName": enc}]})
    assert status == 401, err

    status, created = call("POST", "/transfers", {
        "accessCode": CODE, "expiresInHours": cfg["expiryHoursOptions"][0],
        "files": [{"size": s, "encName": enc, "ext": "bin"} for s in sizes],
    })
    assert status == 201, created
    tid, tok = created["transferId"], created["ownerToken"]

    for f, blob in zip(created["files"], blobs):
        idx, parts = f["index"], f["partCount"]
        status, urls = call("POST", f"/transfers/{tid}/files/{idx}/upload-urls",
                            {"partNumbers": list(range(1, parts + 1))}, tok)
        assert status == 200, urls
        etags = []
        for u in urls["urls"]:
            n = u["partNumber"]
            piece = blob[(n - 1) * (CHUNK + TAG): n * (CHUNK + TAG)]
            etags.append({"partNumber": n, "etag": put(u["url"], piece)})
        body = {"parts": etags} if parts > 1 else None
        status, done = call("POST", f"/transfers/{tid}/files/{idx}/complete", body, tok)
        assert status == 200, done

    status, view = call("POST", f"/transfers/{tid}/finalize", {}, tok)
    assert status == 200 and view["status"] == "ready", view

    for idx, blob in enumerate(blobs):
        status, dl = call("POST", f"/transfers/{tid}/files/{idx}/download-url", {})
        assert status == 200, dl
        assert get(dl["url"]) == blob

    status, view = call("GET", f"/transfers/{tid}")
    assert status == 200 and view["totalDownloads"] == 2

    status, _ = call("DELETE", f"/transfers/{tid}", None, tok)
    assert status == 200
    status, err = call("GET", f"/transfers/{tid}")
    assert status == 410 and err["error"]["code"] == "transfer_deleted"


def test_invalid_and_unknown_ids():
    assert call("GET", "/transfers/not-a-valid-id")[0] == 400
    assert call("GET", f"/transfers/{secrets.token_urlsafe(16)}")[0] == 404

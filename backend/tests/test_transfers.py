from __future__ import annotations

import hashlib
from urllib.parse import parse_qs, urlparse

import boto3
import pytest

from cloudworm import core, receiver, sender
from cloudworm.config import CHUNK_BYTES, ciphertext_size, encrypted_part_size

from .conftest import ACCESS_CODE, BUCKET, REGION, TABLE, enc_name, event, parse

CREATE = "POST /transfers"
UPLOAD_URLS = "POST /transfers/{transferId}/files/{fileIndex}/upload-urls"
COMPLETE = "POST /transfers/{transferId}/files/{fileIndex}/complete"
FINALIZE = "POST /transfers/{transferId}/finalize"
DELETE = "DELETE /transfers/{transferId}"
GET = "GET /transfers/{transferId}"
DOWNLOAD = "POST /transfers/{transferId}/files/{fileIndex}/download-url"


def create(files=None, code=ACCESS_CODE, hours=24, **extra):
    body = {"accessCode": code, "expiresInHours": hours, "files": files if files is not None else [{"size": 10, "encName": enc_name()}]}
    body.update(extra)
    return parse(sender.handler(event(CREATE, body=body)))


def owner(token):
    return {"x-owner-token": token}


def item(transfer_id):
    return boto3.resource("dynamodb", region_name=REGION).Table(TABLE).get_item(Key={"transferId": transfer_id})["Item"]


def upload_all(s3, transfer_id, token, sizes):
    """Simulate the browser: upload exact ciphertext sizes, complete every file, finalize."""
    for index, size in enumerate(sizes):
        key = core.object_key(transfer_id, index)
        f = item(transfer_id)["files"][index]
        if int(f["partCount"]) == 1:
            s3.put_object(Bucket=BUCKET, Key=key, Body=b"\0" * ciphertext_size(size))
            body = None
        else:
            parts = []
            for n in range(1, int(f["partCount"]) + 1):
                r = s3.upload_part(
                    Bucket=BUCKET, Key=key, UploadId=f["uploadId"], PartNumber=n,
                    Body=b"\0" * encrypted_part_size(size, n),
                )
                parts.append({"partNumber": n, "etag": r["ETag"]})
            body = {"parts": parts}
        status, data = parse(sender.handler(event(COMPLETE, {"transferId": transfer_id, "fileIndex": index}, body, owner(token))))
        assert status == 200, data
    return parse(sender.handler(event(FINALIZE, {"transferId": transfer_id}, {}, owner(token))))


# --- create ------------------------------------------------------------------
def test_create_rejects_wrong_access_code():
    status, data = create(code="nope")
    assert status == 401 and data["error"]["code"] == "invalid_access_code"


def test_create_fails_closed_without_configured_code(monkeypatch):
    monkeypatch.setenv("ACCESS_CODE_HASH", "")
    core.reset_services()
    status, data = create()
    assert status == 503 and data["error"]["code"] == "uploads_disabled"


@pytest.mark.parametrize(
    "kwargs,code",
    [
        ({"hours": 5}, "invalid_expiry"),
        ({"hours": True}, "invalid_expiry"),
        ({"files": [{"size": 1, "encName": enc_name()}] * 6}, "too_many_files"),
        ({"files": [{"size": 41 * 1024 * 1024, "encName": enc_name()}]}, "file_too_large"),
        ({"files": [{"size": 35 * 1024 * 1024, "encName": enc_name()}] * 2}, "transfer_too_large"),
        ({"files": [{"size": -1, "encName": enc_name()}]}, "invalid_request"),
        ({"files": [{"size": True, "encName": enc_name()}]}, "invalid_request"),
        ({"files": [{"size": 1, "encName": "<script>"}]}, "invalid_request"),
        ({"files": []}, "invalid_request"),
    ],
)
def test_create_validation(kwargs, code):
    status, data = create(**kwargs)
    assert status in (400, 413)
    assert data["error"]["code"] == code


def test_create_rejects_malformed_json():
    ev = event(CREATE)
    ev["body"] = "{not json"
    status, data = parse(sender.handler(ev))
    assert status == 400 and data["error"]["code"] == "invalid_json"


def test_extension_allowlist(monkeypatch):
    monkeypatch.setenv("ALLOWED_EXTENSIONS", "pdf,png")
    core.reset_services()
    assert create(files=[{"size": 1, "encName": enc_name(), "ext": "exe"}])[0] == 400
    assert create(files=[{"size": 1, "encName": enc_name()}])[0] == 400
    status, data = create(files=[{"size": 1, "encName": enc_name(), "ext": "PDF"}])
    assert status == 201
    assert item(data["transferId"])["files"][0]["ext"] == "pdf"


def test_create_success_stores_hashed_owner_token_and_starts_multipart():
    big = CHUNK_BYTES * 2 + 5
    status, data = create(files=[{"size": 10, "encName": enc_name("a")}, {"size": big, "encName": enc_name("b")}])
    assert status == 201
    assert core.TRANSFER_ID_RE.match(data["transferId"])
    assert core.OWNER_TOKEN_RE.match(data["ownerToken"])
    assert data["files"] == [{"index": 0, "partCount": 1}, {"index": 1, "partCount": 3}]

    stored = item(data["transferId"])
    assert stored["status"] == "uploading"
    assert stored["ownerTokenHash"] == hashlib.sha256(data["ownerToken"].encode()).hexdigest()
    assert data["ownerToken"] not in str(stored)  # never stored in plaintext
    assert "uploadId" not in stored["files"][0]
    assert stored["files"][1]["uploadId"]
    assert int(stored["ttl"]) > int(stored["expiresAt"])  # TTL is only a cleanup backstop


def test_transfer_ids_are_unique():
    ids = {create()[1]["transferId"] for _ in range(20)}
    assert len(ids) == 20


# --- upload urls -----------------------------------------------------------
def test_upload_urls_require_owner_token():
    _, data = create()
    tid = data["transferId"]
    ev = event(UPLOAD_URLS, {"transferId": tid, "fileIndex": 0}, {"partNumbers": [1]}, owner("x" * 43))
    status, err = parse(sender.handler(ev))
    assert status == 403 and err["error"]["code"] == "forbidden"
    ev = event(UPLOAD_URLS, {"transferId": tid, "fileIndex": 0}, {"partNumbers": [1]})
    assert parse(sender.handler(ev))[0] == 403


def test_upload_urls_validate_part_numbers():
    _, data = create()
    tid, tok = data["transferId"], data["ownerToken"]
    for parts in ([0], [2], [1, 1], [], ["1"], None):
        ev = event(UPLOAD_URLS, {"transferId": tid, "fileIndex": 0}, {"partNumbers": parts}, owner(tok))
        assert parse(sender.handler(ev))[0] == 400, parts
    ev = event(UPLOAD_URLS, {"transferId": tid, "fileIndex": 9}, {"partNumbers": [1]}, owner(tok))
    assert parse(sender.handler(ev))[0] == 404


def test_upload_urls_are_short_lived_and_sign_content_length():
    big = CHUNK_BYTES + 100
    _, data = create(files=[{"size": 10, "encName": enc_name()}, {"size": big, "encName": enc_name()}])
    tid, tok = data["transferId"], data["ownerToken"]

    status, single = parse(sender.handler(event(UPLOAD_URLS, {"transferId": tid, "fileIndex": 0}, {"partNumbers": [1]}, owner(tok))))
    assert status == 200 and single["expiresIn"] <= 900
    q = parse_qs(urlparse(single["urls"][0]["url"]).query)
    assert q["X-Amz-Expires"] == [str(single["expiresIn"])]
    assert "content-length" in q["X-Amz-SignedHeaders"][0]

    status, multi = parse(sender.handler(event(UPLOAD_URLS, {"transferId": tid, "fileIndex": 1}, {"partNumbers": [1, 2]}, owner(tok))))
    assert status == 200
    urls = [urlparse(u["url"]) for u in multi["urls"]]
    assert all("uploadId" in parse_qs(u.query) for u in urls)
    assert urls[0].hostname == f"{BUCKET}.s3.{REGION}.amazonaws.com"  # regional virtual-hosted endpoint


def test_upload_url_ttl_never_exceeds_transfer_expiry(clock):
    _, data = create(hours=1)
    clock.advance(3600 - 30)
    ev = event(UPLOAD_URLS, {"transferId": data["transferId"], "fileIndex": 0}, {"partNumbers": [1]}, owner(data["ownerToken"]))
    status, body = parse(sender.handler(ev))
    assert status == 200 and body["expiresIn"] == 30


# --- complete / finalize -----------------------------------------------------
def test_full_flow_single_and_multipart(s3):
    sizes = [10, CHUNK_BYTES * 2 + 3]
    _, data = create(files=[{"size": s, "encName": enc_name()} for s in sizes])
    status, view = upload_all(s3, data["transferId"], data["ownerToken"], sizes)
    assert status == 200
    assert view["status"] == "ready"
    assert [f["uploaded"] for f in view["files"]] == [True, True]
    head = s3.head_object(Bucket=BUCKET, Key=core.object_key(data["transferId"], 1))
    assert head["ContentLength"] == ciphertext_size(sizes[1])
    assert "uploadId" not in item(data["transferId"])["files"][1]


def test_complete_detects_size_mismatch_and_fails_transfer(s3):
    _, data = create(files=[{"size": 100, "encName": enc_name()}])
    tid, tok = data["transferId"], data["ownerToken"]
    s3.put_object(Bucket=BUCKET, Key=core.object_key(tid, 0), Body=b"\0" * 5000)  # wrong size
    status, err = parse(sender.handler(event(COMPLETE, {"transferId": tid, "fileIndex": 0}, None, owner(tok))))
    assert status == 422 and err["error"]["code"] == "size_mismatch"
    assert item(tid)["status"] == "failed"
    assert s3.list_objects_v2(Bucket=BUCKET).get("KeyCount", 0) == 0
    assert parse(receiver.handler(event(GET, {"transferId": tid})))[0] == 410


def test_complete_without_upload_is_rejected():
    _, data = create()
    ev = event(COMPLETE, {"transferId": data["transferId"], "fileIndex": 0}, None, owner(data["ownerToken"]))
    status, err = parse(sender.handler(ev))
    assert status == 400 and err["error"]["code"] == "upload_incomplete"


def test_complete_multipart_requires_all_parts_in_order(s3):
    size = CHUNK_BYTES * 2 + 1
    _, data = create(files=[{"size": size, "encName": enc_name()}])
    tid, tok = data["transferId"], data["ownerToken"]
    ev = event(COMPLETE, {"transferId": tid, "fileIndex": 0}, {"parts": [{"partNumber": 2, "etag": "x"}] * 3}, owner(tok))
    assert parse(sender.handler(ev))[0] == 400
    ev = event(COMPLETE, {"transferId": tid, "fileIndex": 0}, {"parts": [{"partNumber": 1, "etag": "x"}]}, owner(tok))
    assert parse(sender.handler(ev))[0] == 400


def test_finalize_requires_all_files():
    _, data = create()
    status, err = parse(sender.handler(event(FINALIZE, {"transferId": data["transferId"]}, {}, owner(data["ownerToken"]))))
    assert status == 409 and err["error"]["code"] == "upload_incomplete"


def test_cannot_reupload_after_completion(s3):
    _, data = create()
    upload_all(s3, data["transferId"], data["ownerToken"], [10])
    ev = event(UPLOAD_URLS, {"transferId": data["transferId"], "fileIndex": 0}, {"partNumbers": [1]}, owner(data["ownerToken"]))
    assert parse(sender.handler(ev))[0] == 409


# --- receiver -----------------------------------------------------------------
def test_config_is_public_and_has_limits():
    status, cfg = parse(receiver.handler(event("GET /config")))
    assert status == 200
    assert cfg["maxFiles"] == 5 and cfg["expiryHoursOptions"] == [1, 24, 168]
    assert cfg["chunkBytes"] == CHUNK_BYTES and cfg["uploadsEnabled"] is True


@pytest.mark.parametrize("bad", ["short", "a" * 23, "../../etc/passwd....", "a" * 21 + "!"])
def test_invalid_transfer_ids_are_rejected(bad):
    status, err = parse(receiver.handler(event(GET, {"transferId": bad})))
    assert status == 400 and err["error"]["code"] == "invalid_transfer_id"


def test_unknown_transfer_is_404():
    status, err = parse(receiver.handler(event(GET, {"transferId": core.new_transfer_id()})))
    assert status == 404 and err["error"]["code"] == "transfer_not_found"


def test_metadata_does_not_leak_secrets(s3):
    _, data = create()
    upload_all(s3, data["transferId"], data["ownerToken"], [10])
    status, view = parse(receiver.handler(event(GET, {"transferId": data["transferId"]})))
    assert status == 200
    assert "ownerTokenHash" not in str(view) and "uploadId" not in str(view)
    assert view["files"][0]["size"] == 10 and view["files"][0]["ciphertextSize"] == 26


def test_download_counts_and_url(s3):
    _, data = create(files=[{"size": 10, "encName": enc_name()}, {"size": 20, "encName": enc_name()}])
    tid = data["transferId"]
    upload_all(s3, tid, data["ownerToken"], [10, 20])
    for _ in range(2):
        status, body = parse(receiver.handler(event(DOWNLOAD, {"transferId": tid, "fileIndex": 1})))
        assert status == 200 and body["expiresIn"] <= 300
        q = parse_qs(urlparse(body["url"]).query)
        assert q["X-Amz-Expires"] == [str(body["expiresIn"])]
    _, view = parse(receiver.handler(event(GET, {"transferId": tid})))
    assert [f["downloadCount"] for f in view["files"]] == [0, 2]
    assert view["totalDownloads"] == 2


def test_download_rejected_while_uploading():
    _, data = create()
    status, err = parse(receiver.handler(event(DOWNLOAD, {"transferId": data["transferId"], "fileIndex": 0})))
    assert status == 409 and err["error"]["code"] == "transfer_not_ready"


def test_download_unknown_file_index(s3):
    _, data = create()
    upload_all(s3, data["transferId"], data["ownerToken"], [10])
    assert parse(receiver.handler(event(DOWNLOAD, {"transferId": data["transferId"], "fileIndex": 3})))[0] == 404
    assert parse(receiver.handler(event(DOWNLOAD, {"transferId": data["transferId"], "fileIndex": "x"})))[0] == 400


def test_expiry_is_enforced_in_code_not_by_ttl(s3, clock):
    _, data = create(hours=1)
    tid = data["transferId"]
    upload_all(s3, tid, data["ownerToken"], [10])

    clock.advance(3600 - 10)
    status, body = parse(receiver.handler(event(DOWNLOAD, {"transferId": tid, "fileIndex": 0})))
    assert status == 200 and body["expiresIn"] == 10  # URL capped at remaining lifetime

    clock.advance(10)  # exactly at expiry; the DynamoDB item still exists
    assert item(tid)["status"] == "ready"
    for ev in (event(GET, {"transferId": tid}), event(DOWNLOAD, {"transferId": tid, "fileIndex": 0})):
        status, err = parse(receiver.handler(ev))
        assert status == 410 and err["error"]["code"] == "transfer_expired"


def test_sender_delete_revokes_immediately(s3):
    _, data = create(files=[{"size": 10, "encName": enc_name()}, {"size": CHUNK_BYTES + 1, "encName": enc_name()}])
    tid, tok = data["transferId"], data["ownerToken"]
    upload_all(s3, tid, tok, [10, CHUNK_BYTES + 1])

    assert parse(sender.handler(event(DELETE, {"transferId": tid})))[0] == 403
    status, body = parse(sender.handler(event(DELETE, {"transferId": tid}, None, owner(tok))))
    assert status == 200 and body["status"] == "deleted"
    assert s3.list_objects_v2(Bucket=BUCKET).get("KeyCount", 0) == 0
    status, err = parse(receiver.handler(event(GET, {"transferId": tid})))
    assert status == 410 and err["error"]["code"] == "transfer_deleted"
    assert parse(receiver.handler(event(DOWNLOAD, {"transferId": tid, "fileIndex": 0})))[0] == 410
    # idempotent
    assert parse(sender.handler(event(DELETE, {"transferId": tid}, None, owner(tok))))[0] == 200


def test_delete_aborts_pending_multipart_uploads(s3):
    _, data = create(files=[{"size": CHUNK_BYTES * 2, "encName": enc_name()}])
    assert s3.list_multipart_uploads(Bucket=BUCKET).get("Uploads")
    parse(sender.handler(event(DELETE, {"transferId": data["transferId"]}, None, owner(data["ownerToken"]))))
    assert not s3.list_multipart_uploads(Bucket=BUCKET).get("Uploads")


# --- generic error handling ---------------------------------------------------
def test_unknown_route_returns_404():
    assert parse(receiver.handler({"routeKey": "GET /nope"}))[0] == 404


def test_internal_errors_are_not_leaked(monkeypatch):
    def boom(_event):
        raise RuntimeError("secret internal detail")

    monkeypatch.setitem(receiver.ROUTES, "GET /config", boom)
    status, err = parse(receiver.handler(event("GET /config")))
    assert status == 500 and "secret" not in str(err)

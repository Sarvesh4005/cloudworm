import base64
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "site"))


@pytest.fixture
def site(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>CloudWorm</title>")
    (dist / "assets" / "index-abc123.js").write_text("console.log('hi')")
    (dist / "assets" / "index-abc123.css").write_text("body{}")
    (dist / "favicon.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("do not serve")
    monkeypatch.setenv("SITE_DIST_DIR", str(dist))
    monkeypatch.setenv("FILES_BUCKET_HOST", "cloudworm-files-123.s3.ap-south-1.amazonaws.com")
    import cloudworm_site

    module = importlib.reload(cloudworm_site)
    module._read.cache_clear()
    return module


def get(site, path):
    resp = site.handler({"rawPath": path})
    body = base64.b64decode(resp["body"]) if resp.get("isBase64Encoded") else resp["body"].encode()
    return resp["statusCode"], resp["headers"], body


@pytest.mark.parametrize("path", ["/", "/t/AbCdEfGhIjKlMnOpQrStUv", "/some/unknown/page"])
def test_spa_routes_serve_index(site, path):
    status, headers, body = get(site, path)
    assert status == 200
    assert body.startswith(b"<!doctype html>")
    assert headers["content-type"].startswith("text/html")
    assert headers["cache-control"] == "no-cache"


def test_assets_have_types_and_long_cache(site):
    status, headers, body = get(site, "/assets/index-abc123.js")
    assert status == 200 and body == b"console.log('hi')"
    assert headers["content-type"].startswith("text/javascript")
    assert "immutable" in headers["cache-control"]
    assert get(site, "/assets/index-abc123.css")[1]["content-type"].startswith("text/css")
    status, headers, _ = get(site, "/favicon.svg")
    assert status == 200 and headers["content-type"] == "image/svg+xml" and headers["cache-control"] == "no-cache"


def test_missing_asset_is_404_not_html(site):
    status, _, body = get(site, "/assets/missing-xyz.js")
    assert status == 404 and b"html" not in body


@pytest.mark.parametrize("path", ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "//etc/passwd"])
def test_path_traversal_never_escapes_bundle(site, path):
    status, _, body = get(site, path)
    assert b"do not serve" not in body
    assert b"root:" not in body
    assert status in (200, 404)


def test_security_headers_on_every_response(site):
    for path in ("/", "/assets/index-abc123.js", "/assets/missing.js"):
        _, headers, _ = get(site, path)
        csp = headers["content-security-policy"]
        assert "connect-src 'self' https://cloudworm-files-123.s3.ap-south-1.amazonaws.com" in csp
        assert "frame-ancestors 'none'" in csp and "script-src 'self'" in csp
        assert headers["referrer-policy"] == "no-referrer"
        assert headers["x-frame-options"] == "DENY"
        assert headers["strict-transport-security"].startswith("max-age=")


def test_missing_bundle_is_a_clear_503(tmp_path, monkeypatch):
    monkeypatch.setenv("SITE_DIST_DIR", str(tmp_path / "nothing"))
    import cloudworm_site

    module = importlib.reload(cloudworm_site)
    status, _, body = get(module, "/")
    assert status == 503 and b"bundle is missing" in body


def test_local_emulator_origin_override(site, monkeypatch):
    monkeypatch.setenv("FILES_BUCKET_ORIGIN", "http://127.0.0.1:5005")
    _, headers, _ = get(site, "/")
    assert "connect-src 'self' http://127.0.0.1:5005;" in headers["content-security-policy"]

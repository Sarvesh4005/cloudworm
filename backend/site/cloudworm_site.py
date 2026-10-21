"""Site Lambda: serves the built React app from API Gateway (SiteHosting=api).

Used when CloudFront isn't available (e.g. a new AWS account awaiting
verification). The app and API then share one HTTPS origin, so the browser
needs no CORS for API calls. Only the small static bundle (~300 KB) passes
through here; file contents still go directly between the browser and S3.

The bundle is copied into ./dist by scripts/deploy-backend.sh before `sam build`.
"""
from __future__ import annotations

import base64
import mimetypes
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

DIST = Path(os.environ.get("SITE_DIST_DIR", Path(__file__).resolve().parent / "dist"))

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


def security_headers() -> dict[str, str]:
    # FILES_BUCKET_ORIGIN (full origin) is only set by the local dev server's S3 emulator.
    bucket_host = os.environ.get("FILES_BUCKET_HOST", "")
    bucket_origin = os.environ.get("FILES_BUCKET_ORIGIN") or (f"https://{bucket_host}" if bucket_host else "")
    connect = "'self'" + (f" {bucket_origin}" if bucket_origin else "")
    return {
        "content-security-policy": (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            f"img-src 'self' data: blob:; font-src 'self'; connect-src {connect}; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        ),
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        # The transfer ID is in the path; never leak it to other sites.
        "referrer-policy": "no-referrer",
    }


@lru_cache(maxsize=64)
def _read(path: str) -> bytes:
    return Path(path).read_bytes()


def _resolve(raw_path: str) -> Path | None:
    """Map a URL path to a file inside DIST; None means 'serve the SPA shell'."""
    rel = raw_path.lstrip("/")
    if not rel or rel.endswith("/"):
        return None
    root = DIST.resolve()
    candidate = (root / rel).resolve()
    # Never serve anything outside the bundle (blocks ../ traversal and symlinks out).
    if root not in candidate.parents or not candidate.is_file():
        return None
    return candidate


def _response(status: int, body: bytes, content_type: str, cache: str) -> dict[str, Any]:
    headers = {"content-type": content_type, "cache-control": cache, **security_headers()}
    return {
        "statusCode": status,
        "headers": headers,
        "body": base64.b64encode(body).decode("ascii"),
        "isBase64Encoded": True,
    }


def handler(event: dict, context: Any = None) -> dict:
    raw_path = event.get("rawPath") or "/"
    index = DIST / "index.html"
    if not index.is_file():
        return _response(503, b"CloudWorm site bundle is missing from this deployment.",
                         "text/plain; charset=utf-8", "no-store")

    target = _resolve(raw_path)
    if target is None:
        # A path that looks like a missing asset gets a real 404 rather than HTML.
        if Path(raw_path).suffix and raw_path.startswith("/assets/"):
            return _response(404, b"Not found", "text/plain; charset=utf-8", "no-store")
        # SPA routes such as /t/<id> are rendered client-side by index.html.
        return _response(200, _read(str(index)), TYPES[".html"], "no-cache")

    suffix = target.suffix.lower()
    content_type = TYPES.get(suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    # Vite fingerprints everything under /assets/, so those are safe to cache forever.
    cache = "public, max-age=31536000, immutable" if raw_path.startswith("/assets/") else "no-cache"
    if suffix == ".html":
        cache = "no-cache"
    return _response(200, _read(str(target)), content_type, cache)

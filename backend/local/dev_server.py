"""Offline development backend for CloudWorm.

Runs the *real* Lambda handlers behind a tiny HTTP server that mimics API
Gateway (payload v2.0) and uses moto to emulate S3 and DynamoDB in memory.
No AWS account, credentials or Docker required. Data is lost on exit.

    cd backend && .venv/bin/python local/dev_server.py

Then run the frontend with VITE_API_URL=http://localhost:3001.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

API_PORT = int(os.environ.get("CLOUDWORM_API_PORT", "3001"))
MOTO_PORT = int(os.environ.get("CLOUDWORM_MOTO_PORT", "5005"))
ACCESS_CODE = os.environ.get("CLOUDWORM_LOCAL_ACCESS_CODE", "local-dev-code")  # local only, never deployed
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"}
REGION = "ap-south-1"
BUCKET = "cloudworm-local-files"
TABLE = "cloudworm-local-transfers"

os.environ.update(
    {
        "AWS_ACCESS_KEY_ID": "local",
        "AWS_SECRET_ACCESS_KEY": "local",
        "AWS_DEFAULT_REGION": REGION,
        "AWS_REGION": REGION,
        "S3_ENDPOINT_URL": f"http://127.0.0.1:{MOTO_PORT}",
        "DYNAMODB_ENDPOINT_URL": f"http://127.0.0.1:{MOTO_PORT}",
        "TABLE_NAME": TABLE,
        "BUCKET_NAME": BUCKET,
        "ACCESS_CODE_HASH": hashlib.sha256(ACCESS_CODE.encode()).hexdigest(),
    }
)

import boto3  # noqa: E402
from moto.server import ThreadedMotoServer  # noqa: E402

from cloudworm import receiver, sender  # noqa: E402

ROUTES = [(m, re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", p) + "$"), f"{m} {p}", mod) for m, p, mod in [
    ("GET", "/config", receiver),
    ("GET", "/transfers/{transferId}", receiver),
    ("POST", "/transfers/{transferId}/files/{fileIndex}/download-url", receiver),
    ("POST", "/transfers", sender),
    ("POST", "/transfers/{transferId}/files/{fileIndex}/upload-urls", sender),
    ("POST", "/transfers/{transferId}/files/{fileIndex}/complete", sender),
    ("POST", "/transfers/{transferId}/finalize", sender),
    ("DELETE", "/transfers/{transferId}", sender),
]]


def bootstrap_aws() -> None:
    endpoint = os.environ["S3_ENDPOINT_URL"]
    s3 = boto3.client("s3", region_name=REGION, endpoint_url=endpoint)
    s3.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    s3.put_bucket_cors(
        Bucket=BUCKET,
        CORSConfiguration={"CORSRules": [{
            "AllowedOrigins": sorted(ALLOWED_ORIGINS), "AllowedMethods": ["GET", "PUT"],
            "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3000,
        }]},
    )
    boto3.client("dynamodb", region_name=REGION, endpoint_url=endpoint).create_table(
        TableName=TABLE,
        KeySchema=[{"AttributeName": "transferId", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "transferId", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "CloudWormLocal/1.0"

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE")
            self.send_header("Access-Control-Allow-Headers", "content-type,x-owner-token")
            self.send_header("Access-Control-Max-Age", "600")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _handle(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else None
        for method, pattern, route_key, module in ROUTES:
            match = pattern.match(path)
            if method == self.command and match:
                event = {
                    "version": "2.0",
                    "routeKey": route_key,
                    "rawPath": path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "pathParameters": match.groupdict() or None,
                    "requestContext": {"http": {"method": method, "path": path}},
                    "body": body,
                    "isBase64Encoded": False,
                }
                result = module.handler(event)
                break
        else:
            result = {"statusCode": 404, "headers": {"content-type": "application/json"},
                      "body": json.dumps({"error": {"code": "route_not_found", "message": "Unknown API route."}})}
        payload = result["body"].encode()
        self.send_response(result["statusCode"])
        for k, v in result.get("headers", {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_DELETE = _handle  # noqa: N815

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[api] {self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}\n")


def ports_free() -> bool:
    import socket

    for port in (API_PORT, MOTO_PORT):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                print(f"Port {port} is already in use - is another CloudWorm backend running?", file=sys.stderr)
                print("Stop it with:  pkill -f backend/local/dev_server.py", file=sys.stderr)
                return False
    return True


def main() -> None:
    if not ports_free():
        sys.exit(1)
    moto = ThreadedMotoServer(ip_address="127.0.0.1", port=MOTO_PORT, verbose=False)
    moto.start()
    bootstrap_aws()
    httpd = ThreadingHTTPServer(("127.0.0.1", API_PORT), ApiHandler)
    print(f"CloudWorm local API  : http://localhost:{API_PORT}")
    print(f"Emulated S3/DynamoDB : http://localhost:{MOTO_PORT} (moto, in-memory)")
    print(f"Upload access code   : {ACCESS_CODE}   (local only)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        moto.stop()


if __name__ == "__main__":
    main()

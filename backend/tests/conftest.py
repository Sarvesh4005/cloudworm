from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cloudworm import core  # noqa: E402

ACCESS_CODE = "correct-horse-battery-staple"
REGION = "ap-south-1"
TABLE = "test-transfers"
BUCKET = "test-cloudworm-files"


def enc_name(label: str = "file") -> str:
    """A stand-in for the browser's base64url(iv || ciphertext) blob."""
    return base64.urlsafe_b64encode(f"{label}-encrypted-name-blob".encode()).decode().rstrip("=")


@pytest.fixture(autouse=True)
def aws(monkeypatch):
    env = {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_SESSION_TOKEN": "testing",
        "AWS_DEFAULT_REGION": REGION,
        "AWS_REGION": REGION,
        "TABLE_NAME": TABLE,
        "BUCKET_NAME": BUCKET,
        "ACCESS_CODE_HASH": hashlib.sha256(ACCESS_CODE.encode()).hexdigest(),
        "MAX_FILES": "5",
        "MAX_FILE_BYTES": str(40 * 1024 * 1024),
        "MAX_TRANSFER_BYTES": str(60 * 1024 * 1024),
        "EXPIRY_HOURS_OPTIONS": "1,24,168",
        "DEFAULT_EXPIRY_HOURS": "24",
        "ALLOWED_EXTENSIONS": "",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("S3_ENDPOINT_URL", raising=False)
    monkeypatch.delenv("DYNAMODB_ENDPOINT_URL", raising=False)
    with mock_aws():
        ddb = boto3.client("dynamodb", region_name=REGION)
        ddb.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "transferId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "transferId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        boto3.client("s3", region_name=REGION).create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION}
        )
        core.reset_services()
        yield
        core.reset_services()


@pytest.fixture
def s3():
    return boto3.client("s3", region_name=REGION)


@pytest.fixture
def clock(monkeypatch):
    """Controllable clock for expiry tests."""

    class Clock:
        def __init__(self):
            import time

            self.value = int(time.time())

        def advance(self, seconds: int):
            self.value += seconds

    c = Clock()
    monkeypatch.setattr(core, "now", lambda: c.value)
    return c


def event(route_key: str, path_params: dict | None = None, body: dict | None = None, headers: dict | None = None):
    method, path = route_key.split(" ", 1)
    for k, v in (path_params or {}).items():
        path = path.replace("{" + k + "}", str(v))
    return {
        "version": "2.0",
        "routeKey": route_key,
        "rawPath": path,
        "headers": {k.lower(): v for k, v in (headers or {}).items()},
        "pathParameters": {k: str(v) for k, v in (path_params or {}).items()} or None,
        "requestContext": {"http": {"method": method, "path": path}},
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


def parse(resp: dict) -> tuple[int, dict]:
    return resp["statusCode"], json.loads(resp["body"])

"""Shared AWS clients, validation and transfer persistence helpers."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from typing import Any

import boto3
from botocore.config import Config

from .config import Settings
from .http import ApiError, header, path_param

TRANSFER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")      # secrets.token_urlsafe(16)
OWNER_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")      # secrets.token_urlsafe(32)
ENC_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{24,2048}$")    # base64url(iv || ciphertext)
EXTENSION_RE = re.compile(r"^[a-z0-9]{1,16}$")
OWNER_HEADER = "x-owner-token"

STATUS_UPLOADING = "uploading"
STATUS_READY = "ready"
STATUS_DELETED = "deleted"
STATUS_FAILED = "failed"


# --- Clients -----------------------------------------------------------------
class Services:
    def __init__(self, settings: Settings):
        self.settings = settings
        s3_endpoint = settings.s3_endpoint_url or f"https://s3.{settings.region}.amazonaws.com"
        self.s3 = boto3.client(
            "s3",
            region_name=settings.region,
            endpoint_url=s3_endpoint,
            config=Config(
                signature_version="s3v4",
                # Regional virtual-hosted URLs avoid the 307 redirect (which breaks
                # CORS) that the global endpoint returns for newly created buckets.
                s3={"addressing_style": "path" if settings.s3_endpoint_url else "virtual"},
                retries={"max_attempts": 3, "mode": "standard"},
            ),
        )
        dynamodb = boto3.resource(
            "dynamodb", region_name=settings.region, endpoint_url=settings.dynamodb_endpoint_url
        )
        self.table = dynamodb.Table(settings.table_name)


_services: Services | None = None


def services() -> Services:
    """Lazily build clients once per Lambda container (reused across invocations)."""
    global _services
    if _services is None:
        _services = Services(Settings.from_env())
    return _services


def reset_services() -> None:
    """Used by tests and the local dev server after changing environment variables."""
    global _services
    _services = None


# --- Small utilities -------------------------------------------------------
def now() -> int:
    return int(time.time())


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_transfer_id() -> str:
    return secrets.token_urlsafe(16)  # 128 bits from the OS CSPRNG


def new_owner_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits


def object_key(transfer_id: str, index: int) -> str:
    return f"transfers/{transfer_id}/{index}"


def to_int(value: Any) -> int:
    """DynamoDB returns Decimals; normalise to int."""
    return int(value)


# --- Validation ------------------------------------------------------------
def require_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError(400, "invalid_request", f"'{field}' must be an integer.")
    if value < minimum or value > maximum:
        raise ApiError(400, "invalid_request", f"'{field}' must be between {minimum} and {maximum}.")
    return value


def transfer_id_from(event: dict) -> str:
    transfer_id = path_param(event, "transferId")
    if not TRANSFER_ID_RE.match(transfer_id):
        raise ApiError(400, "invalid_transfer_id", "That transfer link is not valid.")
    return transfer_id


def file_index_from(event: dict) -> int:
    raw = path_param(event, "fileIndex")
    if not raw.isdigit() or len(raw) > 4:
        raise ApiError(400, "invalid_file_index", "Invalid file index.")
    return int(raw)


def check_access_code(settings: Settings, supplied: Any) -> None:
    if not settings.access_code_hash:
        # Fail closed: never allow anonymous uploads because of a missing setting.
        raise ApiError(503, "uploads_disabled", "Uploads are not configured on this server.")
    if not isinstance(supplied, str) or not supplied or len(supplied) > 256:
        raise ApiError(401, "invalid_access_code", "The upload access code is incorrect.")
    if not hmac.compare_digest(sha256_hex(supplied), settings.access_code_hash):
        raise ApiError(401, "invalid_access_code", "The upload access code is incorrect.")


# --- Persistence -----------------------------------------------------------
def load_transfer(transfer_id: str) -> dict:
    item = services().table.get_item(Key={"transferId": transfer_id}, ConsistentRead=True).get("Item")
    if not item:
        raise ApiError(404, "transfer_not_found", "This transfer does not exist. Check the link and try again.")
    return item


def is_expired(item: dict) -> bool:
    return now() >= to_int(item["expiresAt"])


def ensure_available(item: dict) -> None:
    """Raise the right client-facing error if a transfer can't be used any more."""
    status = item.get("status")
    if status == STATUS_DELETED:
        raise ApiError(410, "transfer_deleted", "The sender deleted this transfer.")
    if status == STATUS_FAILED:
        raise ApiError(410, "transfer_failed", "This transfer failed to upload.")
    if is_expired(item):
        raise ApiError(410, "transfer_expired", "This transfer has expired.")


def require_owner(event: dict, item: dict) -> None:
    token = header(event, OWNER_HEADER)
    expected = item.get("ownerTokenHash", "")
    if not OWNER_TOKEN_RE.match(token or "") or not hmac.compare_digest(sha256_hex(token), expected):
        raise ApiError(403, "forbidden", "You are not allowed to modify this transfer.")


def get_file(item: dict, index: int) -> dict:
    files = item.get("files", [])
    if index >= len(files):
        raise ApiError(404, "file_not_found", "That file is not part of this transfer.")
    return files[index]


def public_view(item: dict) -> dict:
    return {
        "transferId": item["transferId"],
        "status": item["status"],
        "createdAt": to_int(item["createdAt"]),
        "expiresAt": to_int(item["expiresAt"]),
        "totalDownloads": to_int(item.get("totalDownloads", 0)),
        "files": [
            {
                "index": to_int(f["index"]),
                "encName": f["encName"],
                "size": to_int(f["size"]),
                "ciphertextSize": to_int(f["ctSize"]),
                "partCount": to_int(f["partCount"]),
                "uploaded": bool(f.get("uploaded")),
                "downloadCount": to_int(f.get("downloadCount", 0)),
            }
            for f in item.get("files", [])
        ],
    }

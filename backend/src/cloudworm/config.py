"""Runtime configuration, read from Lambda environment variables.

Every value has a safe default so unit tests and the local dev server work
without extra setup. Real deployments set these through template.yaml.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

# --- Protocol constants (must match frontend/src/lib/crypto.ts) -------------
# Plaintext bytes per encrypted chunk. One encrypted chunk == one multipart part,
# so this must stay >= 5 MiB (the S3 minimum part size).
CHUNK_BYTES = 8 * 1024 * 1024
# AES-GCM authentication tag appended to every chunk.
GCM_TAG_BYTES = 16
# S3 hard limit on parts per multipart upload.
MAX_PARTS = 10_000


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def _int_list(name: str, default: list[int]) -> list[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return sorted({int(x) for x in raw.split(",") if x.strip()})


def _str_list(name: str) -> list[str]:
    raw = os.environ.get(name, "").strip().lower()
    return sorted({x.strip().lstrip(".") for x in raw.split(",") if x.strip()})


@dataclass(frozen=True)
class Settings:
    table_name: str
    bucket_name: str
    region: str
    access_code_hash: str
    max_files: int
    max_file_bytes: int
    max_transfer_bytes: int
    expiry_hours_options: list[int]
    default_expiry_hours: int
    allowed_extensions: list[str] = field(default_factory=list)
    upload_url_ttl: int = 900
    download_url_ttl: int = 300
    max_urls_per_request: int = 50
    cleanup_grace_seconds: int = 86_400
    s3_endpoint_url: str | None = None
    dynamodb_endpoint_url: str | None = None

    @staticmethod
    def from_env() -> "Settings":
        expiry = _int_list("EXPIRY_HOURS_OPTIONS", [1, 24, 72, 168])
        default_expiry = _int("DEFAULT_EXPIRY_HOURS", 24)
        if default_expiry not in expiry:
            default_expiry = expiry[0]
        return Settings(
            table_name=os.environ.get("TABLE_NAME", "cloudworm-transfers"),
            bucket_name=os.environ.get("BUCKET_NAME", "cloudworm-files"),
            region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "ap-south-1")),
            access_code_hash=os.environ.get("ACCESS_CODE_HASH", "").strip().lower(),
            max_files=_int("MAX_FILES", 50),
            max_file_bytes=_int("MAX_FILE_BYTES", 2 * 1024**3),
            max_transfer_bytes=_int("MAX_TRANSFER_BYTES", 5 * 1024**3),
            expiry_hours_options=expiry,
            default_expiry_hours=default_expiry,
            allowed_extensions=_str_list("ALLOWED_EXTENSIONS"),
            upload_url_ttl=_int("UPLOAD_URL_TTL_SECONDS", 900),
            download_url_ttl=_int("DOWNLOAD_URL_TTL_SECONDS", 300),
            s3_endpoint_url=os.environ.get("S3_ENDPOINT_URL") or None,
            dynamodb_endpoint_url=os.environ.get("DYNAMODB_ENDPOINT_URL") or None,
        )


def chunk_count(size: int) -> int:
    """Number of encrypted chunks (and therefore S3 parts) for a plaintext size."""
    return max(1, -(-size // CHUNK_BYTES))


def ciphertext_size(size: int) -> int:
    return size + GCM_TAG_BYTES * chunk_count(size)


def encrypted_part_size(size: int, part_number: int) -> int:
    """Exact byte length of encrypted part `part_number` (1-based)."""
    parts = chunk_count(size)
    if part_number < parts:
        return CHUNK_BYTES + GCM_TAG_BYTES
    return size - CHUNK_BYTES * (parts - 1) + GCM_TAG_BYTES

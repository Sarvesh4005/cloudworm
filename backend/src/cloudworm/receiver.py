"""Receiver Lambda: public config, transfer metadata and download URLs.

Least privilege (see template.yaml): s3:GetObject on transfers/* and DynamoDB
GetItem/UpdateItem. It cannot write or delete objects.
"""
from __future__ import annotations

from typing import Any

from . import core
from .config import CHUNK_BYTES, GCM_TAG_BYTES
from .core import STATUS_READY, ApiError, services
from .http import dispatch, logger, response


def get_config(event: dict) -> dict:
    s = services().settings
    return response(
        200,
        {
            "maxFiles": s.max_files,
            "maxFileBytes": s.max_file_bytes,
            "maxTransferBytes": s.max_transfer_bytes,
            "expiryHoursOptions": s.expiry_hours_options,
            "defaultExpiryHours": s.default_expiry_hours,
            "allowedExtensions": s.allowed_extensions,
            "chunkBytes": CHUNK_BYTES,
            "tagBytes": GCM_TAG_BYTES,
            "uploadsEnabled": bool(s.access_code_hash),
        },
    )


def get_transfer(event: dict) -> dict:
    item = core.load_transfer(core.transfer_id_from(event))
    core.ensure_available(item)
    return response(200, core.public_view(item))


def download_url(event: dict) -> dict:
    svc = services()
    settings = svc.settings
    transfer_id = core.transfer_id_from(event)
    index = core.file_index_from(event)

    item = core.load_transfer(transfer_id)
    core.ensure_available(item)
    if item["status"] != STATUS_READY:
        raise ApiError(409, "transfer_not_ready", "This transfer is still uploading. Try again shortly.")
    core.get_file(item, index)

    # Atomic re-check: status and expiry are evaluated by DynamoDB at write time,
    # so a URL is never issued for a transfer that expired or was deleted between
    # the read above and this update.
    current = core.now()
    try:
        svc.table.update_item(
            Key={"transferId": transfer_id},
            UpdateExpression=(
                f"SET files[{index}].downloadCount = files[{index}].downloadCount + :one, "
                "totalDownloads = totalDownloads + :one"
            ),
            ConditionExpression="#s = :ready AND expiresAt > :now",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":one": 1, ":ready": STATUS_READY, ":now": current},
        )
    except svc.table.meta.client.exceptions.ConditionalCheckFailedException as exc:
        raise ApiError(410, "transfer_expired", "This transfer is no longer available.") from exc

    ttl = max(1, min(settings.download_url_ttl, core.to_int(item["expiresAt"]) - current))
    url = svc.s3.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.bucket_name,
            "Key": core.object_key(transfer_id, index),
            "ResponseCacheControl": "no-store",
        },
        ExpiresIn=ttl,
    )
    logger.info("download_url id=%s index=%d", transfer_id, index)
    return response(200, {"url": url, "expiresIn": ttl})


ROUTES = {
    "GET /config": get_config,
    "GET /transfers/{transferId}": get_transfer,
    "POST /transfers/{transferId}/files/{fileIndex}/download-url": download_url,
}


def handler(event: dict, context: Any = None) -> dict:
    return dispatch(event, ROUTES)

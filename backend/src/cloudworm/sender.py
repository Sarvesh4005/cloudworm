"""Sender Lambda: create transfers, presign uploads, verify, finalize, delete.

Least privilege (see template.yaml): s3:PutObject / GetObject / DeleteObject /
AbortMultipartUpload on transfers/*, and DynamoDB PutItem/GetItem/UpdateItem.
"""
from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from . import core
from .config import MAX_PARTS, chunk_count, ciphertext_size, encrypted_part_size
from .core import (
    STATUS_DELETED,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_UPLOADING,
    ApiError,
    services,
)
from .http import dispatch, json_body, logger, response


def _validate_files(raw_files: Any) -> list[dict]:
    settings = services().settings
    if not isinstance(raw_files, list) or not raw_files:
        raise ApiError(400, "invalid_request", "Add at least one file.")
    if len(raw_files) > settings.max_files:
        raise ApiError(400, "too_many_files", f"A transfer can contain at most {settings.max_files} files.")

    files: list[dict] = []
    total = 0
    for index, raw in enumerate(raw_files):
        if not isinstance(raw, dict):
            raise ApiError(400, "invalid_request", "Each file must be an object.")
        size = core.require_int(raw.get("size"), "size", 0, 10**15)
        if size > settings.max_file_bytes:
            raise ApiError(
                413, "file_too_large", f"File {index + 1} exceeds the {settings.max_file_bytes} byte limit."
            )
        enc_name = raw.get("encName")
        if not isinstance(enc_name, str) or not core.ENC_NAME_RE.match(enc_name):
            raise ApiError(400, "invalid_request", "Each file needs an encrypted name.")
        entry: dict[str, Any] = {
            "index": index,
            "encName": enc_name,
            "size": size,
            "ctSize": ciphertext_size(size),
            "partCount": chunk_count(size),
            "uploaded": False,
            "downloadCount": 0,
        }
        if entry["partCount"] > MAX_PARTS:
            raise ApiError(413, "file_too_large", "File is too large to upload.")
        if settings.allowed_extensions:
            # With E2E encryption the server cannot inspect content; the extension is
            # declared by the client and checked against the allowlist.
            ext = raw.get("ext")
            if not isinstance(ext, str) or not core.EXTENSION_RE.match(ext.lower()):
                raise ApiError(400, "file_type_not_allowed", f"File {index + 1} has no allowed file extension.")
            ext = ext.lower()
            if ext not in settings.allowed_extensions:
                raise ApiError(400, "file_type_not_allowed", f"'.{ext}' files are not allowed.")
            entry["ext"] = ext
        total += size
        files.append(entry)

    if total > settings.max_transfer_bytes:
        raise ApiError(413, "transfer_too_large", f"Transfers are limited to {settings.max_transfer_bytes} bytes.")
    return files


def create_transfer(event: dict) -> dict:
    svc = services()
    settings = svc.settings
    body = json_body(event)
    core.check_access_code(settings, body.get("accessCode"))

    hours = body.get("expiresInHours", settings.default_expiry_hours)
    if isinstance(hours, bool) or hours not in settings.expiry_hours_options:
        raise ApiError(400, "invalid_expiry", "Choose one of the allowed expiry options.")
    files = _validate_files(body.get("files"))

    transfer_id = core.new_transfer_id()
    owner_token = core.new_owner_token()
    created = core.now()
    expires = created + hours * 3600

    started_uploads: list[tuple[str, str]] = []
    try:
        for f in files:
            if f["partCount"] > 1:
                key = core.object_key(transfer_id, f["index"])
                upload = svc.s3.create_multipart_upload(Bucket=settings.bucket_name, Key=key)
                f["uploadId"] = upload["UploadId"]
                started_uploads.append((key, upload["UploadId"]))

        svc.table.put_item(
            Item={
                "transferId": transfer_id,
                "status": STATUS_UPLOADING,
                "createdAt": created,
                "expiresAt": expires,
                # DynamoDB TTL is *cleanup only*; expiry is enforced in code.
                "ttl": expires + settings.cleanup_grace_seconds,
                "ownerTokenHash": core.sha256_hex(owner_token),
                "totalDownloads": 0,
                "files": files,
            },
            ConditionExpression="attribute_not_exists(transferId)",
        )
    except Exception:
        for key, upload_id in started_uploads:
            try:
                svc.s3.abort_multipart_upload(Bucket=settings.bucket_name, Key=key, UploadId=upload_id)
            except ClientError:
                logger.warning("abort_failed key=%s", key)
        raise

    logger.info("transfer_created id=%s files=%d expires=%d", transfer_id, len(files), expires)
    return response(
        201,
        {
            "transferId": transfer_id,
            "ownerToken": owner_token,
            "expiresAt": expires,
            "files": [{"index": f["index"], "partCount": f["partCount"]} for f in files],
        },
    )


def _load_for_upload(event: dict) -> tuple[dict, int, dict]:
    transfer_id = core.transfer_id_from(event)
    index = core.file_index_from(event)
    item = core.load_transfer(transfer_id)
    core.require_owner(event, item)
    core.ensure_available(item)
    if item["status"] != STATUS_UPLOADING:
        raise ApiError(409, "not_uploading", "This transfer is no longer accepting uploads.")
    f = core.get_file(item, index)
    if f.get("uploaded"):
        raise ApiError(409, "already_uploaded", "This file has already been uploaded.")
    return item, index, f


def upload_urls(event: dict) -> dict:
    svc = services()
    settings = svc.settings
    item, index, f = _load_for_upload(event)
    body = json_body(event)
    part_count = core.to_int(f["partCount"])
    size = core.to_int(f["size"])

    numbers = body.get("partNumbers")
    if not isinstance(numbers, list) or not numbers or len(numbers) > settings.max_urls_per_request:
        raise ApiError(
            400, "invalid_request", f"'partNumbers' must list 1-{settings.max_urls_per_request} part numbers."
        )
    if len(set(numbers)) != len(numbers):
        raise ApiError(400, "invalid_request", "'partNumbers' must be unique.")
    for n in numbers:
        core.require_int(n, "partNumber", 1, part_count)

    key = core.object_key(item["transferId"], index)
    # Never let an upload URL outlive the transfer itself.
    ttl = max(1, min(settings.upload_url_ttl, core.to_int(item["expiresAt"]) - core.now()))
    urls = []
    for n in numbers:
        if part_count == 1:
            params = {"Bucket": settings.bucket_name, "Key": key, "ContentLength": core.to_int(f["ctSize"])}
            url = svc.s3.generate_presigned_url("put_object", Params=params, ExpiresIn=ttl)
        else:
            params = {
                "Bucket": settings.bucket_name,
                "Key": key,
                "UploadId": f["uploadId"],
                "PartNumber": n,
                "ContentLength": encrypted_part_size(size, n),
            }
            url = svc.s3.generate_presigned_url("upload_part", Params=params, ExpiresIn=ttl)
        urls.append({"partNumber": n, "url": url})
    return response(200, {"urls": urls, "expiresIn": ttl})


def _mark_failed(item: dict, key: str) -> None:
    svc = services()
    try:
        svc.s3.delete_object(Bucket=svc.settings.bucket_name, Key=key)
    finally:
        svc.table.update_item(
            Key={"transferId": item["transferId"]},
            UpdateExpression="SET #s = :failed",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":failed": STATUS_FAILED},
        )


def complete_file(event: dict) -> dict:
    svc = services()
    settings = svc.settings
    item, index, f = _load_for_upload(event)
    key = core.object_key(item["transferId"], index)
    part_count = core.to_int(f["partCount"])

    if part_count > 1:
        parts = json_body(event).get("parts")
        if not isinstance(parts, list) or len(parts) != part_count:
            raise ApiError(400, "upload_incomplete", "All parts must be uploaded before completing.")
        clean = []
        for expected, p in enumerate(parts, start=1):
            if not isinstance(p, dict) or p.get("partNumber") != expected:
                raise ApiError(400, "invalid_request", "Parts must be listed in order.")
            etag = p.get("etag")
            if not isinstance(etag, str) or not 0 < len(etag) <= 128:
                raise ApiError(400, "invalid_request", "Each part needs its ETag.")
            clean.append({"PartNumber": expected, "ETag": etag})
        try:
            svc.s3.complete_multipart_upload(
                Bucket=settings.bucket_name,
                Key=key,
                UploadId=f["uploadId"],
                MultipartUpload={"Parts": clean},
            )
        except ClientError as exc:
            logger.info("complete_failed id=%s code=%s", item["transferId"], exc.response["Error"]["Code"])
            raise ApiError(400, "upload_incomplete", "S3 rejected the uploaded parts. Please retry.") from exc

    # Server-side verification: the stored object must be exactly the expected size.
    try:
        head = svc.s3.head_object(Bucket=settings.bucket_name, Key=key)
    except ClientError as exc:
        raise ApiError(400, "upload_incomplete", "The file was not uploaded.") from exc
    if head["ContentLength"] != core.to_int(f["ctSize"]):
        logger.warning("size_mismatch id=%s index=%d", item["transferId"], index)
        _mark_failed(item, key)
        raise ApiError(422, "size_mismatch", "The uploaded file did not match its declared size.")

    svc.table.update_item(
        Key={"transferId": item["transferId"]},
        UpdateExpression=f"SET files[{index}].uploaded = :t REMOVE files[{index}].uploadId",
        ConditionExpression="#s = :uploading",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":t": True, ":uploading": STATUS_UPLOADING},
    )
    return response(200, {"index": index, "uploaded": True})


def finalize(event: dict) -> dict:
    svc = services()
    transfer_id = core.transfer_id_from(event)
    item = core.load_transfer(transfer_id)
    core.require_owner(event, item)
    core.ensure_available(item)
    if item["status"] == STATUS_READY:
        return response(200, core.public_view(item))
    if not all(f.get("uploaded") for f in item["files"]):
        raise ApiError(409, "upload_incomplete", "Some files have not finished uploading.")
    try:
        result = svc.table.update_item(
            Key={"transferId": transfer_id},
            UpdateExpression="SET #s = :ready",
            ConditionExpression="#s = :uploading AND expiresAt > :now",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":ready": STATUS_READY, ":uploading": STATUS_UPLOADING, ":now": core.now()},
            ReturnValues="ALL_NEW",
        )
    except svc.table.meta.client.exceptions.ConditionalCheckFailedException as exc:
        raise ApiError(409, "not_uploading", "This transfer can no longer be finalized.") from exc
    logger.info("transfer_ready id=%s", transfer_id)
    return response(200, core.public_view(result["Attributes"]))


def delete_transfer(event: dict) -> dict:
    """Immediate revocation by the sender: deletes objects, then marks the record."""
    svc = services()
    settings = svc.settings
    transfer_id = core.transfer_id_from(event)
    item = core.load_transfer(transfer_id)
    core.require_owner(event, item)
    if item["status"] == STATUS_DELETED:
        return response(200, {"transferId": transfer_id, "status": STATUS_DELETED})

    # Mark deleted first so no new download URLs can be issued while we clean up.
    svc.table.update_item(
        Key={"transferId": transfer_id},
        UpdateExpression="SET #s = :deleted",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":deleted": STATUS_DELETED},
    )
    keys = []
    for f in item["files"]:
        key = core.object_key(transfer_id, core.to_int(f["index"]))
        keys.append({"Key": key})
        if f.get("uploadId"):
            try:
                svc.s3.abort_multipart_upload(Bucket=settings.bucket_name, Key=key, UploadId=f["uploadId"])
            except ClientError:
                pass  # already completed/aborted
    for start in range(0, len(keys), 1000):
        svc.s3.delete_objects(
            Bucket=settings.bucket_name, Delete={"Objects": keys[start : start + 1000], "Quiet": True}
        )
    logger.info("transfer_deleted id=%s", transfer_id)
    return response(200, {"transferId": transfer_id, "status": STATUS_DELETED})


ROUTES = {
    "POST /transfers": create_transfer,
    "POST /transfers/{transferId}/files/{fileIndex}/upload-urls": upload_urls,
    "POST /transfers/{transferId}/files/{fileIndex}/complete": complete_file,
    "POST /transfers/{transferId}/finalize": finalize,
    "DELETE /transfers/{transferId}": delete_transfer,
}


def handler(event: dict, context: Any = None) -> dict:
    return dispatch(event, ROUTES)

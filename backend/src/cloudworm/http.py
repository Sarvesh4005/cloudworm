"""Tiny helpers for API Gateway HTTP API (payload format 2.0) events."""
from __future__ import annotations

import base64
import json
import logging
from typing import Any, Callable

logger = logging.getLogger("cloudworm")
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 256 * 1024


class ApiError(Exception):
    """An error that is safe to show to the client."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def response(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def error_response(err: ApiError) -> dict:
    return response(err.status, {"error": {"code": err.code, "message": err.message}})


def json_body(event: dict) -> dict:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise ApiError(400, "invalid_body", "Request body is not valid UTF-8.") from exc
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError(413, "body_too_large", "Request body is too large.")
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(400, "invalid_json", "Request body must be valid JSON.") from exc
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_json", "Request body must be a JSON object.")
    return data


def header(event: dict, name: str) -> str:
    headers = event.get("headers") or {}
    # HTTP API lower-cases header names; be defensive anyway.
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value or ""
    return ""


def path_param(event: dict, name: str) -> str:
    return (event.get("pathParameters") or {}).get(name, "")


Handler = Callable[[dict], dict]


def dispatch(event: dict, routes: dict[str, Handler]) -> dict:
    route_key = event.get("routeKey", "")
    fn = routes.get(route_key)
    try:
        if fn is None:
            raise ApiError(404, "route_not_found", "Unknown API route.")
        return fn(event)
    except ApiError as err:
        logger.info("api_error route=%s code=%s status=%s", route_key, err.code, err.status)
        return error_response(err)
    except Exception:  # noqa: BLE001 - never leak internals to the client
        logger.exception("unhandled_error route=%s", route_key)
        return error_response(ApiError(500, "internal_error", "Something went wrong. Please try again."))

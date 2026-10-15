#!/usr/bin/env bash
# Runs the offline backend (moto-emulated S3 + DynamoDB, real Lambda handlers).
set -euo pipefail
cd "$(dirname "$0")/../backend"
exec .venv/bin/python local/dev_server.py

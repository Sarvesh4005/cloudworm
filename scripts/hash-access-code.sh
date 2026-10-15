#!/usr/bin/env bash
# Prints the SHA-256 (hex) of an upload access code without echoing the code.
# Usage: scripts/hash-access-code.sh            (prompts)
#        CLOUDWORM_ACCESS_CODE=... scripts/hash-access-code.sh
set -euo pipefail
code="${CLOUDWORM_ACCESS_CODE:-}"
if [[ -z "$code" ]]; then
  read -r -s -p "Upload access code: " code; echo >&2
fi
[[ ${#code} -ge 12 ]] || { echo "Use at least 12 characters (try: openssl rand -base64 18)" >&2; exit 1; }
printf '%s' "$code" | shasum -a 256 | cut -d' ' -f1

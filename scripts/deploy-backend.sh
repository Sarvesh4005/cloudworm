#!/usr/bin/env bash
# Builds and deploys the CloudWorm SAM stack (S3, DynamoDB, Lambda, API, CloudFront).
# Optional env vars:
#   STACK_NAME (default cloudworm)   AWS_REGION (default ap-south-1)
#   DEV_ORIGIN   e.g. http://localhost:5173 to let a local frontend call the deployed API
#   BUDGET_EMAIL address for AWS Budget alerts   BUDGET_USD (default 5)
#   ALLOWED_EXTENSIONS e.g. "pdf,png,zip" (empty = all)
#   SITE_HOSTING  cloudfront (default) | api | none
#                 api  = the HTTP API serves the app itself (no CloudFront needed, e.g. while
#                        a new account awaits CloudFront verification); built automatically
#                 none = frontend runs locally only (requires DEV_ORIGIN)
set -euo pipefail
cd "$(dirname "$0")/.."
STACK_NAME="${STACK_NAME:-cloudworm}"
REGION="${AWS_REGION:-ap-south-1}"

hash="$(scripts/hash-access-code.sh)"

# SAM rejects empty "Key=" overrides, so only pass settings that have a value;
# everything else falls back to the template defaults.
overrides=("UploadAccessCodeHash=$hash" "MonthlyBudgetUsd=${BUDGET_USD:-5}")
[[ -n "${DEV_ORIGIN:-}" ]] && overrides+=("DevAllowedOrigin=$DEV_ORIGIN")
[[ -n "${BUDGET_EMAIL:-}" ]] && overrides+=("BudgetAlertEmail=$BUDGET_EMAIL")
[[ -n "${ALLOWED_EXTENSIONS:-}" ]] && overrides+=("AllowedExtensions=$ALLOWED_EXTENSIONS")
SITE_HOSTING="${SITE_HOSTING:-cloudfront}"
case "$SITE_HOSTING" in cloudfront|api|none) ;; *) echo "SITE_HOSTING must be cloudfront, api or none" >&2; exit 1;; esac
overrides+=("SiteHosting=$SITE_HOSTING")

# SiteHosting=api: bundle the frontend into the site Lambda (calls its own origin).
rm -rf backend/site/dist
if [[ "$SITE_HOSTING" == "api" ]]; then
  [[ -d frontend/node_modules ]] || npm --prefix frontend ci
  VITE_API_URL=same-origin npm --prefix frontend run build
  cp -R frontend/dist backend/site/dist
  echo "Bundled frontend into backend/site/dist ($(du -sh backend/site/dist | cut -f1))"
fi

if command -v python3.13 >/dev/null; then
  sam build
else
  # The Lambdas have no third-party dependencies, so SAM can package the source directly.
  echo "python3.13 not found; deploying source without 'sam build' (brew install python@3.13 to enable it)." >&2
  rm -rf .aws-sam
fi

sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${overrides[@]}"

aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table

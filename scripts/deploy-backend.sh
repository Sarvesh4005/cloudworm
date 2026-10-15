#!/usr/bin/env bash
# Builds and deploys the CloudWorm SAM stack (S3, DynamoDB, Lambda, API, CloudFront).
# Optional env vars:
#   STACK_NAME (default cloudworm)   AWS_REGION (default ap-south-1)
#   DEV_ORIGIN   e.g. http://localhost:5173 to let a local frontend call the deployed API
#   BUDGET_EMAIL address for AWS Budget alerts   BUDGET_USD (default 5)
#   ALLOWED_EXTENSIONS e.g. "pdf,png,zip" (empty = all)
set -euo pipefail
cd "$(dirname "$0")/.."
STACK_NAME="${STACK_NAME:-cloudworm}"
REGION="${AWS_REGION:-ap-south-1}"

hash="$(scripts/hash-access-code.sh)"

overrides=(
  "UploadAccessCodeHash=$hash"
  "DevAllowedOrigin=${DEV_ORIGIN:-}"
  "BudgetAlertEmail=${BUDGET_EMAIL:-}"
  "MonthlyBudgetUsd=${BUDGET_USD:-5}"
  "AllowedExtensions=${ALLOWED_EXTENSIONS:-}"
)

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

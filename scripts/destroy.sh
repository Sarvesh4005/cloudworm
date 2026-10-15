#!/usr/bin/env bash
# Deletes EVERYTHING: all transfers, the website, and the stack. Irreversible.
set -euo pipefail
cd "$(dirname "$0")/.."
STACK_NAME="${STACK_NAME:-cloudworm}"
REGION="${AWS_REGION:-ap-south-1}"

read -r -p "Type the stack name ($STACK_NAME) to permanently delete it and all files: " answer
[[ "$answer" == "$STACK_NAME" ]] || { echo "Aborted."; exit 1; }

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
for key in FilesBucketName SiteBucketName; do
  bucket="$(output "$key")"
  if [[ -n "$bucket" && "$bucket" != "None" ]]; then
    echo "Emptying s3://$bucket"
    aws s3 rm "s3://$bucket" --recursive --region "$REGION"
    # Abort any unfinished multipart uploads so the bucket can be deleted.
    aws s3api list-multipart-uploads --bucket "$bucket" --region "$REGION" \
      --query 'Uploads[].[Key,UploadId]' --output text 2>/dev/null | while read -r k id; do
        [[ -n "${k:-}" && "$k" != "None" ]] && aws s3api abort-multipart-upload --bucket "$bucket" --key "$k" --upload-id "$id" --region "$REGION"
      done
  fi
done
sam delete --stack-name "$STACK_NAME" --region "$REGION" --no-prompts
echo "Stack deleted. Check the AWS Billing console over the next day to confirm charges stop."

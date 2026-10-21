#!/usr/bin/env bash
# Builds the React app against the deployed API and publishes it to S3 + CloudFront.
set -euo pipefail
cd "$(dirname "$0")/.."
STACK_NAME="${STACK_NAME:-cloudworm}"
REGION="${AWS_REGION:-ap-south-1}"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
API_URL="$(output ApiUrl)"
BUCKET="$(output SiteBucketName)"
DIST_ID="$(output DistributionId)"
SITE_URL="$(output SiteUrl)"

if [[ -z "$BUCKET" || "$BUCKET" == "None" ]]; then
  case "$(output SiteHosting)" in
    api) echo "This stack serves the app from the API itself ($SITE_URL)." >&2
         echo "To update it, rerun: SITE_HOSTING=api scripts/deploy-backend.sh" >&2 ;;
    *)   echo "This stack has no hosted site (SiteHosting=none)." >&2
         echo "Run the frontend locally: set VITE_API_URL=$API_URL in frontend/.env.local, then npm --prefix frontend run dev" >&2 ;;
  esac
  exit 1
fi

echo "VITE_API_URL=$API_URL" > frontend/.env.production
npm --prefix frontend ci
npm --prefix frontend run build

# Hashed assets can be cached forever; index.html must always be revalidated.
aws s3 sync frontend/dist "s3://$BUCKET" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable" --region "$REGION"
aws s3 cp frontend/dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8" --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/" >/dev/null

echo "Deployed: $SITE_URL"

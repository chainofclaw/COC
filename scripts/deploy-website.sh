#!/usr/bin/env bash
# Deploy coc-website to production. Preserves server .env.local and SQLite data.
# Usage: COC_WEBSITE_SSH_KEY=~/.ssh/openclaw_server_key ./scripts/deploy-website.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/website"
HOST="${COC_WEBSITE_HOST:-root@159.198.44.136}"
REMOTE="${COC_WEBSITE_REMOTE_DIR:-/root/clawd/COC/website}"
KEY="${COC_WEBSITE_SSH_KEY:-$HOME/.ssh/openclaw_server_key}"

if [[ ! -d "$WEB" ]]; then
  echo "website dir not found: $WEB" >&2
  exit 1
fi
if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY (set COC_WEBSITE_SSH_KEY)" >&2
  exit 1
fi

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)
RSYNC=(rsync -avz --delete
  --exclude node_modules
  --exclude .next
  --exclude '.env.local'
  --exclude '.env*.local'
  --exclude 'data/'
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new")

echo "==> rsync $WEB -> $HOST:$REMOTE"
"${RSYNC[@]}" "$WEB/" "$HOST:$REMOTE/"

echo "==> remote: npm ci && npm run build && pm2 restart coc-website"
"${SSH[@]}" "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /root/clawd/COC/website
npm ci
npm run build
pm2 restart coc-website
pm2 list | head -15
REMOTE

echo "==> done"

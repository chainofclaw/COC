# coc-explorer Incident Response Runbook

This runbook is for emergency isolation and secure recovery when `coc-explorer` is suspected compromised.

## 1) Emergency Isolation (keep explorer offline)

1. Run the containment script as root:
   - `COC/scripts/emergency-isolate-explorer.sh --block-ip <ioc_ip_1> --block-ip <ioc_ip_2>`
   - Or pass `--ioc-file /root/iocs.txt` with one IP/CIDR per line.
2. Confirm explorer is offline:
   - `pm2 status | grep coc-explorer` should show stopped (if PM2 path is used).
   - `systemctl status coc-explorer` should show inactive (if systemd path is used).
   - `ss -lntp | grep :3000` should return no public listener.
3. Confirm miner/downloader processes are gone:
   - `pgrep -af 'CeuzT0b|i1LT1A|RPEiZT|oHdzPs5h|xmrig|stratum|/let'` should return empty.

## 2) Apply Security Fixes

1. Deploy patched explorer app with hardened `/api/verify` controls:
   - API key gate (`COC_VERIFY_API_KEY`)
   - request size limits (`COC_VERIFY_MAX_BODY_BYTES`, `COC_VERIFY_MAX_SOURCE_CHARS`)
   - in-process rate limits (`COC_VERIFY_RATE_WINDOW_MS`, `COC_VERIFY_RATE_MAX_REQUESTS`)
2. Keep remote solc downloads disabled in production:
   - `COC_SOLC_ALLOW_REMOTE=0`
3. Reload Nginx with explorer and `/api/verify` specific limits.
4. Ensure explorer runs least-privileged:
   - systemd hardening enabled
   - Docker image runs as non-root
   - direct host exposure limited to `127.0.0.1:3000`

## 3) Verification Checklist Before Re-enable

- `npm run build` succeeds in `COC/explorer`.
- `nginx -t` succeeds before reload.
- `systemd-analyze security coc-explorer.service` improves vs baseline.
- `curl -i https://<explorer-host>/api/verify` without key returns `401`/`503`.
- `curl -i -H 'x-verify-api-key: ...' ...` with oversized body returns `413`.
- Burst requests to `/api/verify` trigger `429` with `Retry-After`.
- No IOC process respawn for at least 30 minutes after service restart.

## 4) Staged Re-enable

1. Start explorer backend only (still blocked at edge if possible).
2. Run smoke tests:
   - `/`, `/block/<id>`, `/tx/<hash>`, `/address/<addr>`, `/network`
   - controlled `/api/verify` request with valid key and small payload
3. Remove maintenance block from explorer ingress.
4. Monitor for 1 hour:
   - process tree, outbound connections, Nginx 4xx/5xx, server load.
5. If suspicious activity reappears, stop explorer and re-run containment immediately.

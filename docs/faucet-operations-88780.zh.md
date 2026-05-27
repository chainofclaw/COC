# 88780 Canary Faucet 運維

> 公開 canary faucet `https://faucet.chainofclaw.io` 的 SOP。涵蓋:
> 充值流程、餘額監控、錢包輪換、濫用響應、容量模型。

[English](./faucet-operations-88780.md)

## 概覽

| 字段 | 值 |
|---|---|
| 公開 URL | `https://faucet.chainofclaw.io` |
| 服務 | `faucet/` workspace(端口 3003 的 Node.js HTTP server) |
| 進程管理 | PM2(`coc-faucet`) |
| 默認 drip | 10 COC/請求 |
| 默認冷卻 | 24h/地址 |
| 每日全局上限 | 10 000 COC |
| Per-IP 速率限制 | 10 req/min |
| Faucet 錢包 | 專用 EOA(絕不複用 multisig signer 密鑰) |
| 資金來源 | 3-of-5 multisig(`0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E`) |

## 容量模型

默認設置下:
- 10 COC/drip × 每地址每小時最多 ~1 drip ≈ 穩定速率
- 真正瓶頸:**每日全局上限(10 000 COC = 1000 drips/天最大)**
- 健康 headroom:持有 ≥ 30 天的 drip × 每日上限 = 300 000 COC

分層餘額閾值(對應告警):

| 餘額 | 狀態 | 告警 | 動作 |
|---|---|---|---|
| ≥ 1 000 COC | 健康 | 無 | 充值 cron 處理常規 top-up |
| < 500 COC | Low | `FaucetBalanceLow` (warning) | 24h 內充值 |
| < 100 COC | Critical | `FaucetBalanceCritical` (critical) | **立即** 充值 — drip 即將失敗 |

## 餘額監控

Faucet 在 `https://faucet.chainofclaw.io/faucet/status` 暴露餘額
(JSON `{address, balance, totalDrips, …}`)。Prometheus 通過
textfile-collector cron 輪詢:

```bash
# 安裝
sudo cp scripts/faucet-balance-check.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/faucet-balance-check.sh

# Cron(root,每 5 分鐘)
sudo tee /etc/cron.d/coc-faucet-balance-check <<'EOF'
*/5 * * * * root /usr/local/bin/faucet-balance-check.sh
EOF
```

腳本將 `coc_faucet_balance_eth` + `coc_faucet_balance_check_timestamp_seconds`
寫到 `/var/lib/node_exporter/textfile_collector/coc_faucet_balance.prom`。
node_exporter 需以 `--collector.textfile.directory=/var/lib/node_exporter/textfile_collector` 跑。

獨立的 `FaucetProbeStale` 告警在 metric 30 分鐘無刷新時觸發 — 防止 cron
死了悄悄掩蓋 faucet 抽空。

手動檢查:
```bash
curl -s https://faucet.chainofclaw.io/faucet/status | jq .balance
```

## 充值流程

**觸發**:`FaucetBalanceLow` page,或低於 30 天 headroom 閾值的計劃 top-up。

**來源**:3-of-5 multisig 錢包(Treasury 合約餘額,> 10 000 COC 需治理批准,
低於則 multisig signer 可直接批准)。

### 標準充值(≤ 10 000 COC,multisig 直接)

1. 確認 faucet 地址(`COC_FAUCET_PRIVATE_KEY` 啟動時派生;啟動日誌會打;
   也可從 `/faucet/status.address` 看)。部署的 canary 地址記在
   `configs/deployed-contracts-88780.json`(待加字段)或 ops 保險庫。
2. 打開 multisig tx UI(或用 `multisig-tx submit` CLI):
   ```bash
   # 用 2 個 multisig owner 密鑰提交 + 確認普通 ETH 轉賬。
   # 替換 FAUCET_ADDRESS 和 AMOUNT_ETH。
   node contracts/scripts/multisig-submit-eth-transfer.js \
     --signers ~/.coc/keys/88780-multisig/owner-1.json,~/.coc/keys/88780-multisig/owner-2.json \
     --to $FAUCET_ADDRESS \
     --amount-eth $AMOUNT_ETH
   ```
3. 等第 3 個 signer 確認(Telegram / ops 頻道 ping)。
4. 驗證 `curl -s https://faucet.chainofclaw.io/faucet/status | jq .balance`
   在 1 個 block(~3 s)內反映新餘額。
5. 在 `docs/faucet-refill-log.md` 記錄充值(日期、金額、tx hash、批准者列表)。

### 大額充值(> 10 000 COC,治理)

≥ 10 000 COC 單次需走治理提案(防止單個被攻破 signer 三人組抽空 treasury):

1. 開 `TreasurySpend` 提案指向 faucet 地址。
2. 標準治理流程:7 天投票窗、40% quorum、60% 批准。
3. 2 天 timelock 後 multisig 執行已 queued 的提案。
4. 同標準充值驗證 + 記錄。

## 錢包輪換

按日曆觸發(每 90 天)或在任何疑似洩漏時輪換 faucet 錢包。

**程序**(抽乾並重發 faucet 錢包):

1. 生成新 EOA(`coc-wallet generate`)並把密鑰存到 ops 保險庫。**不要**
   複用任何 multisig signer 密鑰、deployer 密鑰或 validator 密鑰。
2. 在 faucet 主機的 `.env.local`(及任何備份部署)更新
   `COC_FAUCET_PRIVATE_KEY`。
3. 把 **舊** faucet 錢包餘額抽到 multisig:
   ```bash
   # 用 OLD 密鑰 — 這是它應簽的最後一個操作。
   COC_OLD_FAUCET_KEY=… node contracts/scripts/drain-eoa-to-multisig.js
   ```
4. `pm2 restart coc-faucet` — 進程接收新密鑰。
5. 通過標準充值程序給新錢包充值。
6. 更新部署 manifest 中記錄的 faucet 地址,並通報 ops 頻道。

## 濫用響應

Faucet 內建兩個濫用守衛:
- Per-IP 速率限制(10 req/min,寫死在 `faucet/src/faucet-server.ts`)
- Per-地址冷卻(24h 默認,env `COC_FAUCET_COOLDOWN_MS`)

但協作的多 IP / 多地址 sybil 抽乾仍能吃掉每日上限。檢測信號 + 響應:

| 信號 | 檢測 | 響應 |
|---|---|---|
| 不同請求者 IP 激增 | Nginx/Cloudflare 訪問日誌分析 | 收緊 Cloudflare WAF(per-ASN 速率限制,若攻擊源是區域性的則 country block) |
| Faucet 每小時 drip 激增 | `/faucet/status.totalDrips` delta | 臨時把 `COC_FAUCET_DRIP_AMOUNT` 降到 1 COC 並重啟;復原前先調查 |
| 所有 drip 都來自明顯關聯的地址 | 鏈上手動分析 | 網絡層封鎖 + 開 security issue |
| 每日全局上限早早就被打到 | `FaucetBalanceCritical`(閾值下無 drip) | 調查清楚再充值 |

**緊急停**:`pm2 stop coc-faucet` 讓 faucet 公開不可達,不抽乾錢包也不輪換密鑰。
活動攻擊期間用,給你時間決定補救方案。

## 健康檢查 + 冒煙測試

```bash
# 存活
curl -fI https://faucet.chainofclaw.io/health
# {status: ok, faucetAddress: 0x…}

# 狀態(餘額 + drip 計數)
curl -s https://faucet.chainofclaw.io/faucet/status | jq

# 冒煙測試一次 drip(一次性 — 燒 10 COC):
curl -X POST https://faucet.chainofclaw.io/faucet/request \
  -H 'Content-Type: application/json' \
  -d '{"address":"0x<your-test-address>"}'
```

成功響應:`{"txHash":"0x…","amount":"10","unit":"COC"}`。

## 未來加固備註

- **跟蹤中**:從 faucet 直接暴露 `/metrics`(消除 textfile-collector 間接)。
  超出 canary 上線範圍 — cron 腳本路徑已足以解鎖 Gate 9。
- **跟蹤中**:per-AS 濫用信號(Cloudflare WAF 規則)。打包進 Gate 8
  (Cloudflare proxy)工作。
- **跟蹤中**:refill bot 自動化 — 小 daemon,在 balance < 1000 COC 時自動
  提交 multisig tx,人工 override。延後到上線後(canary 階段偏好 human-in-the-loop 充值)。

## 另見

- [`observability-runbook-88780.zh.md`](./observability-runbook-88780.zh.md#faucetbalancelow--warning) — `FaucetBalanceLow` / `FaucetBalanceCritical` / `FaucetProbeStale` 告警 SOP
- [`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md) — multisig 密鑰丟失場景(影響充值能力)
- [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) — 權威 faucet URL
- [`canary-launch-checklist-88780.zh.md`](./canary-launch-checklist-88780.zh.md) — Gate 9 證據

# 88780 Canary 可觀測性 Runbook

> Canary 測試網每個告警的 SOP。
> [`ops/alerts/prometheus-rules.yml`](../ops/alerts/prometheus-rules.yml)
> 中每條告警都對應本文檔一節。被 page 時搜索告警名,跟隨 **首響應** 子節執行。

[English](./observability-runbook-88780.md)

## 運維快速參考

| 層 | 端點 | 默認端口 |
|---|---|---|
| Prometheus scrape (每節點) | `http://<host>:9100/metrics` | 9100 |
| Grafana | 按部署配置 | 3000 |
| Alertmanager | 按部署配置 | 9093 |

權威網絡參數見 [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md)。
6 個 active validator (v1、v2、v3、v4、v5、obs-1) — BFT quorum 需 ≥ 4 active。

## SLO 目標

每條告警服務的 canary SLO(按父 canary-readiness plan A.1.3):

| SLO | 目標 | 對應告警 |
|---|---|---|
| 出塊 p99 延遲 | < 10 s | `SlowBlockProduction` (warn @ 5% > 6 s 持續 10 m) |
| Validator 在線率 (滾動 30 天) | ≥ 99.5% | 從 `NodeDown` + Grafana 30d panel 推導 |
| Mempool 入隊 p99 | < 200 ms | 間接 — `HighMempoolBacklog` 反映背壓 |
| BFT equivocation (滾動 30 天) | 0 | `EquivocationDetected` (即時觸發,severity critical) |
| Active validator 數量 | ≥ 4 | 從 `LowPeerCount` + `coc_validators_active` panel 推導 |

## Dashboards

位於 [`docker/grafana/dashboards/`](../docker/grafana/dashboards/)。
新 Grafana 通過 "Dashboards → Import → JSON" 導入。四個 dashboard 相互補充:

| Dashboard | 何時用 |
|---|---|
| `coc-overview.json` | 頂層健康度:塊高、共識狀態、peer 數、mempool 深度。**先看這裡。** |
| `coc-consensus.json` | BFT 輪詳情:prepare/commit 投票、equivocation、validator 參與率 |
| `coc-network.json` | 拓撲:HTTP peers、wire 連接、DHT 節點、P2P auth 拒絕 |
| `coc-resources.json` | 進程資源:RSS、CPU、文件描述符、磁盤 |

---

# 告警目錄

告警按 `prometheus-rules.yml` 分組。標題嚴重度與告警 label 一致。

## 可用性組 (`coc_availability`)

### `NodeDown` — critical

**表達式**:`up{job="coc-node"} == 0` 持續 2m

**症狀**:Prometheus 已 2 分鐘無法抓取此節點的 `/metrics` 端點。可能是進程崩潰、
網絡分區、防火牆變更或 Prometheus 抓取配置漂移。

**Dashboards**:`coc-overview` → "Node up" panel;`coc-resources` → 進程 panels
(down 節點會顯示空)。

**診斷**:
1. `ssh` 到主機跑 `systemctl status coc-node@<unit>` (validator unit 為 `@88`
   或 `@1`,各主機不同 — 見 [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md))。
2. 服務在跑但 Prometheus 抓不到,檢查 `iptables -L`、主機防火牆、反代。
   metrics 端點默認綁 `127.0.0.1:9100` — Prometheus 必須直連或經 SSH tunnel。
3. `journalctl -u coc-node@<unit> -n 200` 查最近崩潰。

**首響應**:
- 若 `systemctl status` 顯示 unit 為 `failed` 或 stopped:
  `systemctl restart coc-node@<unit>`,觀察日誌 ~60s。
- 若主機完全不可達,upgrade(主機本身 down)— 但 **不要自動換 validator 密鑰**,
  除非中斷超過 1h(否則主機恢復後 BFT 用 5/6 quorum 繼續運轉,自愈)。
- 5/6 quorum BFT 繼續(T1 chaos 結果);4/6 仍出塊;≤ 3/6 stall(T3 結果)。
  並行檢查 `LowPeerCount` / `BlockProductionStalled`。

**升級**:2+ validator 同時 down 時 **不要同時重啟** — page on-call lead。
按 chaos T2:並行重啟 2 validator 觸發 2.5 分鐘 stall(雙 dead-proposer slot)。
重啟間隔 ≥ 60s。

---

### `BlockProductionStalled` — critical

**表達式**:`increase(coc_block_height[5m]) == 0` 持續 3m

**症狀**:所有 scraped 節點過去 5 分鐘無新塊。鏈失去 quorum 或所有節點本地卡死。

**Dashboards**:`coc-overview` → "Block Height" panel(看平線);`coc-consensus`
→ "BFT Phase" panel(卡 `propose` 或 `prepare` 是 giveaway)。

**診斷**:
1. 交叉檢查 `coc_block_height`。只有一個卡而其他在推進 → 單節點同步問題,
   把告警降級到該節點。
2. 全部卡同一高度,查 `coc_validators_active` — 若 < 4,BFT 無法達 quorum。
3. validator 上 curl `/coc_getBftStatus`:phase + round timer。
   `phase=propose` + round age > 60s = dead proposer slot。

**首響應**:
- **全卡,≥ 4 active**:可能 dead-proposer slot。等 H15 fallback 至 60s
  (production 600s — fast path 在 PR #641 `c4a330a`)。鏈自愈。
- **全卡,< 4 active**:BFT 在 quorum 下。按 `NodeDown` 流程恢復至少一個
  validator。不要嘗試 hard fork。
- **一節點卡,其他推進**:該節點本地卡死。`systemctl restart coc-node@<unit>`,
  讓 snap-sync 追上。

**升級**:quorum 30 分鐘內無法恢復 → 按
[`disaster-recovery-88780.zh.md` § 鏈停](./disaster-recovery-88780.zh.md)。

---

### `ConsensusStateDegraded` — warning

**表達式**:`coc_consensus_state != 0` 持續 5m

**症狀**:節點報告非健康共識狀態(1 = degraded,2 = recovering)持續 5+ 分鐘。
通常是部分網絡分區或瞬態 peer churn 的副作用。

**Dashboards**:`coc-consensus` → "Consensus State Per Node" 時間線。

**診斷**:
1. 跨節點比較 — 單節點 degraded vs 全網。
2. 受影響節點查 `coc_peers_connected`。State `1` + 低 peer 數 = 隔離。

**首響應**:
- 單節點 degraded + 低 peer:檢查節點 outbound 連接(DNS、防火牆、ISP)。
  通常 peer-list reset 解決:
  `rm /var/lib/coc/node-*/peers.json; systemctl restart …`。
  State `2`(recovering)是信息級別 — 節點正通過 snap-sync 回填,別動,
  除非超過 30 分鐘還在 state 2。

**升級**:多節點同步出現 → 可能上游事件(RPC 網關、公開 faucet —
見 [`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md))。

---

## 安全組 (`coc_security`)

### `HighAuthRejections` — warning

**表達式**:`rate(coc_p2p_auth_rejected_total[5m]) > 10` 持續 3m

**症狀**:單節點 P2P auth 拒絕率 > 10/秒持續 3+ 分鐘。可能 Sybil flood、
暴力掃描或配置錯的 peer 反復嘗試重連。

**Dashboards**:`coc-network` → "P2P Auth Rejections" panel。

**診斷**:
1. 查 `coc_p2p_auth_rejected_reason_total{reason=…}` 拆分原因:
   `bad_signature`、`unknown_signer`、`expired_nonce`、`roster_mismatch`。
   部署窗口中後兩個 = 過期 peer 緩存,benign。
2. 從節點 gossip 日誌找源 IP
   (`journalctl -u coc-node@<unit> | grep auth.*rejected`)。

**首響應**:
- 最常見:bootstrap peer 退出 validator roster(如已退役 observer),
  過期 `peers.json` 反復重試。解決:編輯 `peers.json` 刪除死 peer,
  或讓連接 backoff 自動耗盡(~10 分鐘)。
- 真實攻擊:`iptables` 臨時封鎖突發窗口;模式重複時開 security advisory。

**升級**:拒絕率持續 > 100/秒 10 分鐘 → page security-on-call。

---

### `DiscoveryIdentityFailures` — warning

**表達式**:`increase(coc_discovery_identity_failures_total[10m]) > 50` 持續 5m

**症狀**:10 分鐘內 50+ peer-discovery 身份驗證失敗。與 `HighAuthRejections`
同根因家族,但在 DNS-seed / DHT bootstrap 層。

**Dashboards**:`coc-network` → "Discovery Identity Failures" panel。

**診斷**:同 `HighAuthRejections`。驗證 seed 列表是當前的(DNS TXT 記錄),
受影響 peer 仍在預期 roster 中。

**首響應**:seed peer 退役而未更新 DNS 時更新 DNS TXT 記錄。否則按
`HighAuthRejections` 處理。

---

### `DhtVerifyFailures` — warning

**表達式**:`increase(coc_dht_verify_failures_total[10m]) > 20` 持續 5m

**症狀**:DHT 迭代查找在驗證 FIND_NODE response 的 peer 簽名時失敗。
通常是升級後的 wire-protocol 不兼容。

**Dashboards**:`coc-network` → "DHT Stats" panel。

**診斷**:確認所有節點跑同一個發布 HEAD(見
[`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) 運維日誌)。
跨版本 `verifyNodeSig` 不匹配是最常見觸發。

**首響應**:用 `scripts/deploy-rolling-safe.sh <HEAD>` 把受影響節點滾到
權威 HEAD。不要同時滾所有節點(按 chaos T2/T8 ops SOP — 錯峰重啟)。

---

### `EquivocationDetected` — critical

**表達式**:`increase(coc_bft_equivocations_total[5m]) > 0` 持續 0m

**症狀**:觀察到 validator 對同一 BFT 高度簽名了兩條衝突消息。鏈上 slash
應自動觸發,經 `EquivocationDetector`(`0xa5dcE830e917176c1091fd6112F41E47692C510e` gen-5 proxy)。

**Dashboards**:`coc-consensus` → "Equivocations Total" stat。

**診斷**(運維方 — **不要** debug 被 slash 的 validator 密鑰,當作已泄漏處理):
1. 通過健康節點的 `coc_getEquivocations` RPC 識別違反者。
2. 確認鏈上 `EquivocationProven` 事件觸發了
   (Explorer `/address/0xa5dcE830…` events tab)。
3. slash 後查 `coc_validators_active` — 若降到 4 以下(BFT quorum),
   並行跑 `BlockProductionStalled` SOP。

**首響應**:若 equivocating validator 是你的:
- **立即停節點** (`systemctl stop coc-node@<unit>`)。
- 按 [`operator-runbook.zh.md` § 3 Slash 響應](./operator-runbook.zh.md#3-slash-response)。
- **不要** 重新 stake 被 slash 的密鑰;生成新 keypair。
- 24h 內提交事後復盤。

**升級**:任何 equivocation 立即 page on-call lead。這是 canary 30 天清白記錄 Gate
(在 [`canary-launch-checklist-88780.zh.md`](./canary-launch-checklist-88780.zh.md) 為 Gate 3)
— 單次事件重置 30 天時鐘。

---

## 性能組 (`coc_performance`)

### `SlowBlockProduction` — warning

**表達式**:`coc_block_time_seconds_bucket{le="6"} / coc_block_time_seconds_count < 0.95` 持續 10m

**症狀**:超過 5% 的塊耗時 > 6s。Canary 目標 p99 < 10s — 這是早期預警信號。

**Dashboards**:`coc-overview` → "Block Time Histogram";`coc-resources`
→ CPU / disk-IO panels。

**診斷**:
1. 查 `coc_resources` dashboard 看 validator 的 CPU 飽和或 disk-IO 壓力。
2. 查 `coc-overview` mempool 深度 — 大 pending 池(> 200)會節流出塊。
3. 查 `coc_validators_active` — validator 響應慢 dead-proposer slot 拉高 p99。

**首響應**:
- CPU/disk 飽和:擴主機或換更快存儲。
- mempool backlog → `HighMempoolBacklog` SOP。
- 持續 dead-proposer slot:識別慢 validator(最低 `coc_blocks_produced_total` rate)並重啟。

---

### `HighMempoolBacklog` — warning

**表達式**:`coc_tx_pool_pending > 500` 持續 5m

**症狀**:validator 在 5+ 分鐘內持有 > 500 pending tx。Mempool per-sender quota
為 64(見 `coc-88780-2026-05-26-chaos-engineering-T1-T8.md` T6/T6b),
500+ pending 意味著真實 inbound 需求。

**Dashboards**:`coc-overview` → "Mempool Depth";`coc-consensus` → "Tx Per Block"。

**診斷**:
1. 跨節點比較 — 全部 > 500 是有機負載;單個是 relay 慢(可能 peer 問題)。
2. 查 inbound RPC 速率 `coc_rpc_requests_total` — 限制 240 req/min/IP。
   單 IP 占主導,可能是 misbehaving client。

**首響應**:
- 有機負載:提高塊 gas 上限或接受臨時 backlog;突發自動清理
  (T6 結果 — 500-tx 突發期間鏈保持 ~3s/塊)。
- 單 IP 灌爆:在 nginx/Cloudflare 層 blacklist。

---

### `HighMemoryUsage` — warning

**表達式**:`coc_process_memory_bytes > 2e9` 持續 10m

**症狀**:節點進程 RSS 超 2GB 持續 10+ 分鐘。要麼慢泄漏(罕見),
要麼長 uptime + 重 snap-sync 後的預期。

**Dashboards**:`coc-resources` → "Process Memory" panel。

**診斷**:查 `coc_node_uptime_seconds` 看 uptime。30+ 天 uptime 後 RSS > 2GB
正常;24h 內就 > 2GB 是泄漏跡象。

**首響應**:用 `scripts/deploy-rolling-safe.sh` 滾動重啟 — 錯峰 ≥ 60s
(chaos T2 SOP)。真實泄漏前先抓 heap snapshot(`kill -USR2 <pid>`),
再開 bug。

---

## 網絡組 (`coc_network`)

### `LowPeerCount` — warning

**表達式**:`coc_peers_connected < 2` 持續 5m

**症狀**:節點 HTTP gossip peer < 2。6 個 active validator + 0 observer,
健康每節點 5 個連接。

**Dashboards**:`coc-network` → "Peers Connected"。

**診斷**:
1. `cat /var/lib/coc/node-<unit>/peers.json` — 驗證 peer 列表完整。
2. 查 `coc_p2p_auth_rejected_total` — 拒絕率高 → peer 在但被拒
   (見 `HighAuthRejections`)。

**首響應**:重置 peer 緩存 + 重啟:
```bash
mv /var/lib/coc/node-<unit>/peers.json /tmp/peers.bak
systemctl restart coc-node@<unit>
```
節點通過 DNS seeds + DHT 重新發現。5 分鐘後仍 < 2,查 outbound 防火牆。

---

### `NoWireConnections` — warning

**表達式**:`coc_wire_connections == 0 and coc_peers_connected > 0` 持續 5m

**症狀**:Wire(TCP)協議零連接但 HTTP gossip peer 在。Wire 是 BFT 消息
的高吞吐傳輸 — 沒有它 BFT 跑 HTTP fallback,慢。

**Dashboards**:`coc-network` → "Wire Connections"。

**診斷**:
1. 檢查節點 env 中 `COC_ENABLE_WIRE_PROTOCOL=true`。
2. 確認 wire 端口(29790 / 29780 視主機而定)能從 peer 訪問
   (`nc -zv <peer-ip> 29790`)。
3. 查 `journalctl -u coc-node@<unit> -e | grep wire` 看 handshake 失敗。

**首響應**:配置對 + 端口開,重啟節點。重啟後所有節點 wire 仍為 0,
開 issue — 可能 wire-protocol 回歸。

---

# 有意未實現的告警(待後續)

| 信號 | 為何 defer | 跟蹤 |
|---|---|---|
| `MultisigSignerUnreachable` | 帶外(3-of-5 仍安全,1 down 可接受)— canary 上線前手動檢查 | 清單 Gate 8 |
| 出塊 p99 絕對值(vs 比率) | `SlowBlockProduction` 間接覆蓋;原生 p99 查詢更貴 | Backlog |
| Faucet 抽空 | 目前信息級;`MempoolBacklog` 捕捉症狀 | 清單 Gate 9 |
| RPC 公開端點 5xx 率 | 屬於 Cloudflare 層(尚未架起) | Gate 8 |

# 未來工作備註

- dev-stack 文件 `docker/prometheus/alerts.yml` 與 `ops/alerts/prometheus-rules.yml`
  部分重疊但 threshold 不同。權威 prod 文件是 `ops/alerts/prometheus-rules.yml` —
  未來清理時保持 dev 文件同步或廢棄。
- 每條告警加 `runbook_url` annotation 指向本文檔(Alertmanager 在 page 中渲染為鏈接)。
  超出本 PR 範圍;跟 Gate 10 polish 一起做。
- 按 chaos memory(T1–T8 結果),validator 重啟 SOP 靠運維判斷,而非自動告警強制。
  新增 `ValidatorQuorumAtRisk` 告警(`coc_validators_active < 5`)能提前阻止 —
  作為後續任務跟蹤。

# 另見

- [`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md) — 告警升級為災難場景時的處理。
- [`canary-launch-checklist-88780.zh.md`](./canary-launch-checklist-88780.zh.md) — Gate 10 證據指針。
- [`operator-runbook.zh.md`](./operator-runbook.zh.md) — 日常運維 SOP。
- [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) — 主機清單 + 端口。

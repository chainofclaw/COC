# COC Runtime (Node / Agent / Relayer)

## Start (via OpenClaw)

```bash
openclaw coc config:init
openclaw coc start
openclaw coc status
```

## Logs

```bash
openclaw coc logs node
openclaw coc logs agent
openclaw coc logs relayer
```

## Direct run (debug)

```bash
node --experimental-strip-types COC/runtime/coc-node.ts
node --experimental-strip-types COC/runtime/coc-agent.ts
node --experimental-strip-types COC/runtime/coc-relayer.ts
node --experimental-strip-types COC/runtime/coc-reward-claim.ts --epoch 123 --node-id 0x...
```

## Config

`~/.clawdbot/coc/config.json` or `COC/config.example.json`

Agent 抽样与批次参数:
- `agentBatchSize` / `COC_AGENT_BATCH_SIZE`
- `agentSampleSize` / `COC_AGENT_SAMPLE_SIZE`

私钥来源按优先级解析:
- Operator: `COC_OPERATOR_PK` -> `COC_OPERATOR_PK_FILE` -> `operatorPrivateKey` -> `operatorPrivateKeyFile`
- Slasher: `COC_SLASHER_PK` -> `COC_SLASHER_PK_FILE` -> `slasherPrivateKey` -> `slasherPrivateKeyFile`

交易重试与退避:
- `txRetryAttempts` / `COC_TX_RETRY_ATTEMPTS`
- `txRetryBaseDelayMs` / `COC_TX_RETRY_BASE_DELAY_MS`
- `txRetryMaxDelayMs` / `COC_TX_RETRY_MAX_DELAY_MS`

共享证据总线:
- 默认写入 `${dataDir}/evidence.jsonl`
- `COC_EVIDENCE_PATH` 可覆盖读写路径
- Relayer 读取共享文件时仍兼容旧文件名 `evidence-agent.jsonl` 与 `evidence-bft.jsonl`

Nonce 防重放持久化:
- `nonceRegistryPath` / `COC_NONCE_REGISTRY_PATH`（默认: `${dataDir}/nonce-registry.log`）

Reward manifest 与 v2 争议恢复:
- `rewardManifestDir`（默认: `${dataDir}/reward-manifests`）
- `pendingChallengesPath` / `COC_PENDING_CHALLENGES_PATH`（默认: `${dataDir}/pending-challenges-v2.json`）
- `challengeBondWei`

Reward proof 查询与领取:
- HTTP RPC: `coc_getRewardManifest(epochId)`、`coc_getRewardClaim(epochId, nodeId)`
- 本地 claim 脚本: `runtime/coc-reward-claim.ts`
- v2 claim 默认优先读取 `reward-epoch-<epoch>.settled.json`，无 settled manifest 时回退到原始 manifest

NodeOps 运行时接入:
- `nodeOpsPolicyPath` / `COC_NODEOPS_POLICY_PATH`
- `nodeOpsHotReload`
- `nodeOpsAllowSelfRestart`
- `nodeOpsActionDir`（默认: `${dataDir}/nodeops-actions`）

NodeOps 行为:
- 运行时通过 `coc_getNetworkStats` 探测节点健康
- 动作以 JSON 文件形式落盘到 `nodeops-actions/`
- 默认仅记录动作；`nodeOpsAllowSelfRestart=true` 时才允许自重启

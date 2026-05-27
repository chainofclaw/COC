# COC 节点运维 Runbook

COC 验证节点的运维 SOP — 注册、stake 生命周期、slash 响应、治理参与、监控、事件分诊。

本文档面向 canary testnet(`chainId 88780` — 网络参数权威见 [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md))的节点 operators。早期 Prowl testnet(`chainId 18780`)已于 2026-05-12 退役 — 其文档保存于 [`docs/archive/prowl-18780/`](./archive/prowl-18780/) 作历史参考。Devnet(`chainId 88888` H15 fork-off)仅用于 fixture 测试 — 见 `tests/multinode-integration/README.md`。

外部 operator 分步上手见 [`external-validator-onboarding.zh.md`](./external-validator-onboarding.zh.md)。灾难场景见 [`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md)。

---

## 1. 验证节点注册

一个验证节点是两个绑定在一起的链上身份：

- **`ValidatorRegistry.stake(nodeId, pubkeyNode)`** — 锁定 32 ETH bond，注册节点参与 BFT 出块
- **`PoSeManagerV2.registerNode(nodeId, pubkeyNode, ...)`** — 锁定 `MIN_BOND` (0.02 ETH)，加入 PoSe 服务网络（存储/可用性挑战）

两个 `nodeId` 公约不同，**不能互换**：

| Registry | nodeId 公式 |
|---|---|
| `ValidatorRegistry` | `keccak256(uncompressedPubkey[1:65])` (剥掉 0x04 前缀) |
| `PoSeManagerV2` | `keccak256(uncompressedPubkey)` (完整 65 字节包含 0x04 前缀) |

两个合约都校验 nodeId 末 20 字节等于 operator 地址（`address(uint160(uint256(nodeId)))`）。

### 1.1 ValidatorRegistry stake

```bash
# 计算 pubkey + nodeIds (Node.js + ethers v6)
node -e '
  const { Wallet, SigningKey, keccak256 } = require("ethers")
  const w = new Wallet("$YOUR_PRIVATE_KEY")
  const pubkey = new SigningKey(w.privateKey).publicKey
  const xy = "0x" + pubkey.slice(4)
  console.log("operator:        ", w.address)
  console.log("vrNodeId:        ", keccak256(xy))
  console.log("poseNodeId:      ", keccak256(pubkey))
'

# Stake (operator 钱包调用 — 这个地址付 gas + 32 ETH bond)
cast send --rpc-url $RPC --private-key $OPERATOR_KEY \
  $VALIDATOR_REGISTRY \
  "stake(bytes32,bytes)" $VR_NODE_ID $PUBKEY \
  --value 32ether
```

会 revert 的情况：
- 已注册 (`AlreadyRegistered`)
- nodeId 末 20 字节不匹配 `msg.sender` (`InvalidNodeId`)
- bond < `MIN_STAKE` = 32 ETH

### 1.2 PoSeManagerV2 registerNode

`registerNode` 更复杂 — 需要一个 `ownershipSig` 证明 operator 控制 BFT 签名密钥：

```js
// ownershipSig = personal_sign(keccak256("coc-register:" || poseNodeId || operator_address))
const message = ethers.solidityPacked(
  ["string", "bytes32", "address"],
  ["coc-register:", poseNodeId, operatorAddress],
)
const ownershipSig = await wallet.signMessage(ethers.getBytes(keccak256(message)))
```

然后调 `registerNode(poseNodeId, fullPubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x")`，附 `MIN_BOND` (0.02 ETH)。

参考：`tests/multinode-integration/scripts/deploy-pose-on-h15.mjs` 展示了 5 节点注册的标准模式。

---

## 2. 自愿退出（unstake）

```bash
# Step 1: 请求 unstake (无价值转账; 设置 unstakeRequestedAt 时间戳)
cast send --rpc-url $RPC --private-key $OPERATOR_KEY \
  $VALIDATOR_REGISTRY "requestUnstake(bytes32)" $VR_NODE_ID

# Step 2: 等 UNSTAKE_DELAY (默认 14 天) — 必需冷却期。

# Step 3: 取回 bond
cast send --rpc-url $RPC --private-key $OPERATOR_KEY \
  $VALIDATOR_REGISTRY "withdraw(bytes32)" $VR_NODE_ID
```

在 unstake-requested 状态下，节点仍在 `getActiveValidators()` 集合中（继续参与 BFT），直到 `withdraw()` 移除它。**在 `withdraw()` 之后才停节点进程**，不要提前 — 提前会触发 H15 fallback proposer override 给集群带来噪声。

PoSe 侧：`PoSeManagerV2` 当前没有干净的 unstake 路径；通过元数据更新设置 `serviceFlags=0` 来停用，或接受 bond 锁定到治理变更合约。

---

## 3. Slash 响应

如果链上 `EquivocationDetector.submitEvidence` 针对你的 nodeId 触发：

### 3.1 症状
- `ValidatorRegistry.getValidator(yourNodeId).active == false`
- `ValidatorRegistry.getValidator(yourNodeId).stake` 减少 SLASH_BPS=1000 (10%)
- 浏览器/mempool 出现你的 nodeId 的 `EquivocationProven` 事件
- 如果你的节点正在出当前 round，集群出块跌破 4-of-5 quorum

### 3.2 分诊（按顺序）
1. **停节点。** `systemctl stop coc-node` 或 kill docker 容器。继续运行 = 继续签名 = 更多 slash。
2. **抓取状态。** Tar `/data/coc/leveldb` + `~/.coc/keys` + `journalctl -u coc-node --since '1h ago'`。从 explorer 保存 `EquivocationProven` 日志 + tx hash。
3. **复现 double-sign。** 检测器合约 emit `(nodeId, signer, height, hashA, hashB, evidenceHash)`。`cast logs --address $DETECTOR --from-block <slash_block-1> --to-block <slash_block+1>` 提取两个冲突的 block hash。
4. **诊断。** 常见原因：
   - **两节点共享 key**：复制的 VM、并行运行的备份。检查 `journalctl` 中是否有同一 height/phase 来自不同 IP 的两次 BFT 签名事件。
   - **磁盘损坏**：重启时 stateRoot 分叉，恢复时签了不同的块。`tests/multinode-integration/scripts/` 中的 `leveldb-poke` 可以读 headers。
   - **时钟漂移**：BFT 轮次窗口依赖系统时间。检查 `chronyc tracking` / `timedatectl status`。
5. **不要重新 stake 被 slash 的 key**。它已经绑定证据；即使冷却过期，未来这个 key 签的 BFT 消息仍可作为证据再提交。生成新 key，重新注册。

### 3.3 申诉（commit-reveal 宽限期）
检测器有 `slashCooldownBlocks = 1000` 每 nodeId 间的 slash 间隔 — 同样的证据在该窗口内不会再次 slash。链上没有申诉流程。链下：在 operator 频道发布诊断 + 恢复计划；如果 slash 是基础设施引起（如上游链损坏），治理可以通过 proposal 调用 `ValidatorRegistry` owner-only 调整函数退款。

---

## 4. 治理参与

### 4.1 Faction 注册（一次性）

```bash
# HUMAN faction — 任意钱包
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $FACTION_REGISTRY "registerHuman()"

# CLAW faction — 需要 agent 证明
# 证明 = personal_sign(keccak256(agentId, msg.sender)) 由注册钱包签
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $FACTION_REGISTRY "registerClaw(bytes32,bytes)" $AGENT_ID $ATTESTATION
```

Faction 是不可变的 — 仔细注册。

### 4.2 提交提案

```bash
# proposalType: 0=ValidatorAdd 1=ValidatorRemove 2=ParameterChange 3=TreasurySpend 4=ContractUpgrade 5=FreeText
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO \
  "createProposal(uint8,string,bytes32,address,bytes,uint256)" \
  $TYPE "$TITLE" $DESC_HASH $TARGET 0x$CALLDATA $VALUE_WEI
```

投票窗口：7 天（默认）。Quorum：40%。Approval：60%。双院制（双 faction 各自达到批准阈值）当前 **未启用** — `bicameralEnabled()` 确认。

### 4.3 投票

```bash
# support: 0=反对, 1=支持, 2=弃权
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO "vote(uint256,uint8)" $PROPOSAL_ID 1
```

### 4.4 Queue + execute

```bash
# 投票期满 + 足够 FOR 票后:
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO "queue(uint256)" $PROPOSAL_ID

# executionDeadline 后 (queue + timelockDelay = 2 天):
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO "execute(uint256)" $PROPOSAL_ID
```

完整开发周期参考：`tests/integration/governance-dao-lifecycle.integration.test.ts` — 在 hardhat node 上 4.2 秒跑完整 `propose → vote → queue → execute` 流程。

---

## 5. 监控 + 告警

| 信号 | RPC 方法 / 来源 | 告警阈值 |
|---|---|---|
| 出块滞后 | 集群 max(`eth_blockNumber`) - 本地 | > 5 块持续 > 60 s |
| BFT round 不前进 | `coc_getBftStatus` | round 年龄 > 600 s (NO_PROGRESS_TIMEOUT) |
| Equivocation 计数上升 | `coc_getEquivocationsTotal` | 非零立即触发 |
| 验证节点 inactive | `ValidatorRegistry.getValidator(nodeId).active` | false → 呼叫 operator |
| 活跃验证者数 | `ValidatorRegistry.getActiveValidators().length` | < 4 (失去 4-of-5 BFT quorum) |
| Wire peer 数 | `coc_getNetworkStats.wireConnected` | < 2 |
| 磁盘剩余 | OS 级 | `/data/coc` < 10 GB |
| 内存 | OS 级 | RSS > 8 GB |

Explorer `/validators` 页面读 `coc_getValidators`（来源同 BFT 用的 `ValidatorRegistry.getActiveValidators()` 数据）— 收藏作为一目了然的快速查看。

---

## 6. 常见运维操作

### 6.1 干净重启节点
```bash
# Stop 接受 SIGTERM 并完成进行中的 BFT round 后退出
systemctl stop coc-node
# 等进程退出；应 < 30 s
journalctl -u coc-node -f | grep "graceful shutdown"
# 然后启动
systemctl start coc-node
```

### 6.2 把现有 hardcoded 验证节点迁移到 ValidatorRegistry-driven 模式
见 `scripts/migrate-bft-to-registry.sh` — 跑 4 步 SOP（预检、滚动重启、后验、回滚开关）。

### 6.3 在本地 fixture 测试故障场景
```bash
cd tests/multinode-integration
bash scripts/run-pose.sh up        # 5 节点 H15 fork-off + agent + relayer
node --experimental-strip-types --test scenarios/12-pose-slash-automation.test.ts
bash scripts/run-pose.sh down
```

### 6.4 链上检查 slash
```bash
cast logs --rpc-url $RPC --address $EQUIVOCATION_DETECTOR \
  "EquivocationProven(bytes32,address,uint256,bytes32,bytes32,bytes32)" \
  --from-block $START --to-block latest
```

---

## 7. 引用

- ValidatorRegistry 合约: `contracts/contracts-src/governance/ValidatorRegistry.sol`
- EquivocationDetector 合约: `contracts/contracts-src/governance/EquivocationDetector.sol`
- GovernanceDAO 合约: `contracts/contracts-src/governance/GovernanceDAO.sol`
- FactionRegistry 合约: `contracts/contracts-src/governance/FactionRegistry.sol`
- Treasury 合约: `contracts/contracts-src/governance/Treasury.sol`
- 生产部署地址: `contracts/deployed-registries-newchain.json`
- 准生产 testnet 88780 SOP: `docs/r3-2-prod-candidate-testnet-88780.md`
- 多节点集成 fixture: `tests/multinode-integration/README.md`
- BFT 迁移 SOP: `scripts/migrate-bft-to-registry.sh`
- 系统架构: `docs/system-architecture.zh.md`
- Slash 自动化运行时: `runtime/lib/equivocation-detector-client.ts`

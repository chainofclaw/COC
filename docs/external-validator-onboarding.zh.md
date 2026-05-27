# 成为 88780 Validator(外部 operator)

> 先读:[`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) 了解
> 网络 chainId / RPC / 合约地址。本文档是把新 validator 从零放进活跃 BFT 集
> 合的分步骤流程。

[English](./external-validator-onboarding.md)

## 适用对象

非创始团队的运营方,希望运行 88780 validator。88780 上添加 validator 是 **permissionless** 的:
任何在 `ValidatorRegistry` 合约上质押 32 COC 都会在一个 poll 周期(~60s)内
被加入活跃 BFT 集合——**无需与现有 operator 手动协调**。

如果你是核心团队 operator 运行内部 validator,见
[`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
——那个文档覆盖节点端 reader 配置和 multisig 协调 bootstrap。

## 开始前所需

| 资源 | 详情 |
|------|------|
| **节点硬件** | 4 核 / 16 GB 内存 / 250 GB SSD 起步(8/32/500 推荐用于 canary 余量)。公网 IP + 稳定 DNS 或静态 IP |
| **网络** | TCP 28780 (RPC) + 29780 (wire P2P) 对 peer 可达;18781 (WebSocket 可选)。出站到其他 validator 的同样端口 |
| **OS** | Linux(测试 Ubuntu 22.04+);systemd;链引擎用 Node.js 22+ |
| **32 COC 质押** | 硬性要求(`MIN_STAKE` 在 `ValidatorRegistry`)。加几个额外 COC 作 gas。通过 faucet(每 24h 10 COC)或 canary 期 OTC 购买/借入;主网 TGE 引入市场 |
| **Validator 签名密钥** | 全新 secp256k1 密钥对。**不要复用**钱包密钥——slash 烧此密钥的 stake,不应与 MetaMask 同密钥 |

## Step 0 — 生成 validator 签名密钥

```bash
mkdir -p ~/.coc/keys
node -e '
  const { Wallet } = require("ethers");
  const w = Wallet.createRandom();
  const { keccak256 } = require("ethers");
  const pubkey = w.signingKey.publicKey;
  const nodeId = keccak256("0x" + pubkey.slice(4));
  const fs = require("fs");
  fs.writeFileSync(process.env.HOME + "/.coc/keys/validator.json", JSON.stringify({
    address: w.address,
    privateKey: w.privateKey,
    publicKey: pubkey,
    nodeId: nodeId,
  }, null, 2));
  console.log("validator 地址:", w.address);
  console.log("nodeId:       ", nodeId);
'
chmod 600 ~/.coc/keys/validator.json
```

**关键**:安全备份 `validator.json`。丢失此密钥 = 损失 stake — 必须从仍持有的密钥
`requestUnstake()`、等 14 天、再 `withdrawStake()`。若**完全丢失**签名密钥访问,
stake 永久锁定(暂无社交恢复)。

## Step 1 — 预供签名密钥 EOA

签名密钥 EOA 需 ≥ 32 COC 用于 stake 交易 + gas buffer。Faucet 上限每地址 24h 10 COC,所以:

```bash
# 方法 1:从已有钱包预供(成人首选)
# 从已资助钱包转 32.1 COC 到 Step 0 的地址。

# 方法 2:连打 4 次 faucet,跨 4 天(仅适合测试)
for i in 1 2 3 4; do
  curl -X POST https://faucet.chainofclaw.io/faucet/request \
    -H 'content-type: application/json' \
    -d "{\"address\":\"$(jq -r .address ~/.coc/keys/validator.json)\"}"
  echo "  ...等 24h,重复"
done
```

验证余额:

```bash
ADDR=$(jq -r .address ~/.coc/keys/validator.json)
curl -s https://rpc.chainofclaw.io \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$ADDR\",\"latest\"]}" \
  | jq -r .result \
  | xargs -I{} node -e "console.log(parseInt('{}',16)/1e18, 'COC')"
# 预期 ≥ 32.1
```

## Step 2 — 搭建节点

完整 bringup 看 [`operations-manual.zh.md`](./operations-manual.zh.md)。简述:

```bash
# 克隆 + 装
git clone https://github.com/chainofclaw/COC.git ~/coc && cd ~/coc
npm install

# 最小配置
cat > /etc/coc/node-1.json <<EOF
{
  "chainId": 88780,
  "nodeId": "$(jq -r .nodeId ~/.coc/keys/validator.json)",
  "enableBft": true,
  "enableWireProtocol": true,
  "dataDir": "/var/lib/coc/node-1",
  "validators": [
    "0xde4e7889aa9007318ff261b1ee675f1305153590",
    "0xdefc8430388093fdfacb0a929fedc14d2e631d19",
    "0xcc64096600c1759d7aaea91166837a5873175867",
    "0x5e773c9359a6bb416bdfffe0c9aac9f568bd11ae",
    "0x919a0fd04d9ed960c9e26379aa18f11457e9e3e8",
    "0xb939e5a68abd2e000e78876bd86edd1cbba49eb9"
  ],
  "peers": [
    {"id": "0xde4e7889aa9007318ff261b1ee675f1305153590", "url": "http://209.74.64.88:39780"},
    {"id": "0xdefc8430388093fdfacb0a929fedc14d2e631d19", "url": "http://199.192.16.79:29780"},
    {"id": "0xcc64096600c1759d7aaea91166837a5873175867", "url": "http://159.198.36.3:29780"},
    {"id": "0x5e773c9359a6bb416bdfffe0c9aac9f568bd11ae", "url": "http://159.198.36.25:29780"},
    {"id": "0x919a0fd04d9ed960c9e26379aa18f11457e9e3e8", "url": "http://34.139.57.20:29780"},
    {"id": "0xb939e5a68abd2e000e78876bd86edd1cbba49eb9", "url": "http://159.198.44.136:29780"}
  ]
}
EOF

# env — 指向 ValidatorRegistry 让 reader 接到你的 stake
cat > /etc/coc/node-1.env <<EOF
COC_NODE_KEY=$(jq -r .privateKey ~/.coc/keys/validator.json)
COC_VALIDATOR_REGISTRY_ADDRESS=0x4441299c118373fDC96bE1983d42C79e19CDb4F0
COC_NODE_CONFIG=/etc/coc/node-1.json
COC_DATA_DIR=/var/lib/coc/node-1
EOF
chmod 600 /etc/coc/node-1.env

# systemd + start
systemctl enable --now coc-node@1
journalctl -u coc-node@1 -f
```

等 snap-sync 完成:
```
[INFO][consensus] snap sync complete
[INFO][persistent-engine] applyBlock phase ... height: <current_head> phase: done
```

你的节点现在镜像链了但**还不是 validator**——`validators` config 让你 bootstrap
为非投票 observer。下一步把你变成链上真正的 validator。

## Step 3 — 质押到 ValidatorRegistry

一笔交易把你加入活跃 BFT 集合:

```bash
node -e '
  const { Wallet, JsonRpcProvider, parseEther, Contract } = require("ethers");
  const fs = require("fs");
  const k = JSON.parse(fs.readFileSync(process.env.HOME + "/.coc/keys/validator.json"));

  const RPC = "https://rpc.chainofclaw.io";
  const REGISTRY = "0x4441299c118373fDC96bE1983d42C79e19CDb4F0";
  const ABI = ["function stake(bytes32 nodeId, bytes pubkeyNode) external payable"];

  (async () => {
    const p = new JsonRpcProvider(RPC);
    const w = new Wallet(k.privateKey, p);
    const c = new Contract(REGISTRY, ABI, w);

    console.log("staking from:", w.address);
    console.log("nodeId:     ", k.nodeId);
    const tx = await c.stake(k.nodeId, k.publicKey, { value: parseEther("32") });
    console.log("tx hash:    ", tx.hash);
    const r = await tx.wait();
    console.log("mined block:", r.blockNumber, "status:", r.status);
  })();
'
```

预期输出:
```
staking from: 0x<你的_signer_addr>
nodeId:       0x<你的_nodeId>
tx hash:      0x<stake_tx>
mined block:  <N>  status: 1
```

如果 tx revert 出错:
- `InsufficientBond` — signer EOA 余额 < 32 COC,补到 32 COC 重试
- `InvalidNodeId` — `nodeId` 不匹配 `keccak256(pubkey[1:])`;Step 0 重新生成
- `AlreadyRegistered` — 此 `nodeId` 已注册(你之前 stake 过,或别人用了同 nodeId — 用随机密钥几乎不可能)
- `ValidatorSetFull` — 21 槽位满。等现有 validator `requestUnstake()` 或被 slash 出

## Step 4 — 验证 BFT 纳入

一个 poll 周期内(默认 ~60s,现有 validator 的 `ValidatorRegistryReader` 按此频率 poll),
每个现有节点看到 `ValidatorRegistered` 事件,reader 更新 BFT:

```bash
# 你节点的预期日志:
journalctl -u coc-node@1 -n 100 --no-pager | grep -E "reader initialized|validator set updated"
# 应该显示:
#   [INFO][validator-registry-reader] reader initialized
#     activeCount: 7  (你 stake 前是 6)
#   [INFO][node] BFT validator set updated from ValidatorRegistry
#     count: 7  ids: [..., 0x<你的_nodeId_小写后 20B>]
```

向任意现有 validator RPC 交叉验证:

```bash
# Public RPC 透传到集群
curl -s https://rpc.chainofclaw.io \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"coc_getBftStatus"}' | jq .
# 看 result.validators — 应包含你的地址
```

几个 BFT round 内(几分钟),你的节点应开始签 prepare/commit 消息,
`coc_getBftStatus` 显示 `prepareVotes` / `commitVotes` 递增。

## Step 5 — 运行

Validator 日常:

- **监控**:打你节点 `/metrics`(9100 端口)获 Prometheus。关键指标:
  `coc_block_height`(必须跟上 peer,持续 gap > 5 块 = 问题)、`coc_bft_round_phase`、
  `coc_validator_active`
- **奖励**:PoSe v2 emission 在每个 finalized epoch 后落到你的 nodeId(88780 当前
  休眠 — emission 开启是单独的治理事件)。通过 `PoSeManagerV2.pendingWithdrawals(yourAddr)` 追
- **不要双签**:`EquivocationDetector` 监控同高度不同 blockHash 的两条签名 prepare/commit。
  一次 equivocation 事件 slash 10% stake。最常见原因 = 同一签名密钥跑两个节点 — **绝不要**这样。
  备份恢复演练必须先停主节点再启副节点
- **软件更新**:新节点版本发布时,按滚动模式 — **任何时刻最多停一个 validator**
  (chaos T2 显示同时停两个 + 死的 proposer slot 链 stall ~2.5min)

## Step 6 — 自愿退出

想停止运行 validator 时:

```bash
node -e '
  const { Wallet, JsonRpcProvider, Contract } = require("ethers");
  const fs = require("fs");
  const k = JSON.parse(fs.readFileSync(process.env.HOME + "/.coc/keys/validator.json"));
  const ABI = ["function requestUnstake(bytes32 nodeId) external"];
  (async () => {
    const w = new Wallet(k.privateKey, new JsonRpcProvider("https://rpc.chainofclaw.io"));
    const c = new Contract("0x4441299c118373fDC96bE1983d42C79e19CDb4F0", ABI, w);
    const tx = await c.requestUnstake(k.nodeId);
    console.log("unstake-request tx:", tx.hash);
    await tx.wait();
    console.log("done — 等 14 天再 withdrawStake()");
  })();
'
```

`requestUnstake()` 后你立即退出活跃 BFT 集合。stake 由合约持有 14 天
(`UNSTAKE_LOCKUP`)——此窗口存在的目的是退出后涌现的 equivocation 证据仍能 slash 你。

14 天后,withdraw:

```bash
node -e '
  /* 同上模板,但 */
  const ABI = ["function withdrawStake(bytes32 nodeId) external"];
  /* c.withdrawStake(k.nodeId) ... */
'
```

`requestUnstake()` 后随时可下线节点。把签名密钥保留到 `withdrawStake()` 成功 — 最好永久 ——
以防 slash 证据涌现要让 operator 社区验证合法退出。

## 故障排查

| 症状 | 可能原因 | 修复 |
|------|---------|------|
| `stake()` revert `InsufficientBond` | Signer EOA < 32 COC | 充 32.1 COC 重试 |
| 节点同步但 `coc_getBftStatus` 显示你未投票 | Reader 未接到 stake 事件 | 看节点日志 `reader initialized` 行;确认 `COC_VALIDATOR_REGISTRY_ADDRESS` env 已设;再等一个 poll 周期 |
| 其他 validator Wire-peer 连接拒绝 | 29780 端口防火墙(v1 是 39780) | 开放对应 `wirePort` 的入站 TCP |
| 节点持续落后 5+ 块 | 硬件/网络太弱 | 见 chaos 内存 `coc-88780-2026-05-26-chaos-engineering-T1-T8.md` § T1 — 最低:4 核,到其他 validator 的网络往返要可观 |
| 意外被 slash | Equivocation — 最大概率是两节点签同高度 | 停止 ALL 使用此签名密钥的实例。提公开 issue 附 EquivocationDetector 事件日志 + 你的运维故事 |

不在表中的问题,在 <https://github.com/chainofclaw/COC/discussions> 发帖,附 validator 地址(**不是**私钥)和 `journalctl -u coc-node@1 -n 500`。

## 另见

- [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) — chainId, RPC, 合约地址
- [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md) — 节点端 reader 内部细节
- [`operations-manual.zh.md`](./operations-manual.zh.md) — 完整节点部署
- [`operator-runbook.zh.md`](./operator-runbook.zh.md) — slash 响应、治理参与
- [`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md) — 出问题时
- [`SECURITY.md`](../SECURITY.md) — 漏洞披露

# 88780 灾难恢复 Runbook

> 6 个危机场景:每个含症状 / 诊断 / 恢复 / 回滚 / ops-handoff。每个场景引用 chaos
> 内存文件
> [`coc-88780-2026-05-26-chaos-engineering-T1-T8.md`](https://github.com/chainofclaw/COC/blob/main/docs/coc-88780-2026-05-26-chaos-engineering-T1-T8.md)
> (在 `~/.claude/projects/.../memory/` 里)中先前 chaos 演练观察到的已验证恢复模式。

[English](./disaster-recovery-88780.md)

## 开始前

**停。深呼吸。读。** 大多数链端"危机"乍看比实际严重。任何破坏性操作前的三项理性检查:

1. **确认症状真实,不是 UI 假象**。命中至少两个不同的 validator RPC
   (`209.74.64.88:38780`, `159.198.36.3:28780` 等,见
   [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md))加上公开 LB。
   如果 3 个中 1 个报错号,那是单节点问题,不是链问题。
2. **在动手前开战时频道**。哪怕 30 秒的协调也防两个 operator 跑冲突的恢复步骤。
3. **执行前读完相关场景**。每个场景有回滚路径;跳过会错过它可能需要更糟的恢复。

## 快速场景索引

| # | 场景 | 严重度 | 恢复时间 |
|---|------|--------|----------|
| 1 | 链停(BFT 不能 finalize) | HIGH | 30 min – 4 h |
| 2 | Multisig 密钥丢失(1 of 5) | LOW(运营) | 数日(签名者轮换) |
| 3 | Multisig 密钥丢失(2 of 5) | MEDIUM | 数日(签名者轮换,协调更难) |
| 4 | Multisig 密钥丢失(3+ of 5) | CRITICAL | 数周(multisig 重部 + 状态迁移) |
| 5 | 大规模节点丢失(全 6 宕) | HIGH | 30 min – 2 h(从 genesis bootstrap,chaos T8 实测 ~30 min) |
| 6 | Validator 密钥泄漏(单 validator) | MEDIUM | 14 天(unstake lockup)+ 即时节点停机 |
| 7 | Equivocation slash 响应(operator 侧) | MEDIUM | 数小时(operator 协调 + 事后回顾) |
| 8 | OZ-manifest 损坏(contracts/.openzeppelin/) | LOW | 数分钟(从链上重新导出) |

场景 2/3/4 是 multisig 丢失三种程度;场景 7 是 EquivocationDetector 触发后
operator 侧响应;场景 1, 5 是链状态问题;6 是密钥轮换;8 是开发侧工件恢复。

## 场景 1 — 链停(BFT 不能 finalize)

### 症状

- 全部可达 RPC 块高 > 60s 不再前进
- `coc_getBftStatus` 多次轮询显示相同 round + phase
- 多数 validator 日志反复显示 `Phase H15: proposer slot timeout, falling back`

### 诊断(只读)

```bash
# 步骤 1 — 跨集群确认高度卡住
for RPC in "https://rpc.chainofclaw.io" \
           "http://209.74.64.88:38780" \
           "http://159.198.36.3:28780" \
           "http://199.192.16.79:28780"; do
  HEX=$(curl -s --max-time 8 $RPC \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' \
    | jq -r .result)
  echo "$RPC -> $HEX  ($((HEX)))"
done

# 步骤 2 — 看每个 validator 认为的 round / phase
for RPC in <每个 validator>; do
  curl -s $RPC -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"coc_getBftStatus"}' | jq .result
done

# 步骤 3 — 找出哪个 validator 没在参与
# (看 prepareVotes / commitVotes 集合 — 数活跃 nodeId)
```

症状对应原因:

- **全 6 活,round phase 卡 `prepare`** — quorum 不能形成;可能网络分区。
  按 chaos 内存 T4(3-3 partition 观察)运行场景
- **N 个 validator 宕,quorum 边界失** — 同 chaos T2(2-of-6 宕)或 T3(3+ 宕完全 kill quorum)
  族。恢复:把 validator 弄回来。见场景 5
- **全活,round phase 循环 `proposer-skip`** — chaos T1/T5 观察:dead-proposer 槽
  每 ~60s 触发 H15 fallback。等;链会跳到下一个 proposer

### 恢复

**BFT-timeout stall(最常见)**:
- 通过 `coc_getBftStatus.validators` vs 活跃投票集合识别缺失的 validator
- 让缺失的 validator 回到在线(见场景 5 程序)
- 最后一个缺失节点重新加入后 1 round(~3s)内,链恢复

**网络分区(chaos T4 模式)**:
- 通过 peer 连接性识别分区两半
- 治愈连接性(防火墙规则,BGP 等)
- heal 后 30s 内(T4 观察),每半的 BFT round 重启,长链一方赢得 fork choice。
  **稳态无 fork**:T4 已验证停滞节点的 `stateRoot` 一致 + 0 EquivocationDetector 事件

**无明显原因的死锁**(真不清楚):按场景 5 协调重启(chaos T8 — 30s downtime,即时恢复)。
对临时状态(pending mempool)有破坏性但恢复活性。

### 回滚路径

无 — 这些是恢复行动,非破坏性。如果恢复本身导致问题(如节点拒绝重启),
落到场景 5 全重置。

### Ops-handoff 模板

```
[链停] 88780,起 ~<TIME UTC>
最后健康高度: <N>
卡住 phase: <prepare|commit|proposer-skip>
缺失 validator: <活跃投票集合中没有的 nodeId>
疑似原因: <BFT timeout | 分区 | 未知>
恢复行动: <场景 1 等 | 场景 5 全重启 | 其他>
下次 checkin: <TIME UTC + 15min>
负责: <operator handle>
```

## 场景 2 — Multisig 密钥丢失(1 of 5)

### 症状

- 5 个 multisig signer 之一报告密钥不可恢复
- 3-of-5 阈值仍安全满足(缓冲:1 备用)

### 诊断

确认其余 4 个 signer 仍能各自签测试交易:

```bash
# 对每个剩余 signer,尝试 multisig 一次空确认
# (如确认一个 0 confirm 的 TX,然后取消)
# 证明 4 个密钥可达且功能正常
```

### 恢复

**运营性,非危急**。安排签名者轮换:

1. 战时频道 + 剩余 4 个 signer — 确认轮换计划
2. 新 signer 生成新密钥对(线下,首选硬件钱包)
3. 任何 3 个剩余 signer,提交 + 确认 + 执行调用
   `MultiSigWallet.replaceOwner(oldAddr, newAddr)` 的 multisig 交易
4. 链上验证:`MultiSigWallet.getOwners()` 显示新地址
5. 丢失密钥的 signer 销毁泄漏密钥的任何备份

### 回滚路径

步骤 3 执行前:任何 4 个剩余 signer 拒绝确认终止轮换(3-of-5 阈值不达)。状态未变。

步骤 3 执行后:轮换在链上。新 signer 是权威。"回滚"意味着另一次反向轮换 — 
要花另一次 3-of-5 multisig 事件,否则无差别。

### Ops-handoff 模板

```
[MULTISIG 签名者轮换] 1 of 5
丢失 signer: <signer index + 之前地址>
替换 signer: <新地址 + 密钥托管故事>
协调人: <剩余 4 个 signer>
目标 multisig tx 提交: <UTC 日期>
目标轮换完成: <UTC 日期 + 24h 缓冲>
```

## 场景 3 — Multisig 密钥丢失(2 of 5)

### 症状

- 5 个 signer 中 2 个报告密钥不可恢复
- 3-of-5 阈值勉强满足(缓冲:0)
- 下次损失升级到场景 4(CRITICAL)

### 诊断

同场景 2 但对 3 个剩余 signer。确认每个各自功能正常且 3 个都愿协调签名。

### 恢复

**比场景 2 更紧急**因为缓冲耗尽 — 再损失一个 signer 意味着 multisig 永不能再签新交易。

1. **即时**:3 个剩余 signer 必须协调把密钥备份到额外安全存储
   (硬件钱包 → 独立硬件钱包,**不只是**云备份)
2. **当日**:安排 2 次轮换(2 个新 signer)
3. 作为独立 multisig 交易执行两次轮换:
   - tx 1:把丢失-signer-1 替换为新-signer-1
   - tx 2:把丢失-signer-2 替换为新-signer-2
4. 提交下一次前在链上验证每次轮换

### 回滚路径

同场景 2:轮换 tx 若 3 个剩余 signer 中 mid-process 任一不可用则签前中止。
按备用 signer 协议重试。

### Ops-handoff 模板

同场景 2 模板,但**高紧急**标记;目标 24h 内完成,而非 72h。

## 场景 4 — Multisig 密钥丢失(3+ of 5) — CRITICAL

### 症状

- 5 个 signer 中 3 个或更多丢失密钥
- 3-of-5 阈值**已破** — multisig 永远不能签新 tx
- 所有 UUPS 合约永远卡在当前实现

### 诊断

与剩余 signer 确认确实如此(不是临时不可达)。记录每个丢失密钥的情况:
硬件故障、托管丢失等。

### 恢复(无干净路径 — 选择毒药)

无链上恢复。multisig owner 角色不可恢复。链下三条路径:

**路径 A — 通过 deployer EOA 社交恢复**

deployer EOA `0xB4E943F5F34b763fC78598a9e528995B4CDe786a` *最初*部署了合约。
若 deployer 密钥仍可达且社区接受 deployer 驱动的恢复:

1. Deployer 在新 multisig 下重部 gen-5 合约集
   (`scripts/deploy-multisig-88780.js` + `scripts/deploy-all-88780.js`)
2. 链下协调宣布新合约地址
3. 社区 / dApps 更新引用到新 proxy
4. **旧合约被抛弃** — 任何旧合约的链上状态丢失(validator stake、Treasury 余额等)。这是硬分叉。

**路径 B — Validator 投票分叉**

与 6 个 validator 协调分叉到新链,其中:
1. 旧 multisig 的 owner 角色经定制 genesis 块替换
2. 从快照继续块高度 / 状态
3. 新链有新 chainId(如 88781 = 0x15acd)
4. 旧链(88780)被抛弃

明显比路径 A 更激进但保留状态。

**路径 C — 烧毁网络,重启 canary**

承认失败,公开 post-mortem,从新 genesis 干净重启 canary 用新 chainId。
状态损失但声誉干净。

### 回滚路径

无。Multisig 3-of-5 低于 quorum 是终点。**链本身继续运行**(BFT validator 独立于 multisig signer)
— 只是合约升级被阻塞。所以**链继续出块**即使在此场景下;只有治理 / 升级行动暂停。

### Ops-handoff 模板

```
[CRITICAL MULTISIG 故障] 88780 — multisig 3-of-5 已破
丢失 signer(3+ of 5): <index + 情况>
剩余 signer: <index>
考虑路径: <A: deployer 恢复 | B: validator-fork | C: 干净重启>
链活性: <BFT 仍健康 / 链仍出块>
升级权威: <已破 — 在路径执行前无法合约升级>
协调人: <ops + 治理 lead>
计划公开沟通: <UTC>
```

## 场景 5 — 大规模节点丢失(全 6 宕)

### 症状

- 全 6 validator RPC 不响应
- 块产生停止
- `https://rpc.chainofclaw.io` 返 503

### 诊断

确认这不是公开 RPC 单点故障:

```bash
# 直击每个 validator 的私有 RPC(不经 LB)
for HOST in 209.74.64.88:38780 159.198.44.136:28780 \
            199.192.16.79:28780 159.198.36.3:28780 \
            159.198.36.25:28780; do
  echo "=== $HOST ==="
  curl -s --max-time 8 http://$HOST \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' | head -c 200
  echo ""
done

# obs-1 是 gcloud;通过 bob@ + sudo SSH
ssh bob@34.139.57.20 'curl -s http://127.0.0.1:28780 ...'
```

若全 6 都宕,这是真正的大规模故障。

### 恢复

Chaos test T8(2026-05-26)验证了正是此恢复:**全 6 节点同步并行重启,~30s downtime,
即时恢复 3s/block 生产**。见 chaos 内存文件。

程序:

```bash
# 1. SSH 到每个 validator 主机 + obs-1
# 2. 用已验证的脚本运行并行重启:
bash /tmp/coc-chaos-T8.sh   # 若 chaos sprint 仍在
# 或者内联重现:
SSH_KEY=$HOME/.ssh/openclaw_server_key
( ssh -i $SSH_KEY root@209.74.64.88   "systemctl restart coc-node@88" ) &
( ssh -i $SSH_KEY root@159.198.44.136 "systemctl restart coc-node@1"  ) &
( ssh -i $SSH_KEY root@199.192.16.79  "systemctl restart coc-node@88" ) &
( ssh -i $SSH_KEY root@159.198.36.3   "systemctl restart coc-node@1"  ) &
( ssh -i $SSH_KEY root@159.198.36.25  "systemctl restart coc-node@1"  ) &
( ssh             bob@34.139.57.20      "sudo systemctl restart coc-node@1" ) &
wait

# 3. 等 30s,探块产生
sleep 30
for HOST in <每个>; do
  curl -s http://$HOST -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' \
    -H 'content-type: application/json' | jq -r .result
done
```

若并行重启不恢复(5min 后链仍卡):

- **Genesis bootstrap 恢复**:每节点数据目录必须清 + 从外部 archive 节点重 snap-sync。
  88780 规模未测过;要数小时
- 这个级别的故障建议状态损坏或协调软件 bug,而非简单进程崩溃 — 升级到工程团队

### 回滚路径

并行重启可从自身恢复:每次 `systemctl restart` 重新生成进程,从磁盘 leveldb 状态。
无数据损失,除非底层磁盘失败。

### Ops-handoff 模板

```
[大规模节点丢失] 88780 — 全 6 validator 宕
最后健康高度: <N>
疑似原因: <协调软件 bug | 网络故障 | DDoS | 未知>
恢复路径: <并行重启 | genesis bootstrap | 工程升级>
预计恢复时间: <30 min for 并行重启>
公开沟通: <YES — chainofclaw.io/network 状态页更新>
负责: <ops lead>
```

## 场景 6 — Validator 密钥泄漏(单 validator)

### 症状

- validator operator 报告签名密钥可能泄漏
  (笔记本被盗、云被破、社交工程攻击)
- 尚未触发 equivocation,但 operator 想在造成损害前立即轮换

### 诊断

确认泄漏范围:
- 只是签名密钥被访问,还是 operator 资金 / multisig 份额也被访问?
- validator 仍合法出块,还是攻击者已开始签名?

### 恢复

**即时(数分钟内)**:
1. **停止泄漏的 validator 节点**(`systemctl stop coc-node@N`) —
   防止攻击者拿到密钥副本时强制双签
2. **自愿 unstake**:从仍受控的密钥(在干净环境,非泄漏主机)调用
   `ValidatorRegistry.requestUnstake(nodeId)`。立即把你从活跃 BFT 集合移除,
   启动 14 天 lockup。接下来 14 天内涌现的任何 equivocation 证据仍会 slash 你,
   但新出块的攻击面已关
3. **生成新签名密钥**,按
   [`external-validator-onboarding.zh.md`](./external-validator-onboarding.zh.md) Step 0
4. **等 14 天**(`UNSTAKE_LOCKUP`)。不能缩短
5. **提取旧 stake**(`withdrawStake`) — 返回 stake 减去 lockup 窗口内任何 slash
6. **用新密钥重新 stake**:从新密钥的 32 COC,在 registry 上注册新 nodeId

### 回滚路径

步骤 2 执行前:若泄漏未确认,停止 unstake 仅让 validator 暂停 — 无链上行动。
节点可稍后重启,若警报误报。

步骤 2 后:轮换在链上。无回滚;14-day 时钟跑,operator 必须执行步骤 3-6。

### Ops-handoff 模板

```
[VALIDATOR 密钥泄漏] nodeId <ID>
泄漏细节: <笔记本 / 云 / 社交 / 未知>
资金风险: <yes/no>
泄漏时间: <UTC>
已采取行动: <节点已停 @ UTC | unstake 已请求 @ UTC>
旧密钥提取可用: <泄漏时间 + 14d>
新密钥就绪: <yes/no/in-progress>
负责: <operator>
协调: <ops lead>
```

## 场景 7 — Equivocation slash 响应(operator 侧)

### 症状

- `EquivocationDetector` 发出带你 nodeId 的 `EquivocationProven` 事件
- `ValidatorRegistry` 发出配对的 `ValidatorSlashed` 事件
  (剩余 stake 的 10% 烧 + 进 insurance fund + 报告者)
- 你的 validator 自动从活跃 BFT 集合移除

### 诊断

你有错,但你需要知道怎么错:
1. 从 `EquivocationProven` 事件识别两条冲突的签名消息(`hashA`, `hashB`):
   ```bash
   curl -s https://rpc.chainofclaw.io \
     -H 'content-type: application/json' \
     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{
       \"address\":\"0xa5dcE830e917176c1091fd6112F41E47692C510e\",
       \"fromBlock\":\"0x<recent>\"
     }]}" | jq .
   ```
2. 把每个签名匹配到你运行的一个节点实例
3. **最常见根因**:同一签名密钥在两台主机上(主 + 备,都活)。**永远**只跑一个节点
   一个签名密钥

### 恢复

**即时**:
1. 停止 ALL 使用此签名密钥的节点(不冒第二次 equivocation 风险)
2. 公开声明(社区信任要求对发生的事诚实)
3. 把下一步当场景 6 — 自愿 unstake 已 slash 的 validator,生成新签名密钥,
   14-day lockup 后用新密钥 re-stake。旧 stake 剩余 90% 可在 lockup 后恢复

**运营 post-mortem**:
- 检视你的 fail-over / standby 设置。基本规则:**绝不**用同签名密钥跑两个节点,
  哪怕一个是 "standby"
- 在 operator 内部 SOP 中记录失败根因
- 考虑 HSM 支持的签名密钥(只一个 HSM,只一个签名进程)

### 回滚路径

Equivocation 在链上。无回滚。slash 已触发。恢复仅向前(上面步骤)。

### Ops-handoff 模板

```
[EQUIVOCATION SLASH] nodeId <ID>
Slash 金额: <amount> COC(剩余 stake 的 10%)
冲突签名: hashA=<...> hashB=<...> at height=<N>
根因: <多节点同密钥 | 软件 bug | 未知>
重 stake 计划: <等 14d、新密钥、re-stake>
公开声明: <yes/no/draft>
负责: <operator>
```

## 场景 8 — OZ-manifest 损坏

### 症状

- `contracts/.openzeppelin/unknown-88780.json` 缺失或损坏
- `upgrades.prepareUpgrade()` 或 `upgrades.validateUpgrade()` 报
  "no manifest found" 或 "implementation address mismatch"

### 诊断

```bash
cd contracts
ls -la .openzeppelin/unknown-88780.json
jq . .openzeppelin/unknown-88780.json | head
```

若文件完全缺失或不解析为 JSON,损坏。链上状态仍健康 — 只有本地升级安全簿记坏了。

### 恢复

OZ 提供从链上状态重建 manifest 的方式:

```bash
cd contracts
node -e '
  const { ethers, upgrades } = require("hardhat");
  const manifest = require("@openzeppelin/upgrades-core").Manifest;
  // 从每个 proxy 地址 bootstrap:
  const PROXIES = require("../configs/deployed-contracts-88780.json").contracts;
  (async () => {
    for (const [name, addr] of Object.entries(PROXIES)) {
      const impl = await upgrades.erc1967.getImplementationAddress(addr);
      console.log(name, "proxy:", addr, "impl:", impl);
    }
    // 使用 upgrades.forceImport() 从这些对子撒种 manifest。
  })();
'
```

完整自动恢复用 OZ `forceImport` 助手:

```js
await upgrades.forceImport(proxyAddress, FactoryContract, { kind: "uups" });
```

对 13 个 gen-5 proxy 每个重复。Manifest 会在 `.openzeppelin/unknown-88780.json` 重建。
把结果 commit 到 git。

### 回滚路径

若 forceImport 不能完全恢复,最坏情况:未来升级将无法使用 OZ 升级安全验证。
仍可通过 multisig 的低层 `proxy.upgradeTo(newImpl)` 调用执行,绕过安全检查。
风险但能用。

长期恢复:从每次成功的未来升级逐条重建 manifest 条目。

### Ops-handoff 模板

```
[OZ MANIFEST 损坏]
文件: contracts/.openzeppelin/unknown-88780.json
症状: <缺失 | JSON 损坏 | impl-address 不匹配>
链上状态: <健康>
恢复行动: <forceImport per proxy | bypass 用 raw upgradeTo>
负责: <开发者>
```

## 故意不包含的内容

- **硬分叉的状态迁移脚本** — 场景特定,按需作者
- **主网恢复** — 主网尚未存在;存在时,带主网特定地址 + 签名者的独立 runbook
- **桥事件响应** — 尚无桥;为未来占位
- **PoSe v2 settlement 恢复** — 88780 上 PoSe v2 流水线休眠;流水线激活时添加此场景

## 另见

- [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) — 端点 + 合约地址
- [`canary-launch-checklist-88780.zh.md`](./canary-launch-checklist-88780.zh.md) — gate 7 绑此
- [`external-validator-onboarding.zh.md`](./external-validator-onboarding.zh.md) — 场景 6, 7 的恢复
- Chaos 工程内存(`~/.claude/projects/-passinger-projects-ClawdBot/memory/coc-88780-2026-05-26-chaos-engineering-T1-T8.md`) — T2/T3/T4/T8 已验证恢复模式
- [`SECURITY.md`](../SECURITY.md) — equivocation-detector 恢复上下文

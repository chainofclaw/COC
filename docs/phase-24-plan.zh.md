# Phase 24：生产加固（含安全与抗女巫增强）

## 概述

Phase 24 添加生产就绪工具：健康检查探针、配置验证和 RPC 速率限制。

## 组件

### HealthChecker
- 运行链、区块新鲜度、节点对等和内存池检查
- 返回整体状态：healthy / degraded / unhealthy
- 报告运行时间、链 ID、节点 ID、最新区块、节点数
- 每项检查包含延迟测量
- 可配置 maxBlockAge 和 minPeers 阈值

### 配置验证器
- 验证必填字段（nodeId、chainId）
- 端口范围验证（1-65535），特权端口警告
- 区块时间和最终性深度合理性检查
- 返回带严重级别（error/warning）的问题列表

### RateLimiter
- 令牌桶算法实现每客户端速率限制
- 可配置最大令牌数和填充速率
- 按键隔离桶
- 过期桶清理以优化内存

## 测试覆盖

- `node/src/health.test.ts`：3 个套件共 21 个测试
- HealthChecker：7 个测试（健康、降级、不健康、边界情况）
- validateConfig：8 个测试（有效配置、缺失字段、无效范围）
- RateLimiter：6 个测试（允许、阻止、重置、清理、隔离）

## 安全漏洞分析（增量）

### 1. PoSe 回执防重放在重启后存在窗口
- 风险：若 nonce 注册表仅在内存中，节点重启后旧挑战可能被重复提交。
- 影响：挑战回执可被重复利用，削弱惩罚/评分可信度。
- 处置：将 PoSe nonce 注册表持久化路径接入节点配置并默认启用。

### 2. P2P 入站请求缺乏统一速率治理
- 风险：攻击者可通过单 IP 或少量代理发起高频 `/p2p/*` 请求，导致 CPU/IO 放大。
- 影响：节点可用性下降，发现与共识路径受噪声干扰。
- 处置：新增 P2P 入站限流参数并在 HTTP gossip 入口统一执行。

### 3. 发现面治理参数缺少配置出口
- 风险：`maxPeers` / `maxDiscoveredPerBatch` 无法按部署环境调优，抗女巫弹性不足。
- 影响：在高噪声网络中易出现连接槽位被占满。
- 处置：将发现治理参数提升为节点配置项，支持按环境收敛。

## 本轮已落地修改

- `node/src/config.ts`
  - 新增配置项：
    - `poseNonceRegistryPath`
    - `poseMaxChallengesPerEpoch`
    - `p2pMaxPeers`
    - `p2pMaxDiscoveredPerBatch`
    - `p2pRateLimitWindowMs`
    - `p2pRateLimitMaxRequests`
    - `p2pRequireInboundAuth`
    - `p2pInboundAuthMode`（`off`/`monitor`/`enforce`）
    - `p2pAuthMaxClockSkewMs`
  - 增加对应校验规则。
- `node/src/index.ts`
  - PoSe 引擎接入持久化 nonce 注册表。
  - P2P 节点接入发现与限流配置。
- `node/src/p2p.ts`
  - 新增 `/p2p/*` 入站限流（按 IP）。
  - discovery 构造接入 `maxDiscoveredPerBatch`。
  - 新增 P2P 写接口签名认证信封（`_auth`），包含时间窗与 nonce 防重放校验（可配置启用）。
  - 新增认证灰度模式：`monitor` 模式下校验并记账但不拒绝；`enforce` 模式下严格拒绝无签名/签名无效请求。
  - 新增安全观测计数：`rateLimitedRequests/authAcceptedRequests/authMissingRequests/authInvalidRequests/authRejectedRequests`。
- `node/src/pose-engine.ts`
  - 支持注入 `nonceRegistry` 依赖，便于接入持久化实现。
  - 新增 epoch 全局挑战预算（`maxChallengesPerEpoch`），抑制多伪节点刷挑战。

## 本次补充实现（P0 第 1-3 批 + P1 第 1-2 批 + P2 第 1 批）

- `node/src/pose-http.ts`
  - 新增 PoSe HTTP 入站鉴权能力（`off`/`monitor`/`enforce`），支持签名、时间窗、nonce 防重放、挑战者 allowlist。
  - `/pose/challenge` 与 `/pose/receipt` 增加 `hex32` 参数校验（`nodeId`、`challengeId`）。
- `node/src/config.ts`
  - 新增配置项：`poseRequireInboundAuth`、`poseInboundAuthMode`、`poseAuthMaxClockSkewMs`、`poseAllowedChallengers`（含环境变量与校验）。
  - 新增配置项：`poseAuthNonceRegistryPath`、`poseAuthNonceTtlMs`、`poseAuthNonceMaxEntries`（含环境变量与校验）。
  - 新增配置项：`p2pAuthNonceRegistryPath`、`p2pAuthNonceTtlMs`、`p2pAuthNonceMaxEntries`（含环境变量与校验）。
  - 新增配置项：`poseNonceRegistryTtlMs`、`poseNonceRegistryMaxEntries`（含环境变量与校验）。
  - P2P 入站鉴权默认模式从 `monitor` 调整为 `enforce`（可通过配置显式回退）。
  - PoSe 入站鉴权默认模式从 `monitor` 调整为 `enforce`（可通过配置显式回退）。
- `node/src/rpc.ts`、`node/src/index.ts`
  - RPC 启动链路接入 PoSe 路由鉴权配置。
- `runtime/coc-agent.ts`
  - 调用 `/pose/challenge`、`/pose/receipt` 时默认携带签名信封，兼容 `enforce` 模式。
  - 新增 `endpointFingerprintMode`（`strict`/`legacy`），默认 `strict`，缓解同机多地址绕过。
- `node/src/peer-discovery.ts`、`node/src/p2p.ts`
  - discovery 新 peer 先进入待验证队列，通过身份校验后再加入主 peers 池。
  - 新增 `/p2p/identity-proof` 挑战签名验证，拒绝仅靠自报 `nodeId` 的伪造节点。
- `node/src/p2p.ts`
  - P2P auth nonce 防重放升级为“持久化 + TTL + 周期压缩”，覆盖节点重启窗口。
- `node/src/dht-network.ts`
  - `verifyPeer` 优先使用带签名的 Wire 握手验证身份；无鉴权配置时再回退 TCP 可达性探测。
- `services/verifier/nonce-registry.ts`、`services/verifier/receipt-verifier.ts`
  - NonceRegistry 增加 TTL、容量上限和周期压缩，缓解长期运行磁盘/内存膨胀。
  - 回执时序校验新增下界（`responseAtMs >= issuedAtMs`），封堵时序异常回执。
- `node/src/rpc.ts`
  - `coc_getNetworkStats` 增加 P2P 安全统计（限流、鉴权拒绝、discovery 失败）与 DHT 验证统计暴露。

## 后续计划（下一批）

1. 挑战预算分层化
- 在已具备“按节点 + 按 epoch 全局预算”的基础上，继续细化到“按挑战类型/信誉分层预算”。

2. 链上角色联动
- 将 PoSe challengers allowlist 从静态配置扩展为“链上活跃角色 + 本地缓存”双重校验。

3. 策略联动自动化
- 增加高频来源熔断与封禁闭环（鉴权失败率/重放命中率 -> peer scoring/health 降级）。

## 基于代码实况的残留风险（2026-02-15）

### P0（需优先处理）

1. PoSe HTTP 路由缺乏来源认证与目标约束（可被刷空挑战预算）
- 现状：`/pose/challenge` 与 `/pose/receipt` 仅做基础字段校验与 IP 频控，未校验请求方身份或挑战者角色。
- 代码位置：`node/src/pose-http.ts`
- 风险：外部攻击者可批量构造请求消耗 `maxChallengesPerEpoch`，并干扰正常挑战流程。
- 状态：已实现入站签名鉴权、挑战者 allowlist 且默认 `enforce`；后续继续联动链上角色校验。

2. endpointCommitment 对“同机多地址”约束不足
- 现状：机器指纹包含 `pubkey`，同一机器换地址会产生不同 commitment。
- 代码位置：`runtime/coc-agent.ts`
- 风险：可绕过“同机唯一”假设，削弱对多地址女巫的抑制能力。
- 状态：已在第 2 批提供 `strict/legacy` 模式并默认 `strict`，保留迁移开关。

3. 发现层身份真实性校验不足（易受伪造 Peer 污染）
- 现状：Peer discovery 与 DHT 主要依赖格式/可达性检查；DHT 回退校验仅 TCP 可连通，不校验节点身份。
- 代码位置：`node/src/peer-discovery.ts`、`node/src/dht-network.ts`
- 风险：伪造节点可污染路由表与发现池，放大 Eclipse/Sybil 风险。
- 状态：已实现“待验证队列 + `/p2p/identity-proof` 挑战签名 + 握手优先验证”，后续继续引入信誉分层。

### P1（应在下一阶段完成）

1. P2P 入站鉴权默认仍为 `monitor`
- 现状：配置默认模式为 `monitor`，即使校验失败也可放行。
- 代码位置：`node/src/config.ts`、`node/src/p2p.ts`
- 风险：生产未切到 `enforce` 时，认证收益主要停留在观测层。
- 状态：已在 P1 第 1 批改为默认 `enforce`，保留显式回退。

2. P2P auth nonce 防重放仅内存窗口
- 现状：P2P nonce 追踪为进程内 `BoundedSet`，重启后窗口丢失。
- 代码位置：`node/src/p2p.ts`
- 风险：重启后短窗口重放与高频冲刷可能绕过历史 nonce 记忆。
- 状态：已在 P1 第 1 批接入持久化与 TTL，后续继续做分层预算联动。

3. NonceRegistry 长期运行可无限增长
- 现状：持久化日志逐行追加，无 TTL/分段/压缩；启动时全量加载到内存。
- 代码位置：`services/verifier/nonce-registry.ts`
- 风险：长期运行存在磁盘与内存增长风险，可被滥用放大为可用性问题。
- 状态：已完成 TTL、容量上限与压缩基线，后续可按天/epoch 分段进一步优化冷启动。

### P2（观测与运营增强）

1. 安全指标未完整进入统一 RPC 观测面
- 现状：`coc_getNetworkStats` 未返回 P2P 鉴权与限流计数。
- 代码位置：`node/src/rpc.ts`
- 风险：外部监控系统难以及时识别攻击态势与调参效果。
- 状态：已完成 P2P/DHT 安全计数对外暴露，后续补告警阈值模板。

2. 回执时序校验可再收紧
- 现状：校验了超时上界，但未限制 `responseAtMs >= issuedAtMs`。
- 代码位置：`services/verifier/receipt-verifier.ts`
- 风险：在边界条件下存在时序异常回执被接受的空间。
- 状态：已补充下界校验，风险闭合。

## 改造计划（执行版）

### P0：身份与入口收口（1 个迭代）

1. PoSe 路由加签与角色校验
- 目标文件：`node/src/pose-http.ts`、`node/src/index.ts`、`node/src/config.ts`
- 动作：
  - 为 `/pose/challenge`、`/pose/receipt` 增加签名信封与时间窗/nonce 防重放。
  - 增加挑战者 allowlist（静态配置 + 可选链上活跃节点校验）。
  - 对 `nodeId` 强制 hex32 规范，拒绝无效目标。

2. endpointCommitment 绑定策略修订
- 目标文件：`runtime/coc-agent.ts`、`docs/anti-sybil-zh.md`
- 动作：
  - 将机器指纹从“host+mac+pubkey”改为“host+mac(+可选运营商域分隔)”。
  - 增加 `COC_ENDPOINT_FINGERPRINT_MODE`（`strict`/`legacy`）用于灰度迁移。
  - 在文档中明确：NAT/云环境误判与豁免策略。

3. Discovery/DHT 身份验证前置
- 目标文件：`node/src/peer-discovery.ts`、`node/src/dht-network.ts`、`node/src/wire-client.ts`
- 动作：
  - 新 peer 进入隔离池，需通过一次签名握手验证后再入主池。
  - DHT `verifyPeer` 从“TCP 连通”升级为“握手身份匹配”。

### P1：防重放与预算治理（1 个迭代）

1. P2P 入站鉴权推进到默认 `enforce`
- 目标文件：`node/src/config.ts`、`node/src/p2p.ts`、`node/src/p2p-auth.test.ts`
- 动作：
  - 将默认模式由 `monitor` 切换到 `enforce`（保留显式回退开关）。
  - 补充兼容窗口和拒绝计数监控阈值。

2. P2P nonce 持久化与 TTL
- 目标文件：`node/src/p2p.ts`、`node/src/storage/nonce-store.ts`（或新增专用 store）
- 动作：
  - 为 P2P auth nonce 引入持久化 + 过期淘汰。
  - 对 replay key 增加分片清理，避免热键膨胀。

3. NonceRegistry 压缩与滚动
- 目标文件：`services/verifier/nonce-registry.ts`
- 动作：
  - 引入按 epoch/天分段文件。
  - 增加最大保留期和启动时增量加载策略。

### P2：监控闭环与策略自动化（持续）

1. 统一安全观测
- 目标文件：`node/src/rpc.ts`
- 动作：
  - 在 `coc_getNetworkStats` 暴露 `rateLimited/authMissing/authInvalid/authRejected` 等计数。
  - 增加 discovery 隔离池规模与 DHT 验签失败计数。

2. 策略联动
- 目标文件：`node/src/peer-scoring.ts`、`node/src/health.ts`
- 动作：
  - 将鉴权失败率、重放命中率接入封禁评分与健康降级信号。

## 验收标准（建议）

1. 攻击回归测试
- 新增：
  - `node/src/pose-http-auth.test.ts`
  - `node/src/discovery-sybil.test.ts`
  - `node/src/p2p-replay-persistence.test.ts`

2. 指标验收
- 在压测下，`authRejectedRequests` 与限流命中率可观测；误杀率在可控阈值内。

3. 灰度验收
- `monitor -> enforce` 切换期间无大面积合法流量中断，且回退机制可用。

## 测试覆盖（本轮）

- 已通过：
  - `node/src/config.test.ts`
  - `node/src/pose-auth.test.ts`
  - `node/src/dht-network.test.ts`
  - `node/src/pose-engine.test.ts`
  - `node/src/peer-discovery.test.ts`
  - `node/src/p2p-auth.test.ts`
- 受当前沙箱限制（`listen EPERM`）未能在本环境执行完整网络监听用例：
  - `node/src/p2p.test.ts`

## 状态：进行中

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

## 后续计划（下一批）

1. P2P 身份绑定灰度
- 继续从 `monitor` 推进到默认 `enforce`，并定义不兼容节点隔离与回退窗口。

2. 挑战预算分层化
- 在已具备“按节点 + 按 epoch 全局预算”的基础上，继续细化到“按挑战类型/信誉分层预算”。

3. 观测与告警
- 增加限流命中率、拒绝计数与高频来源统计，联动封禁策略。

## 测试覆盖（本轮）

- 已通过：
  - `node/src/config.test.ts`
  - `node/src/pose-engine.test.ts`
  - `node/src/peer-discovery.test.ts`
  - `node/src/p2p-auth.test.ts`
- 受当前沙箱限制（`listen EPERM`）未能在本环境执行完整网络监听用例：
  - `node/src/p2p.test.ts`

## 状态：进行中

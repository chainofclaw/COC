# Phase 20：State Trie 优化

## 概述

Phase 20 通过缓存、脏追踪和 @ethereumjs/trie v6 DB 适配器修复来优化持久化状态 trie。

## 变更

### Bug 修复：TrieDBAdapter v6 兼容性
- 更新 `TrieDBAdapter` 同时接受 `string` 和 `Uint8Array` 类型的 key（trie v6 传递字符串 key）
- 将缺失值的返回类型从 `null` 改为 `undefined`（trie v6 期望 `undefined`）
- 修复因 `unprefixedHexToBytes` 空引用导致的存储操作测试失败

### Storage Trie LRU 缓存
- Storage trie 数量上限为 `maxCachedTries`（默认 128）
- 通过访问顺序列表追踪 LRU
- 脏 trie 不会被驱逐（提交期间受保护）
- `evictLru()` 在缓存满时移除最旧的非脏条目

### 账户读缓存
- `get(address)` 结果的内存缓存
- 在 `put()` 和 `revert()` 时失效
- 避免重复读取时的冗余 trie 查询

### 脏追踪
- `dirtyAddresses` 集合追踪已修改的账户/存储
- `commit()` 仅更新脏地址的存储根
- 减少提交期间的不必要 DB 写入

### State Root 持久化
- `commit()` 将状态根保存到 DB 键 `meta:stateRoot`
- `init()` 在重启时从持久化的根恢复 trie
- `stateRoot()` 无需重新计算即可返回最后提交的根

### 已知限制
- 跨实例 trie 持久化存在 @ethereumjs/trie v6 的 RLP 解码问题
- 单实例操作（账户 CRUD、存储、代码）均正常工作
- 根因：trie v6 内部节点格式与 DB 适配器的兼容性

## 测试结果

- 已修复：PersistentStateTrie 存储操作测试（原先失败，现已通过）
- 剩余：跨实例持久化测试（@ethereumjs/trie v6 预存问题）

## 状态：已完成

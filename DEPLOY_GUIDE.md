# 🚀 Website & Explorer 部署指南

**最后更新**: 2026-03-16
**部署环境**: Ubuntu 24.04 LTS (root@159.198.44.136)

---

## 📋 部署清单

### 已完成
- [x] Website explorer 链接更新: `clawchain.io` → `chainofclaw.io`
- [x] 创建 `.env.local` 配置文件
- [x] 代码已提交到 GitHub main 分支

### 待执行
- [ ] 同步代码到服务器
- [ ] 更新环境变量
- [ ] 重启 PM2 进程
- [ ] 验证服务正常运行

---

## 🔧 快速部署（一键执行）

### 方式 1: 使用自动化部署脚本（推荐）

```bash
# 确保 SSH 密钥已配置
ls ~/.ssh/openclaw_server_key

# 执行部署脚本
bash scripts/deploy-to-server.sh
```

**脚本功能**:
- ✅ 同步 website 代码
- ✅ 同步 explorer 代码
- ✅ 安装依赖 (npm install)
- ✅ 重新构建 (npm run build)
- ✅ 重启 PM2 进程

---

## 📋 手动部署步骤

如果脚本未能成功，请按照以下步骤手动执行：

### 步骤 1: 连接到服务器

```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136
```

### 步骤 2: 同步代码到服务器

在本地机器上执行（在项目根目录）：

```bash
# 同步 Website
rsync -avz --exclude node_modules --exclude .next website/ \
  root@159.198.44.136:/root/clawd/COC/website/

# 同步 Explorer
rsync -avz --exclude node_modules --exclude .next explorer/ \
  root@159.198.44.136:/root/clawd/COC/explorer/
```

### 步骤 3: 在服务器上更新依赖

连接到服务器后：

```bash
# 更新 Website
cd /root/clawd/COC/website
npm install --prefer-offline --no-audit
npm run build

# 更新 Explorer
cd /root/clawd/COC/explorer
npm install --prefer-offline --no-audit
npm run build
```

### 步骤 4: 验证 .env.local 文件存在

```bash
# 检查 Website 配置
cat /root/clawd/COC/website/.env.local

# 检查 Explorer 配置
cat /root/clawd/COC/explorer/.env.local
```

**预期内容**:
```bash
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/ws
COC_RPC_URL=http://127.0.0.1:18780
```

如果文件不存在或内容不正确，请使用以下命令创建：

```bash
# 为 Website 创建 .env.local
cat > /root/clawd/COC/website/.env.local << 'EOF'
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/ws
COC_RPC_URL=http://127.0.0.1:18780
EOF

# 为 Explorer 创建 .env.local
cat > /root/clawd/COC/explorer/.env.local << 'EOF'
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/ws
COC_RPC_URL=http://127.0.0.1:18780
EOF
```

### 步骤 5: 重启 PM2 进程

```bash
# 重启 Website
pm2 restart coc-website

# 重启 Explorer
pm2 restart coc-explorer

# 等待几秒后检查状态
sleep 3
pm2 list | grep -E "coc-website|coc-explorer"
```

---

## ✅ 验证部署成功

### 检查 1: 进程状态

```bash
pm2 list

# 预期输出: 两个进程都应显示 "online" 状态
# │ coc-website     │ npm           │ online │
# │ coc-explorer    │ npm           │ online │
```

### 检查 2: RPC 连接测试

```bash
# 测试 RPC 节点是否响应
curl -X POST http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# 预期输出类似:
# {"jsonrpc":"2.0","result":"0x4944","id":1}
```

### 检查 3: 浏览器访问测试

在浏览器中访问：

```
https://clawchain.io       # Website
https://explorer.clawchain.io  # Explorer
```

**检查项**:
- ✅ 页面能否正常加载
- ✅ Explorer 能否显示区块数据
- ✅ 没有 500 错误或白屏

### 检查 4: 查看日志

```bash
# 查看 Website 日志
pm2 logs coc-website | tail -20

# 查看 Explorer 日志
pm2 logs coc-explorer | tail -20

# 如果有错误，检查 RPC 连接相关信息
```

---

## 🐛 故障排查

### 问题 1: Explorer 显示白屏或 500 错误

**原因**: SSR 时 RPC 连接失败

**解决方案**:

```bash
# 1. 检查 .env.local 是否存在且正确
cat /root/clawd/COC/explorer/.env.local

# 2. 检查 RPC 节点是否响应
curl -X POST http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq .

# 3. 查看 Explorer 日志中的错误
pm2 logs coc-explorer | tail -50

# 4. 如果 RPC 不响应，检查节点状态
ps aux | grep "node.*src/index.ts" | grep -v grep
```

### 问题 2: Website 无法访问 Explorer 链接

**原因**: 链接地址错误或域名未指向正确服务器

**检查**:

```bash
# 验证 DNS 解析
dig explorer.chainofclaw.io

# 验证 HTTPS 证书
curl -I https://explorer.chainofclaw.io

# 检查 Nginx 配置
cat /etc/nginx/sites-available/explorer.chainofclaw.io
```

### 问题 3: 重启后进程未启动

**解决方案**:

```bash
# 查看 PM2 进程列表
pm2 list

# 如果进程显示 "stopped" 或 "errored"，手动启动
pm2 start coc-website
pm2 start coc-explorer

# 查看启动错误
pm2 logs coc-explorer --lines 100
```

---

## 📊 性能验证

### 延迟测试

```bash
# 测试客户端 RPC 响应时间
time curl -X POST https://clawchain.io/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null

# 预期: < 500ms
```

### 并发测试

```bash
# 使用 Apache Bench 测试并发能力
ab -n 100 -c 10 https://explorer.chainofclaw.io/

# 预期: 无 5xx 错误，成功率 100%
```

---

## 🔄 更新流程（未来使用）

每次更新代码时，执行以下步骤：

```bash
# 1. 在本地完成开发和测试
git add .
git commit -m "feat: xxx"
git push origin main

# 2. 执行部署脚本
bash scripts/deploy-to-server.sh

# 3. 验证部署成功
# 访问 https://explorer.chainofclaw.io 检查

# 完成！
```

---

## 📝 环境变量说明

### 二重 RPC 配置

Explorer 使用两套 RPC 地址：

| 用途 | 变量 | 值 | 说明 |
|------|------|-----|------|
| 客户端请求 | `NEXT_PUBLIC_RPC_URL` | `https://clawchain.io/api/rpc` | 浏览器 JavaScript 使用，通过 Nginx 反向代理 |
| 服务端渲染 | `COC_RPC_URL` | `http://127.0.0.1:18780` | Next.js SSR 使用，直接访问本地 RPC 节点 |

这种设计确保：
- ✅ SSR 速度快（不走网络）
- ✅ 浏览器能访问 RPC（公网地址）
- ✅ 避免 CORS 问题（通过 Nginx 代理）

---

## 🎯 部署完成检查清单

部署完成后，请确认以下所有项都已完成：

- [ ] 代码已同步到服务器
- [ ] npm 依赖已安装
- [ ] 应用已重新构建
- [ ] PM2 进程已重启
- [ ] .env.local 文件已验证
- [ ] Website 可以访问 (https://clawchain.io)
- [ ] Explorer 可以访问 (https://explorer.chainofclaw.io)
- [ ] Explorer 能显示区块数据（不是白屏）
- [ ] 没有 500 错误或 RPC 连接错误
- [ ] 日志中没有异常错误

---

## 📞 需要帮助？

如果部署过程中遇到问题，请：

1. 查看对应服务的日志：`pm2 logs <service-name>`
2. 检查 RPC 连接是否正常
3. 验证 .env.local 文件配置是否正确
4. 确认 Nginx 反向代理配置无误

**快速诊断命令**:

```bash
# 一键诊断所有服务
pm2 list && \
echo "---" && \
curl -s http://localhost:18780 -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq . && \
echo "---" && \
sudo nginx -t
```

---

**部署文档版本**: 1.0
**更新日期**: 2026-03-16
**维护者**: Claude Code

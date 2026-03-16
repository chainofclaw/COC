# 🎯 部署摘要 - Explorer 错误修复

**日期**: 2026-03-16
**问题**: Explorer 显示 500 错误：无法显示正确网页内容
**根因**: SSR 时 RPC 地址配置错误

---

## ✅ 已完成

### 1. Website Explorer 链接更新 ✅
- **更改**: `https://explorer.clawchain.io` → `https://explorer.chainofclaw.io`
- **位置**:
  - [layout.tsx:67](website/src/app/[locale]/layout.tsx#L67) - 导航栏
  - [layout.tsx:127](website/src/app/[locale]/layout.tsx#L127) - Footer
  - [page.tsx:56](website/src/app/[locale]/page.tsx#L56) - 主页 CTA
- **提交**: `fix: update explorer domain from clawchain.io to chainofclaw.io`

### 2. 环境配置文件创建 ✅
- **website/.env.local** 已创建（含 RPC 环境变量）
- **explorer/.env.local** 已创建（含 RPC 环境变量）
- ⚠️ 注意：这些文件被 `.gitignore` 保护，不提交到 GitHub（安全最佳实践）

### 3. 自动化部署脚本 ✅
- **scripts/deploy-to-server.sh** - 一键部署脚本
- **DEPLOY_GUIDE.md** - 详细部署指南

---

## 🚀 待执行：部署到生产服务器

### 快速执行（推荐）

```bash
# 进入项目根目录
cd /passinger/projects/ClawdBot/COC

# 执行自动化部署脚本
bash scripts/deploy-to-server.sh
```

**脚本将自动完成**:
1. ✅ 同步 website 代码到服务器 `/root/clawd/COC/website/`
2. ✅ 同步 explorer 代码到服务器 `/root/clawd/COC/explorer/`
3. ✅ 在服务器上安装依赖 (`npm install`)
4. ✅ 重新构建应用 (`npm run build`)
5. ✅ 重启 PM2 进程

### 或手动执行

如果脚本不可用，按以下步骤手动同步：

```bash
# 1️⃣ 同步代码
rsync -avz --exclude node_modules --exclude .next website/ \
  root@159.198.44.136:/root/clawd/COC/website/

rsync -avz --exclude node_modules --exclude .next explorer/ \
  root@159.198.44.136:/root/clawd/COC/explorer/

# 2️⃣ SSH 连接到服务器
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136

# 3️⃣ 在服务器上执行（连接后）
cd /root/clawd/COC/website && npm install && npm run build
cd /root/clawd/COC/explorer && npm install && npm run build

# 4️⃣ 重启服务
pm2 restart coc-website coc-explorer
```

---

## 📋 环境变量配置

**location**: `/root/clawd/COC/explorer/.env.local` (在服务器上)

```bash
# 客户端请求（公网 HTTPS）
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/ws

# 服务端渲染（内部 localhost）
COC_RPC_URL=http://127.0.0.1:18780
```

**说明**:
- `NEXT_PUBLIC_RPC_URL` - 浏览器 JS 使用，通过 Nginx 反向代理
- `COC_RPC_URL` - Next.js SSR 时使用，直接访问本地 RPC 节点

---

## ✅ 验证部署成功

部署完成后，执行以下验证：

### 1. 检查进程状态
```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 'pm2 list | grep -E "coc-website|coc-explorer"'
```
**预期**: 两个进程都显示 `online`

### 2. 测试 RPC 连接
```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 \
  'curl -X POST http://localhost:18780 \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}" | jq .'
```
**预期**: 返回当前区块号，无错误

### 3. 访问网站
```
https://clawchain.io       ✅ Website
https://explorer.chainofclaw.io  ✅ Explorer (检查是否显示区块数据，无 500 错误)
```

### 4. 查看错误日志
```bash
# 如果有问题，查看日志
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 'pm2 logs coc-explorer | tail -50'
```

---

## 🐛 常见问题排查

### Explorer 仍显示 500 错误？

**检查 1**: .env.local 文件是否存在
```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 \
  'test -f /root/clawd/COC/explorer/.env.local && echo "✅ 文件存在" || echo "❌ 文件不存在"'
```

**检查 2**: RPC 节点是否运行
```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 \
  'curl -s -X POST http://localhost:18780 -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}" | grep -q result && echo "✅ RPC OK" || echo "❌ RPC 失败"'
```

**检查 3**: 重启 Explorer 进程
```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 'pm2 restart coc-explorer && sleep 2 && pm2 logs coc-explorer | tail -20'
```

---

## 📊 部署对比表

| 项目 | 旧链接 | 新链接 | 状态 |
|------|--------|--------|------|
| Website 导航栏 | `clawchain.io` | `chainofclaw.io` | ✅ 更新 |
| Website Footer | `clawchain.io` | `chainofclaw.io` | ✅ 更新 |
| 主页 CTA | `clawchain.io` | `chainofclaw.io` | ✅ 更新 |
| Explorer .env.local | ❌ 无 | ✅ 已创建 | ✅ 完成 |
| RPC 配置 | 默认值 (localhost) | 环境变量 | ✅ 正确 |

---

## 🔄 下一步

1. ✅ **立即**: 执行部署脚本或手动同步
2. ✅ **验证**: 访问 https://explorer.chainofclaw.io 检查
3. ✅ **确认**: 能看到区块数据，无 500 错误

---

**部署预计耗时**: 5-10 分钟
**影响范围**: Website + Explorer
**回滚方案**: 使用 PM2 回滚到上个版本 (`pm2 restart <process>`)

更多详情请参考: [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md)

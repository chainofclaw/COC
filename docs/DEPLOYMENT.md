# COC 项目生产部署文档

**更新日期**: 2026-03-15
**部署环境**: Ubuntu 24.04 LTS
**服务器**: root@159.198.44.136
**域名**: clawchain.io

---

## 📋 部署概览

### 已部署服务

| 服务 | 域名 | 端口 | 状态 | 证书 |
|------|------|------|------|------|
| Website (Next.js) | https://clawchain.io | 3001 | ✅ 运行中 | Let's Encrypt (通配符) |
| Block Explorer | https://explorer.clawchain.io | 3000 | ✅ 运行中 | Let's Encrypt (通配符) |
| IPFS Demo | https://ipfs.clawchain.io | 3002 | ✅ 运行中 | Let's Encrypt (通配符) |
| Faucet | https://faucet.clawchain.io | 3003 | ✅ 运行中 | Let's Encrypt (通配符) |
| Blockchain Node | RPC: :18780 | 18780 | ✅ 运行中 | N/A |
| P2P Network | :19780 | 19780 | ✅ 运行中 | N/A |
| WebSocket | :18781 | 18781 | ✅ 运行中 | N/A |

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                  互联网 (Port 443/80)                             │
│         *.clawchain.io 通配符 DNS 解析 → 159.198.44.136           │
└────┬────────────────────┬────────────────────┬────────────────┘
     │                    │                    │
   ┌─▼──────────┐  ┌─────▼──────┐  ┌──────────▼──┐
   │ Nginx      │  │ Nginx      │  │ Nginx       │
   │ clawchain. │  │ explorer.  │  │ ipfs./      │
   │ io         │  │ clawchain. │  │ faucet.     │
   └─┬──────────┘  └─────┬──────┘  │ clawchain.io│
     │ (HTTPS)           │ (HTTPS) └──────┬──────┘
     │                   │                │
   ┌─▼──────────┐  ┌─────▼──────┐  ┌──────────┬──────────┐
   │ Next.js    │  │ Next.js    │  │ Next.js  │ Express  │
   │ Website    │  │ Explorer   │  │ IPFS     │ Faucet   │
   │ :3001      │  │ :3000      │  │ Demo     │ :3003    │
   │            │  │            │  │ :3002    │          │
   └─┬──────────┘  └─────┬──────┘  └──────────┴──────────┘
     │                   │              │
     └───────────────────┴──────────────┘
              │
         ┌────▼──────────────────┐
         │ COC Blockchain Node    │
         │ RPC: localhost:18780   │
         │ P2P: localhost:19780   │
         │ WS:  localhost:18781   │
         │ IPFS: localhost:5001   │
         └───────────────────────┘
```

---

## 📂 服务文件位置

### Website (Next.js)
```
代码: /root/clawd/COC/website
配置: /root/clawd/COC/website/.env.local
进程: pm2 (name: coc-website)
日志: pm2 logs coc-website
```

**环境变量** (.env.local):
```
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/ws
COC_RPC_URL=http://127.0.0.1:18780
```

### Block Explorer
```
代码: /root/clawd/COC/explorer
配置: /root/clawd/COC/explorer/.env.local
进程: pm2 (name: coc-explorer)
日志: pm2 logs coc-explorer
```

**环境变量** (.env.local):
```
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/ws
```

### IPFS Demo
```
代码: /root/clawd/COC/ipfs-demo
配置: 无单独 .env
进程: pm2 (name: coc-ipfs)
日志: pm2 logs coc-ipfs
启动: npx next start -p 3002
```

**说明**: ipfs-demo 演示应用展示 IPFS 文件存储和检索功能。默认端口 3001 与 Website 冲突，已配置为 3002。

### Faucet
```
代码: /root/clawd/COC/faucet
配置: /root/clawd/COC/faucet/.env.local
进程: pm2 (name: coc-faucet)
日志: pm2 logs coc-faucet
启动: npm start
```

**环境变量** (.env.local):
```
COC_FAUCET_PORT=3003
COC_FAUCET_RPC_URL=http://127.0.0.1:18780
COC_FAUCET_PRIVATE_KEY=0x3dfb554f747c34e38a573c524479225f1e951788ebc47539f6bce4a6ed8a5265
COC_FAUCET_DRIP_AMOUNT=10
COC_FAUCET_COOLDOWN_MS=86400000
```

**说明**: 水龙头服务提供免费的 COC 测试代币。私钥需要对应的钱包地址已获得足够的 COC 代币才能正常工作。

### Blockchain Node
```
代码: /passinger/projects/ClawdBot/COC/node
启动: node --experimental-strip-types node/src/index.ts
数据: /root/coc-data (LevelDB 存储)
配置: 环境变量 (COC_RPC_PORT, COC_P2P_PORT 等)
```

### Nginx 配置
```
网站: /etc/nginx/sites-available/clawchain.io
浏览器: /etc/nginx/sites-available/explorer.clawchain.io
IPFS: /etc/nginx/sites-available/ipfs.clawchain.io
水龙头: /etc/nginx/sites-available/faucet.clawchain.io
启用链接: /etc/nginx/sites-enabled/
```

---

## 🚀 快速命令

### PM2 进程管理
```bash
# 查看所有进程
pm2 list

# 查看进程日志
pm2 logs coc-website
pm2 logs coc-explorer
pm2 logs coc-ipfs
pm2 logs coc-faucet

# 重启服务
pm2 restart coc-website
pm2 restart coc-explorer
pm2 restart coc-ipfs
pm2 restart coc-faucet

# 停止/启动
pm2 stop coc-website
pm2 start coc-website

# 停止所有服务
pm2 stop all

# 启动所有服务
pm2 start all
```

### Nginx 管理
```bash
# 检查配置
sudo nginx -t

# 重新加载配置
sudo systemctl reload nginx

# 查看状态
sudo systemctl status nginx

# 查看日志
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Blockchain Node
```bash
# 通过 RPC 检查节点状态
curl -X POST http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# 监听日志
ps aux | grep "node.*src/index.ts"
```

---

## 🔐 SSL 证书

### 当前状态

**通配符证书**
```
证书: /etc/letsencrypt/live/clawchain.io/
发布者: Let's Encrypt
有效期: 至 2026-05-13
包含域名: *.clawchain.io 及 clawchain.io
状态: ✅ 已启用（所有子域名已覆盖）
```

### 子域名证书映射

由于已使用通配符证书 `*.clawchain.io`，所有子域名均自动获得有效证书：

```
clawchain.io         → Let's Encrypt 通配符证书
explorer.clawchain.io → Let's Encrypt 通配符证书
ipfs.clawchain.io    → Let's Encrypt 通配符证书
faucet.clawchain.io  → Let's Encrypt 通配符证书
```

### 证书验证

检查通配符证书包含的所有域名：

```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136

# 查看证书信息
openssl x509 -in /etc/letsencrypt/live/clawchain.io/fullchain.pem \
  -noout -text | grep "Subject Alternative Name"

# 检查证书有效期
certbot certificates
```

---

## 🔧 Nginx 配置详情

### clawchain.io → Website
```nginx
server {
    listen 443 ssl http2;
    server_name clawchain.io www.clawchain.io;

    ssl_certificate /etc/letsencrypt/live/clawchain.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clawchain.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/rpc {
        proxy_pass http://127.0.0.1:18780;
    }
}

# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name clawchain.io www.clawchain.io;
    return 301 https://$server_name$request_uri;
}
```

### explorer.clawchain.io → Block Explorer
```nginx
server {
    listen 443 ssl http2;
    server_name explorer.clawchain.io;

    ssl_certificate /etc/letsencrypt/live/clawchain.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clawchain.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name explorer.clawchain.io;
    return 301 https://$server_name$request_uri;
}
```

### ipfs.clawchain.io → IPFS Demo
```nginx
server {
    listen 443 ssl http2;
    server_name ipfs.clawchain.io;

    ssl_certificate /etc/letsencrypt/live/clawchain.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clawchain.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name ipfs.clawchain.io;
    return 301 https://$server_name$request_uri;
}
```

### faucet.clawchain.io → Faucet
```nginx
server {
    listen 443 ssl http2;
    server_name faucet.clawchain.io;

    ssl_certificate /etc/letsencrypt/live/clawchain.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clawchain.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name faucet.clawchain.io;
    return 301 https://$server_name$request_uri;
}
```

---

## 🌐 网络配置

### 域名解析
```
clawchain.io      A 159.198.44.136
*.clawchain.io    A 159.198.44.136  (待通配符证书)
```

### 防火墙规则（服务器已打开）
- Port 80 (HTTP)
- Port 443 (HTTPS)
- Port 18780 (RPC - 仅内部)
- Port 19780 (P2P - 仅内部)
- Port 18781 (WebSocket - 仅内部)

---

## 📊 性能优化

### Rate Limiting（已实施）
为防止 429 Too Many Requests 错误：

**Website**:
- 网络统计页面轮询间隔: 15 秒（降低 83%）
- RPC 调用指数退避: 5s → 10s → 30s → 60s

**文件位置**:
- `website/src/lib/rpc.ts` - 退避逻辑
- `website/src/components/NetworkStats.tsx` - 轮询间隔
- `website/src/app/[locale]/network/page.tsx` - 轮询间隔

### 缓存策略
- Nginx 缓存: 已配置 HSTS 和防缓存头
- Next.js: 使用 ISR (Incremental Static Regeneration)
- Explorer: WebSocket 实时更新

---

## 🐛 故障排查

### 网站无法访问
```bash
# 检查 Nginx
sudo systemctl status nginx
sudo nginx -t
sudo tail -f /var/log/nginx/error.log

# 检查 PM2 进程
pm2 list
pm2 logs coc-website
```

### 浏览器连接失败
```bash
# 检查浏览器进程
pm2 logs coc-explorer

# 检查 RPC 连接
curl -X POST http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

### IPFS Demo 无法访问
```bash
# 检查 IPFS Demo 进程
pm2 logs coc-ipfs

# 检查服务监听端口
ss -ltnp | grep 3002

# 检查 Nginx 反向代理
curl -v https://ipfs.clawchain.io
```

### Faucet 无法领取代币
```bash
# 检查 Faucet 进程
pm2 logs coc-faucet

# 检查私钥配置（不显示具体内容）
grep "COC_FAUCET_PRIVATE_KEY" /root/clawd/COC/faucet/.env.local | wc -c

# 检查服务监听端口
ss -ltnp | grep 3003

# 检查钱包余额（假设私钥对应的地址为 0x...）
curl -X POST http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x<钱包地址>","latest"],"id":1}'
```

### SSL 证书错误
```bash
# 查看证书信息
openssl x509 -in /etc/letsencrypt/live/clawchain.io/fullchain.pem \
  -noout -dates -subject -issuer

# 检查证书有效期
certbot certificates
```

### DNS 解析问题
```bash
# 检查 DNS 记录
dig clawchain.io
dig explorer.clawchain.io
dig _acme-challenge.clawchain.io TXT
```

---

## 📝 部署历史

| 日期 | 内容 | 状态 |
|------|------|------|
| 2026-03-15 | Website 部署 + RPC 端口修复 (28780→18780) | ✅ 完成 |
| 2026-03-15 | Block Explorer 部署 + .env.local 配置 | ✅ 完成 |
| 2026-03-15 | 429 Rate Limiting 修复 | ✅ 完成 |
| 2026-03-15 | 通配符证书申请完成 (*.clawchain.io) | ✅ 完成 |
| 2026-03-15 | IPFS Demo 首次部署 (端口 3002) | ✅ 完成 |
| 2026-03-15 | Faucet 首次部署 (端口 3003) + 私钥配置 | ✅ 完成 |
| 2026-03-15 | IPFS/Faucet Nginx 配置 + SSL 证书启用 | ✅ 完成 |
| 2026-03-15 | 网站域名更新 (explorer/ipfs 子域名更新) | ✅ 完成 |

---

## 🎯 后续步骤

### 立即（Faucet 水龙头配置）
1. ⏳ 使用私钥 `0x3dfb554f747c34e38a573c524479225f1e951788ebc47539f6bce4a6ed8a5265` 导入到钱包工具获取对应地址
2. ⏳ 向该地址转入足够的 COC 代币（推荐至少 100 COC）
3. ✅ 验证 Faucet 正常工作：访问 https://faucet.clawchain.io

### 测试验证
- ✅ Website: https://clawchain.io （所有本地化页面，RPC 集成）
- ✅ Explorer: https://explorer.clawchain.io （区块链浏览器）
- ✅ IPFS Demo: https://ipfs.clawchain.io （分布式存储演示）
- ✅ Faucet: https://faucet.clawchain.io （测试代币领取）
- ✅ 所有 HTTPS 连接使用 Let's Encrypt 通配符证书

### 性能优化和监控
- [ ] 启用 PM2 Plus 实时监控和告警
- [ ] 配置自动化日志轮转 (logrotate)
- [ ] 设置定期备份脚本
- [ ] 配置 CDN (Cloudflare) 加速全球访问
- [ ] 部署 CI/CD 管道 (GitHub Actions)
- [ ] 设置监控告警 (Grafana/Prometheus)

### 安全加固
- [ ] 启用 Nginx WAF (ModSecurity)
- [ ] 配置 rate limiting 规则
- [ ] 定期更新依赖包 (npm audit)
- [ ] 配置防火墙更严格的出站规则
- [ ] 定期安全审计和漏洞扫描

---

## 📞 联系方式

**服务器访问**:
```bash
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136
```

**快速诊断命令**:
```bash
# 一键检查所有服务
pm2 list && echo "---" && sudo nginx -t && echo "---" && \
  curl -X POST http://localhost:18780 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq .

# 验证 HTTPS 访问
curl -s https://clawchain.io | grep -o "<title>[^<]*"
curl -sk https://explorer.clawchain.io | grep -o "<title>[^<]*"
curl -sk https://ipfs.clawchain.io | grep -o "<title>[^<]*"
curl -s https://faucet.clawchain.io/health
```

## 📋 部署清单

全部 4 个服务已部署到生产环境：

- [x] **Website** (Next.js) - https://clawchain.io:3001
- [x] **Block Explorer** (Next.js) - https://explorer.clawchain.io:3000
- [x] **IPFS Demo** (Next.js) - https://ipfs.clawchain.io:3002
- [x] **Faucet** (Express) - https://faucet.clawchain.io:3003
- [x] **通配符 SSL 证书** - *.clawchain.io (Let's Encrypt)
- [x] **所有服务** PM2 进程管理
- [x] **Nginx 反向代理** - HTTP → HTTPS 重定向

---

**文档版本**: 2.0
**最后更新**: 2026-03-15 16:30 UTC+7
**状态**: ✅ 全部部署完成，待 Faucet 钱包配置

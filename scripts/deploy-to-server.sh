#!/bin/bash
# 部署脚本：同步代码和配置到生产服务器
# 使用方法: bash scripts/deploy-to-server.sh

set -e

SERVER="root@159.198.44.136"
REMOTE_BASE="/root/clawd/COC"
SSH_KEY=~/.ssh/openclaw_server_key

echo "🚀 开始同步到生产服务器: $SERVER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. 同步 Website
echo "📦 [1/3] 同步 Website 代码..."
rsync -avz \
  --exclude node_modules \
  --exclude .next \
  --exclude .env \
  -e "ssh -i $SSH_KEY" \
  website/ \
  $SERVER:$REMOTE_BASE/website/

echo "✅ Website 代码同步完成"
echo ""

# 2. 同步 Explorer
echo "📦 [2/3] 同步 Explorer 代码..."
rsync -avz \
  --exclude node_modules \
  --exclude .next \
  --exclude .env \
  -e "ssh -i $SSH_KEY" \
  explorer/ \
  $SERVER:$REMOTE_BASE/explorer/

echo "✅ Explorer 代码同步完成"
echo ""

# 3. 部署和重启
echo "🔄 [3/3] 在服务器上更新依赖和重启服务..."
ssh -i $SSH_KEY $SERVER << 'EOF'
set -e

echo "📥 安装依赖..."
cd /root/clawd/COC/website && npm install --prefer-offline --no-audit
cd /root/clawd/COC/explorer && npm install --prefer-offline --no-audit

echo "🔨 重新构建..."
cd /root/clawd/COC/website && npm run build
cd /root/clawd/COC/explorer && npm run build

echo "🔄 重启 PM2 进程..."
pm2 restart coc-website
pm2 restart coc-explorer

echo "⏳ 等待服务启动..."
sleep 3

echo "✅ 服务已重启"
echo ""
echo "📊 进程状态:"
pm2 list | grep -E "coc-website|coc-explorer"

EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 部署完成！"
echo ""
echo "🔗 验证访问:"
echo "  • Website:  https://clawchain.io"
echo "  • Explorer: https://explorer.clawchain.io"
echo ""
echo "📋 查看日志:"
echo "  ssh -i $SSH_KEY $SERVER 'pm2 logs coc-website'"
echo "  ssh -i $SSH_KEY $SERVER 'pm2 logs coc-explorer'"

#!/usr/bin/env bash
# ============================================================
#  QQ 机器人托管平台 - 服务器一键部署脚本
#  用法: sudo bash deploy/setup-server.sh
#  要求: Linux x64（建议 Ubuntu/Debian/OpenCloudOS 等），root 权限
# ============================================================
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "=== [1/7] 检查 Node.js（需要 24+，平台使用内置 node:sqlite） ==="
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  if [ "$MAJOR" -lt 24 ]; then NEED_NODE=1; fi
fi
if [ "$NEED_NODE" = "1" ]; then
  echo "安装 Node.js 24 ..."
  cd /tmp
  curl -fsSL https://registry.npmmirror.com/-/binary/node/v24.16.0/node-v24.16.0-linux-x64.tar.xz -o node24.tar.xz
  rm -rf /usr/local/lib/node_modules   # 清理旧 npm，防止新旧混装报错
  tar -xJf node24.tar.xz -C /usr/local --strip-components=1
  rm -f node24.tar.xz
  cd "$APP_DIR"
fi
echo "Node 版本: $(node -v)"

echo "=== [2/7] 安装依赖 ==="
if [ ! -d node_modules ]; then
  npm install --registry=https://registry.npmmirror.com
fi

echo "=== [3/7] 配置域名与 HTTPS 证书（Let's Encrypt） ==="
read -p "请输入访问域名（中文域名请先转 punycode，如 ai.xn--xxxx.site）: " DOMAIN
[ -n "$DOMAIN" ] || { echo "域名不能为空"; exit 1; }
CERT_DIR=/etc/nginx/ssl/qqbot-platform

if [ ! -f "$CERT_DIR/server.crt" ]; then
  if [ ! -x /root/.acme.sh/acme.sh ]; then
    echo "安装 acme.sh ..."
    curl -fsSL https://gitee.com/neilpang/acme.sh/raw/master/acme.sh -o /tmp/acme-install.sh
    sh /tmp/acme-install.sh --install-online -m admin@example.com
  fi
  mkdir -p "$CERT_DIR"
  # 80 端口被占用时（如宝塔 nginx）临时停掉，验证完恢复
  NGINX_STOPPED=0
  if systemctl is-active --quiet nginx 2>/dev/null; then
    systemctl stop nginx
    NGINX_STOPPED=1
  fi
  /root/.acme.sh/acme.sh --issue --standalone -d "$DOMAIN" --server letsencrypt
  if [ "$NGINX_STOPPED" = "1" ]; then systemctl start nginx; fi
  /root/.acme.sh/acme.sh --install-cert -d "$DOMAIN" \
    --key-file "$CERT_DIR/server.key" \
    --fullchain-file "$CERT_DIR/server.crt" \
    --reloadcmd "systemctl reload nginx"
  echo "证书签发并安装完成（自动续期已配置）"
else
  echo "证书已存在，跳过签发"
fi

echo "=== [4/7] 配置 nginx 反向代理 ==="
if command -v nginx >/dev/null 2>&1; then
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__CERT_DIR__|$CERT_DIR|g" \
    deploy/nginx-vhost.conf > /etc/nginx/conf.d/qqbot-platform.conf
  nginx -t && systemctl reload nginx
  echo "nginx 已配置（80 自动跳转 443）"
else
  echo "未检测到 nginx，跳过反代（如需直连：把服务文件 Environment=PORT=3000 改为 443）"
fi

echo "=== [5/7] 安装 systemd 服务（开机自启 + 崩溃自动重启） ==="
sed "s|__APP_DIR__|$APP_DIR|g" deploy/qqbot-platform.service > /etc/systemd/system/qqbot-platform.service
systemctl daemon-reload
systemctl enable qqbot-platform

echo "=== [6/7] 启动 ==="
systemctl restart qqbot-platform
sleep 4
systemctl is-active qqbot-platform

echo "=== [7/7] 部署完成 ==="
echo ""
echo "  访问地址: https://$DOMAIN"
echo "  查看日志: tail -f $APP_DIR/data/bot.log"
echo "  重启平台: systemctl restart qqbot-platform"
echo ""
echo "首次访问请注册账号，然后在管理面板中创建机器人并填写"
echo "QQ AppID/AppSecret 与 AI 接口信息即可使用。"

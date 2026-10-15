#!/usr/bin/env bash
# Ubuntu 22.04/24.04 の VM で、/opt/agent-guild に clone した状態から実行する。
#   sudo bash /opt/agent-guild/deploy/setup.sh
# 再実行すると依存の更新・再ビルド・設定の再配置・再起動を行う。data/ とバックアップは変更しない。
set -euo pipefail
app=/opt/agent-guild
conf=/etc/agent-guild
[ "$(id -u)" = 0 ] || { echo 'root で実行してください。'; exit 1; }
[ -f "$app/package.json" ] || { echo "$app にリポジトリを clone してください。"; exit 1; }
# 設定の検査はホストを変更する処理（apt・swap・ユーザー作成・配置・サービス操作）より前に行う。
bash "$app/deploy/preflight.sh" "$conf"

export DEBIAN_FRONTEND=noninteractive
# 1 GB の無料 VM ではビルドがメモリ不足になり得るため、swap がなければ 2 GB 作る。
if [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 2000000 ] && [ -z "$(swapon --noheadings)" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if ! node -v 2>/dev/null | grep -q '^v2[2-9]\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

id agentguild >/dev/null 2>&1 || useradd --system --home-dir "$app" --no-create-home --shell /usr/sbin/nologin agentguild
cd "$app"
npm ci --no-audit --no-fund
npm run build
install -d -o agentguild -g agentguild -m 700 "$app/data"
chown root:root "$conf"/*.env
chmod 600 "$conf"/*.env

install -m 644 deploy/agent-guild.service deploy/agent-guild-backup.service deploy/agent-guild-backup.timer /etc/systemd/system/
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s/caddy.env\n' "$conf" > /etc/systemd/system/caddy.service.d/agent-guild.conf

systemctl daemon-reload
systemctl enable agent-guild agent-guild-backup.timer caddy
systemctl restart agent-guild caddy
systemctl start agent-guild-backup.timer
systemctl --no-pager --lines=0 status agent-guild caddy
echo "完了: https://$(sed -n 's/^AGENT_GUILD_DOMAIN=//p' "$conf/caddy.env")"

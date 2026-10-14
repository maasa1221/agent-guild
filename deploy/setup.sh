#!/usr/bin/env bash
# Ubuntu 22.04/24.04 の VM で、/opt/agent-guild に clone した状態から実行する。
#   sudo bash /opt/agent-guild/deploy/setup.sh
# 再実行すると依存の更新・再ビルド・設定の再配置・再起動を行う。data/ とバックアップは変更しない。
set -euo pipefail
app=/opt/agent-guild
conf=/etc/agent-guild
[ "$(id -u)" = 0 ] || { echo 'root で実行してください。'; exit 1; }
[ -f "$app/package.json" ] || { echo "$app にリポジトリを clone してください。"; exit 1; }
for f in app.env caddy.env; do
  [ -f "$conf/$f" ] || { echo "$conf/$f がありません。deploy/$f.example を元に作成してください。"; exit 1; }
done
grep -q '^AGENT_GUILD_GITHUB_ORG=[A-Za-z0-9]' "$conf/app.env" || { echo 'app.env に AGENT_GUILD_GITHUB_ORG を設定してください。'; exit 1; }
grep -q '^AGENT_GUILD_ALLOWED_IPS=[0-9a-fA-F]' "$conf/caddy.env" || { echo 'caddy.env に AGENT_GUILD_ALLOWED_IPS を設定してください。'; exit 1; }

export DEBIAN_FRONTEND=noninteractive
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
chmod 755 "$app/deploy/backup.sh"

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

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
value() { sed -n "s/^$2=//p" "$conf/$1" | tail -n 1; }
for pair in app.env:AGENT_GUILD_ORIGIN app.env:AGENT_GUILD_GITHUB_CLIENT_ID app.env:AGENT_GUILD_GITHUB_CLIENT_SECRET app.env:AGENT_GUILD_GITHUB_ORG caddy.env:AGENT_GUILD_DOMAIN caddy.env:AGENT_GUILD_ALLOWED_IPS; do
  v=$(value "${pair%%:*}" "${pair#*:}")
  case "$v" in ''|*example*|your-org|203.0.113.*) echo "${pair%%:*} の ${pair#*:} を実際の値にしてください。"; exit 1;; esac
done
[ "$(value app.env AGENT_GUILD_ORIGIN)" = "https://$(value caddy.env AGENT_GUILD_DOMAIN)" ] || { echo 'AGENT_GUILD_ORIGIN は https://<AGENT_GUILD_DOMAIN> にしてください。'; exit 1; }

export DEBIAN_FRONTEND=noninteractive
# 1 GB の無料 VM ではビルドがメモリ不足になり得るため、swap がなければ 2 GB 作る。
if [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 2000000 ] && [ -z "$(swapon --noheadings)" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
. "$app/deploy/node-version.sh"
# サービスは /usr/bin/node で起動するため、その版を判定する。
if ! node_version_ok /usr/bin/node; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
# npm・ビルドが使う PATH 上の node と、サービスが使う /usr/bin/node の両方を確認してから進む。
for n in /usr/bin/node node; do
  node_version_ok "$n" || { echo "$n が Node.js $node_min 以上ではありません（現在: $("$n" -v 2>/dev/null || echo 未インストール)）。"; exit 1; }
done
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

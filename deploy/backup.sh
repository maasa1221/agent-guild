#!/usr/bin/env bash
# 停止中に data/ 全体をコピーする（docs/offline-recovery.md の手順）。数秒だけサービスが止まる。
set -euo pipefail
src=/opt/agent-guild/data
dest=/var/backups/agent-guild
keep=${AGENT_GUILD_BACKUP_KEEP:-14}
stamp=$(date +%Y%m%d-%H%M%S)

install -d -m 700 "$dest"
systemctl stop agent-guild
trap 'systemctl start agent-guild' EXIT
cp -a "$src" "$dest/$stamp.partial"
mv "$dest/$stamp.partial" "$dest/$stamp"
systemctl start agent-guild
trap - EXIT

# 古いものから、このスクリプトが作った日時名のバックアップだけを消す。
find "$dest" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]\{8\}-[0-9]\{6\}' | sort | head -n "-$keep" | xargs -r rm -rf --
echo "backup: $dest/$stamp"

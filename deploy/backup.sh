#!/usr/bin/env bash
# 停止中に data/ 全体をコピーする（docs/offline-recovery.md の手順）。数秒だけサービスが止まり、メモリ上のセッションは失効する。
set -euo pipefail
src=/opt/agent-guild/data
dest=/var/backups/agent-guild
keep=${AGENT_GUILD_BACKUP_KEEP:-14}
stamp=$(date +%Y%m%d-%H%M%S)

install -d -m 700 "$dest"
# 意図して止めているときは、バックアップ後も起動しない。
was_active=$(systemctl is-active agent-guild || true)
systemctl stop agent-guild
cleanup() {
  rm -rf -- "$dest/$stamp.partial"
  if [ "$was_active" = active ]; then systemctl start agent-guild; fi
}
trap cleanup EXIT
cp -a "$src" "$dest/$stamp.partial"
mv "$dest/$stamp.partial" "$dest/$stamp"

# 古いものから、このスクリプトが作った日時名のバックアップだけを消す。
find "$dest" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' | sort | head -n "-$keep" | xargs -r rm -rf --
echo "backup: $dest/$stamp"

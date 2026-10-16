#!/usr/bin/env bash
# 停止中に data/ 全体をコピーし、検査してから保存する（docs/offline-recovery.md の手順）。数秒だけサービスが止まり、メモリ上のセッションは失効する。
# 処理本体は backup-lib.sh。保存先と対象は本番の固定パスで、保持世代数（既定 14、1〜365）だけを環境変数で変えられる。
set -euo pipefail
app=/opt/agent-guild
. "$app/deploy/backup-lib.sh"
agent_guild_backup "$app/data" /var/backups/agent-guild "${AGENT_GUILD_BACKUP_KEEP:-14}" "$(date +%Y%m%d-%H%M%S)" \
  systemctl /usr/bin/node "$app/server/verify-backup.mjs"

# backup.sh から source する。テストは一時ディレクトリと偽の systemctl で同じ関数を呼ぶ。
# 保持世代数は 1〜agent_guild_backup_keep_max（日次で約1年分）の整数に限る。
agent_guild_backup_keep_max=365

agent_guild_backup_keep_ok() {
  [[ $1 =~ ^[1-9][0-9]{0,2}$ ]] && [ "$1" -le "$agent_guild_backup_keep_max" ]
}

# 絶対パスで、/ そのもの・末尾の / ・空要素・. / .. を含まないものだけを受け付ける。
agent_guild_backup_path_ok() {
  [[ $1 == /?* && $1 != */ && $1 != *//* && /$1/ != */./* && /$1/ != */../* ]]
}

# 引数: データディレクトリ 保存先 保持世代数 日時名(YYYYmmdd-HHMMSS) systemctl node verify-backup.mjs
# サービスを止めて data/ をコピーし、検査に通ったコピーだけを <保存先>/<日時名> として公開してから古い世代を消す。
# 失敗時はこの実行の .partial だけを消し、既存の世代や別の .partial は残す。
# 開始時に動いていたサービスだけを起動し直し、意図して止めていたサービスは起動しない。
agent_guild_backup() (
  set -euo pipefail
  src=$1 dest=$2 keep=$3 stamp=$4 systemctl=$5 node=$6 verifier=$7
  service=agent-guild
  fail() { echo "backup: $*" >&2; exit 1; }

  # サービスとファイルを変更する前に、すべての入力を検査する。
  agent_guild_backup_keep_ok "$keep" || fail "AGENT_GUILD_BACKUP_KEEP は 1〜$agent_guild_backup_keep_max の整数で指定してください。"
  [[ $stamp =~ ^[0-9]{8}-[0-9]{6}$ ]] || fail '日時名の形式が正しくありません。'
  agent_guild_backup_path_ok "$src" && agent_guild_backup_path_ok "$dest" || fail 'データディレクトリと保存先は絶対パスで指定してください。'
  case "$dest/" in "$src/"*) fail '保存先をデータディレクトリの中に置けません。' ;; esac
  case "$src/" in "$dest/"*) fail 'データディレクトリを保存先の中に置けません。' ;; esac
  [ -d "$src" ] && [ ! -L "$src" ] || fail 'データディレクトリがありません。'
  [ -f "$verifier" ] && [ -x "$node" ] || fail '検査スクリプトまたは node がありません。'
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    [ -d "$dest" ] && [ ! -L "$dest" ] || fail '保存先がディレクトリではありません。'
  fi
  final=$dest/$stamp
  partial=$final.partial
  # 同じ日時名があれば、上書きや入れ子にせず中止する。
  if [ -e "$final" ] || [ -L "$final" ] || [ -e "$partial" ] || [ -L "$partial" ]; then
    fail "同じ日時名のバックアップが既にあります: $stamp"
  fi
  # 検査を通った保存先は、既存でも毎回 700 にして第三者から読めないようにする。
  install -d -m 700 -- "$dest"

  was_active=$("$systemctl" is-active "$service" || true)
  own_partial=
  restarted=
  cleanup() {
    local rc=$?
    if [ -n "$own_partial" ]; then rm -rf -- "$partial"; fi
    if [ "$was_active" = active ] && [ -z "$restarted" ]; then
      restarted=1
      "$systemctl" start "$service" || { echo "backup: $service の再起動に失敗しました。" >&2; rc=1; }
    fi
    exit "$rc"
  }
  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP

  "$systemctl" stop "$service" || fail "$service を停止できませんでした。"
  own_partial=1
  cp -a -- "$src" "$partial" || fail 'コピーに失敗しました。既存のバックアップは変更していません。'
  # 内容は表示せず、検査の段階名と件数だけを出す。
  "$node" --disable-warning=ExperimentalWarning "$verifier" "$partial" || fail '検査に失敗しました。既存のバックアップは変更していません。'
  [ ! -e "$final" ] && [ ! -L "$final" ] || fail "同じ日時名のバックアップが既にあります: $stamp"
  mv -T -- "$partial" "$final"
  own_partial=

  if [ "$was_active" = active ]; then
    restarted=1
    "$systemctl" start "$service" || fail "バックアップ $final は作成しましたが、$service の再起動に失敗しました。古い世代は削除していません。"
  fi

  # このスクリプトが作った日時名の世代だけを、今回の世代を除いて古いものから消す。
  mapfile -t older < <(find "$dest" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' ! -name "$stamp" -printf '%f\n' | LC_ALL=C sort)
  excess=$(( ${#older[@]} - (keep - 1) ))
  for ((i = 0; i < excess; i++)); do rm -rf -- "${dest:?}/${older[i]}"; done
  echo "backup: $final"
)

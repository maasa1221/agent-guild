#!/usr/bin/env bash
# setup.sh がホストを変更する前に、設定ファイルだけを読んで必須入力を検査する。
#   bash deploy/preflight.sh /etc/agent-guild
# 秘密値は表示しない。問題があれば項目名だけを出して 1 で終了する。
set -euo pipefail
conf=${1:?設定ディレクトリを指定してください。}
fail() { echo "$1"; exit 1; }
for f in app.env caddy.env; do
  [ -f "$conf/$f" ] || fail "$conf/$f がありません。deploy/$f.example を元に作成してください。"
done
value() { sed -n "s/^$2=//p" "$conf/$1" | tail -n 1; }
placeholder() { case "$1" in ''|*example*|your-org|203.0.113.*|198.51.100.*|192.0.2.*) return 0;; esac; return 1; }

for pair in app.env:AGENT_GUILD_ORIGIN app.env:AGENT_GUILD_GITHUB_CLIENT_ID app.env:AGENT_GUILD_GITHUB_CLIENT_SECRET app.env:AGENT_GUILD_GITHUB_ORG app.env:AGENT_GUILD_GOOGLE_CLIENT_ID app.env:AGENT_GUILD_GOOGLE_CLIENT_SECRET app.env:AGENT_GUILD_GOOGLE_DOMAINS caddy.env:AGENT_GUILD_DOMAIN caddy.env:AGENT_GUILD_ALLOWED_IPS; do
  placeholder "$(value "${pair%%:*}" "${pair#*:}")" && fail "${pair%%:*} の ${pair#*:} を実際の値にしてください。"
done

domain=$(value caddy.env AGENT_GUILD_DOMAIN)
[[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail 'caddy.env の AGENT_GUILD_DOMAIN は小文字のホスト名にしてください。'
[ "$(value app.env AGENT_GUILD_ORIGIN)" = "https://$domain" ] || fail 'AGENT_GUILD_ORIGIN は https://<AGENT_GUILD_DOMAIN> にしてください。'
[[ "$(value app.env AGENT_GUILD_GITHUB_ORG)" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] || fail 'app.env の AGENT_GUILD_GITHUB_ORG は GitHub の組織名にしてください。'

# 実行時の parseGoogleDomains と同じく、各項目の前後の空白だけを除く。途中の空白は除かずに拒否する。
# 末尾の空項目は read が落とすため、区切りだけの形は先に拒否する。
google_domains=$(value app.env AGENT_GUILD_GOOGLE_DOMAINS)
[[ "$google_domains" =~ ,[[:space:]]*$ ]] && fail 'app.env の AGENT_GUILD_GOOGLE_DOMAINS に空の項目があります。'
IFS=',' read -r -a domains <<< "$google_domains"
for d in "${domains[@]}"; do
  d="${d#"${d%%[![:space:]]*}"}"
  d="${d%"${d##*[![:space:]]}"}"
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] && [ "${#d}" -le 253 ] && ! placeholder "$d" || fail 'app.env の AGENT_GUILD_GOOGLE_DOMAINS は小文字の Workspace ドメインをカンマ区切りで指定してください。'
done

# 10 進の prefix。先頭の 0 と 0 自体（全体を許す範囲）は受け付けない。
prefix_ok() { [[ "$1" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$1" -le "$2" ]; }
# IPv4 は各 octet 0〜255。8 進と誤読される先頭 0（例: 010）は拒否する。
ipv4_ok() {
  local IFS=. octets o
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  read -r -a octets <<< "$1"
  for o in "${octets[@]}"; do [[ "$o" =~ ^(0|[1-9][0-9]{0,2})$ ]] && [ "$o" -le 255 ] || return 1; done
}
# IPv6 は 1〜4 桁の 16 進 group が 8 個。`::` は 1 回だけで、1 個以上の group を省略する。
# IPv4 埋め込み形式（::ffff:10.0.0.1 など）は受け付けない。
ipv6_groups() {
  local IFS=: groups g
  [ -z "$1" ] && { echo 0; return 0; }
  [[ "$1" == :* || "$1" == *: ]] && return 1
  read -r -a groups <<< "$1"
  for g in "${groups[@]}"; do [[ "$g" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1; done
  echo "${#groups[@]}"
}
ipv6_ok() {
  local left right n m
  [[ "$1" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
  if [[ "$1" == *::* ]]; then
    left=${1%%::*}; right=${1#*::}
    [[ "$right" == *::* ]] && return 1
    n=$(ipv6_groups "$left") || return 1
    m=$(ipv6_groups "$right") || return 1
    [ $((n+m)) -le 7 ]
  else
    n=$(ipv6_groups "$1") || return 1
    [ "$n" -eq 8 ]
  fi
}

# Caddy の remote_ip は直接の接続元だけを見る。全体を許す範囲や例示用の範囲は受け付けない。
read -r -a cidrs <<< "$(value caddy.env AGENT_GUILD_ALLOWED_IPS)"
[ "${#cidrs[@]}" -gt 0 ] || fail 'caddy.env の AGENT_GUILD_ALLOWED_IPS を空白区切りの社内 CIDR にしてください。'
for c in "${cidrs[@]}"; do
  placeholder "$c" && fail 'caddy.env の AGENT_GUILD_ALLOWED_IPS に例示用の範囲が含まれています。'
  address=${c%%/*}
  prefix=''
  [[ "$c" == */* ]] && prefix=${c#*/}
  if ipv4_ok "$address"; then max=32
  elif ipv6_ok "$address"; then max=128
  else fail 'caddy.env の AGENT_GUILD_ALLOWED_IPS は IP アドレスまたは CIDR を空白区切りで指定してください。'
  fi
  [[ "$c" == */* ]] && ! prefix_ok "$prefix" "$max" && fail 'caddy.env の AGENT_GUILD_ALLOWED_IPS に全体を許す範囲か不正な prefix があります。'
  lower=${address,,}
  case "$lower" in 0.0.0.0|::|2001:db8:*|2001:db8::*|2001:0db8:*) fail 'caddy.env の AGENT_GUILD_ALLOWED_IPS に未指定アドレスか例示用の範囲が含まれています。';; esac
done
echo '設定の事前確認: OK'

# setup.sh から source する。README の要件（Node.js 22.18 以上、node:sqlite のため）と揃える。
node_min_major=22
node_min_minor=18
node_min=$node_min_major.$node_min_minor.0

# 引数の node（既定は PATH 上の node）が vX.Y.Z の安定版で node_min 以上なら成功する。
node_version_ok() {
  local v
  v=$("${1:-node}" -v 2>/dev/null) || return 1
  [[ $v =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  local major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]}))
  [ "$major" -gt "$node_min_major" ] || { [ "$major" -eq "$node_min_major" ] && [ "$minor" -ge "$node_min_minor" ]; }
}

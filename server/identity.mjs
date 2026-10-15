// 利用者 ID は provider ごとに名前空間を分ける。GitHub は既存の数値 ID をそのまま使い、
// Google は検証済み ID token の sub に `google:` を付ける。メールアドレスでは統合しない。
const GITHUB_ID = /^[1-9][0-9]*$/;
const GOOGLE_SUB = /^[A-Za-z0-9_-]{1,255}$/;

export function googleUserId(sub) {
  return typeof sub==='string' && GOOGLE_SUB.test(sub) ? `google:${sub}` : null;
}

export function isUserId(id) {
  return typeof id==='string' && (GITHUB_ID.test(id) || (id.startsWith('google:') && GOOGLE_SUB.test(id.slice(7))));
}

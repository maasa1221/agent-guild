import {parseGoogleDomains} from './google.mjs';

const PLACEHOLDER=/(^|[.-])example([.-]|$)|^your-org$/i;

// 環境変数から認証・公開範囲の設定を作る。社内運用モードで欠落・一部設定・例示値があれば、
// 待ち受け前に例外で止める。値そのものはエラー文に含めない。
export function loadConfig(env) {
  const port=Number(env.PORT || 46077);
  const origin=env.AGENT_GUILD_ORIGIN || `http://127.0.0.1:${port}`;
  if (!['','0','1'].includes(env.AGENT_GUILD_INTERNAL||'')) throw new Error('AGENT_GUILD_INTERNAL は 1 または空にしてください。');
  let originUrl;
  try { originUrl=new URL(origin); } catch { throw new Error('AGENT_GUILD_ORIGIN の形式が正しくありません。'); }
  // HTTPS の公開先は、明示がなくても社内運用モードとして扱う。
  const internal=env.AGENT_GUILD_INTERNAL==='1' || originUrl.protocol==='https:';
  const github={clientId:env.AGENT_GUILD_GITHUB_CLIENT_ID||'',clientSecret:env.AGENT_GUILD_GITHUB_CLIENT_SECRET||''};
  const requiredOrg=env.AGENT_GUILD_GITHUB_ORG||'';
  const google={clientId:env.AGENT_GUILD_GOOGLE_CLIENT_ID||'',clientSecret:env.AGENT_GUILD_GOOGLE_CLIENT_SECRET||'',domains:env.AGENT_GUILD_GOOGLE_DOMAINS||''};
  const googleSet=[google.clientId,google.clientSecret,google.domains].filter(Boolean).length;
  if (googleSet && googleSet<3) throw new Error('Google ログインには AGENT_GUILD_GOOGLE_CLIENT_ID・AGENT_GUILD_GOOGLE_CLIENT_SECRET・AGENT_GUILD_GOOGLE_DOMAINS をすべて設定してください。');
  if (googleSet) google.domains=parseGoogleDomains(google.domains);
  if (internal) {
    const missing=[];
    if (originUrl.protocol!=='https:' || PLACEHOLDER.test(originUrl.hostname)) missing.push('AGENT_GUILD_ORIGIN');
    if (!github.clientId || PLACEHOLDER.test(github.clientId)) missing.push('AGENT_GUILD_GITHUB_CLIENT_ID');
    if (!github.clientSecret || PLACEHOLDER.test(github.clientSecret)) missing.push('AGENT_GUILD_GITHUB_CLIENT_SECRET');
    if (!requiredOrg || PLACEHOLDER.test(requiredOrg)) missing.push('AGENT_GUILD_GITHUB_ORG');
    if (!googleSet) missing.push('AGENT_GUILD_GOOGLE_CLIENT_ID','AGENT_GUILD_GOOGLE_CLIENT_SECRET','AGENT_GUILD_GOOGLE_DOMAINS');
    else {
      if (PLACEHOLDER.test(google.clientId)) missing.push('AGENT_GUILD_GOOGLE_CLIENT_ID');
      if (PLACEHOLDER.test(google.clientSecret)) missing.push('AGENT_GUILD_GOOGLE_CLIENT_SECRET');
      if ([...google.domains].some(domain=>PLACEHOLDER.test(domain))) missing.push('AGENT_GUILD_GOOGLE_DOMAINS');
    }
    if (missing.length) throw new Error(`社内運用モードでは次の設定を実際の値にしてください: ${missing.join(', ')}`);
  }
  // 組織・ドメインで利用者を絞る設定があるときは、閲覧を含めてログインを必須にする。
  const requireLogin=internal || env.AGENT_GUILD_REQUIRE_LOGIN==='1' || Boolean(requiredOrg) || Boolean(googleSet);
  return {port,origin,internal,requireLogin,github,requiredOrg,google:googleSet?google:null};
}

import {parseGoogleDomains} from './google.mjs';

const PLACEHOLDER=/(^|[.-])example([.-]|$)|^your-org$/i;
// OAuth の client ID と secret は、PLACEHOLDER に加えて、deploy/preflight.sh と同じく example を含むだけでも例示値として扱う。
// 大文字小文字は PLACEHOLDER と同じく区別しない。
const CREDENTIAL_PLACEHOLDER=/example|^your-org$/i;
// 投稿制限は 10 進の整数だけを受け付ける。先頭の + と 0、前後の空白とタブは許す。
// 小数・指数・16 進などの表記は deploy/preflight.sh と同じく拒否する。
const DECIMAL_INTEGER=/^[ \t]*\+?([0-9]+)[ \t]*$/;
const POSTING_LIMITS=[
  {key:'AGENT_GUILD_POST_LIMIT',name:'postLimit',fallback:5,min:1,max:100},
  {key:'AGENT_GUILD_POST_WINDOW_MS',name:'postWindowMs',fallback:60000,min:1000,max:86400000},
];

// 未設定と空文字は既定値にする。不正な項目は名前だけを返し、値はエラー文に含めない。
function parsePostingLimits(env) {
  const values={};
  const invalid=[];
  for (const {key,name,fallback,min,max} of POSTING_LIMITS) {
    const text=env[key];
    if (text===undefined || text==='') { values[name]=fallback; continue; }
    const digits=DECIMAL_INTEGER.exec(text)?.[1];
    const value=digits===undefined?NaN:Number(digits);
    if (Number.isSafeInteger(value) && value>=min && value<=max) values[name]=value;
    else invalid.push(key);
  }
  if (invalid.length) throw new Error(`投稿制限の設定が正しくありません: ${invalid.join(', ')}`);
  return values;
}

// 環境変数から認証・公開範囲の設定を作る。社内運用モードで欠落・一部設定・例示値があれば、
// 待ち受け前に例外で止める。値そのものはエラー文に含めない。
export function loadConfig(env) {
  const port=Number(env.PORT || 46077);
  const origin=env.AGENT_GUILD_ORIGIN || `http://127.0.0.1:${port}`;
  if (!['','0','1'].includes(env.AGENT_GUILD_INTERNAL||'')) throw new Error('AGENT_GUILD_INTERNAL は 1 または空にしてください。');
  const {postLimit,postWindowMs}=parsePostingLimits(env);
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
    if (!github.clientId || CREDENTIAL_PLACEHOLDER.test(github.clientId)) missing.push('AGENT_GUILD_GITHUB_CLIENT_ID');
    if (!github.clientSecret || CREDENTIAL_PLACEHOLDER.test(github.clientSecret)) missing.push('AGENT_GUILD_GITHUB_CLIENT_SECRET');
    if (!requiredOrg || PLACEHOLDER.test(requiredOrg)) missing.push('AGENT_GUILD_GITHUB_ORG');
    if (!googleSet) missing.push('AGENT_GUILD_GOOGLE_CLIENT_ID','AGENT_GUILD_GOOGLE_CLIENT_SECRET','AGENT_GUILD_GOOGLE_DOMAINS');
    else {
      if (CREDENTIAL_PLACEHOLDER.test(google.clientId)) missing.push('AGENT_GUILD_GOOGLE_CLIENT_ID');
      if (CREDENTIAL_PLACEHOLDER.test(google.clientSecret)) missing.push('AGENT_GUILD_GOOGLE_CLIENT_SECRET');
      if ([...google.domains].some(domain=>PLACEHOLDER.test(domain))) missing.push('AGENT_GUILD_GOOGLE_DOMAINS');
    }
    if (missing.length) throw new Error(`社内運用モードでは次の設定を実際の値にしてください: ${missing.join(', ')}`);
  }
  // 組織・ドメインで利用者を絞る設定があるときは、閲覧を含めてログインを必須にする。
  const requireLogin=internal || env.AGENT_GUILD_REQUIRE_LOGIN==='1' || Boolean(requiredOrg) || Boolean(googleSet);
  return {port,origin,internal,requireLogin,github,requiredOrg,google:googleSet?google:null,postLimit,postWindowMs};
}

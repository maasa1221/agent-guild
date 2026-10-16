import {googleUserId} from './identity.mjs';

// Google の信頼先は固定する。環境変数では変えられない。
export const GOOGLE_AUTHORIZE_URL='https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL='https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL='https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS=['https://accounts.google.com','accounts.google.com'];
const DOMAIN=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// カンマ区切りの Workspace ドメインを検査する。1件でも不正なら全体を拒否し、黙って許可範囲を変えない。
export function parseGoogleDomains(raw) {
  const items=String(raw||'').split(',').map(value=>value.trim());
  if (!items.length || items.some(value=>!DOMAIN.test(value))) throw new Error('AGENT_GUILD_GOOGLE_DOMAINS は小文字の Workspace ドメインをカンマ区切りで指定してください。');
  return new Set(items);
}

function emailDomain(email) {
  const at=email.lastIndexOf('@');
  return at>0 ? email.slice(at+1) : '';
}

// keyResolver と fetcher はテスト用の差し替え口。本番では Google の固定エンドポイントを使う。
export function createGoogleProvider({clientId,clientSecret,domains,fetcher=fetch,keyResolver=null,now=Date.now}) {
  if (!clientId || !clientSecret) throw new Error('Google ログインには AGENT_GUILD_GOOGLE_CLIENT_ID と AGENT_GUILD_GOOGLE_CLIENT_SECRET が必要です。');
  const allowed=domains instanceof Set?domains:parseGoogleDomains(domains);
  let jose=null;
  let remoteKeys=null;
  async function verifier() {
    // jose は Google を使うときだけ読み込む。Google 未設定の起動は依存を必要としない。
    jose??=await import('jose');
    if (keyResolver) return keyResolver;
    remoteKeys??=jose.createRemoteJWKSet(new URL(GOOGLE_JWKS_URL),{timeoutDuration:10000});
    return remoteKeys;
  }
  function authorizeUrl({redirectUri,state,nonce,codeChallenge}) {
    const target=new URL(GOOGLE_AUTHORIZE_URL);
    target.searchParams.set('client_id',clientId);
    target.searchParams.set('redirect_uri',redirectUri);
    target.searchParams.set('response_type','code');
    target.searchParams.set('scope','openid email');
    target.searchParams.set('state',state);
    target.searchParams.set('nonce',nonce);
    target.searchParams.set('code_challenge',codeChallenge);
    target.searchParams.set('code_challenge_method','S256');
    // hd はアカウント選択の補助だけで、許可判定には ID token の署名済み hd を使う。
    if (allowed.size===1) target.searchParams.set('hd',[...allowed][0]);
    return target.toString();
  }
  // 戻り値が null のときは許可ドメイン外。それ以外の失敗は例外にする。
  async function complete({code,codeVerifier,nonce,redirectUri}) {
    const keys=await verifier();
    const response=await fetcher(GOOGLE_TOKEN_URL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,code_verifier:codeVerifier,grant_type:'authorization_code',redirect_uri:redirectUri}),signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('token exchange failed');
    const idToken=(await response.json()).id_token;
    if (typeof idToken!=='string' || !idToken) throw new Error('id token missing');
    const {payload}=await jose.jwtVerify(idToken,keys,{algorithms:['RS256'],issuer:GOOGLE_ISSUERS,audience:clientId,requiredClaims:['sub','iat','exp','nonce'],currentDate:new Date(now()),clockTolerance:30});
    if (Array.isArray(payload.aud) && payload.aud.length>1 && payload.azp===undefined) throw new Error('azp missing');
    if (payload.azp!==undefined && payload.azp!==clientId) throw new Error('azp mismatch');
    if (typeof payload.nonce!=='string' || payload.nonce!==nonce) throw new Error('nonce mismatch');
    const id=googleUserId(payload.sub);
    if (!id) throw new Error('invalid sub');
    if (payload.email_verified!==true || typeof payload.email!=='string') return null;
    const email=payload.email.toLowerCase();
    if (typeof payload.hd!=='string' || !allowed.has(payload.hd) || !allowed.has(emailDomain(email))) return null;
    return {id,login:email,provider:'google'};
  }
  return {authorizeUrl,complete};
}

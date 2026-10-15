import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createGoogleProvider} from './google.mjs';

const SESSION_MS = 8 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');
const random = () => randomBytes(32).toString('base64url');

function cookie(req,name) {
  const item=(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(`${name}=`));
  return item?.slice(name.length+1) || '';
}

function equalHash(a,b) {
  const left=Buffer.from(a,'hex');
  const right=Buffer.from(b,'hex');
  return left.length===right.length && timingSafeEqual(left,right);
}

function json(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}

function signinPage(providers) {
  const links=[['github','/api/auth/login','GitHub でログイン'],['google','/api/auth/google/login','Google でログイン']].filter(([name])=>providers.includes(name)).map(([,href,label])=>`<a href="${href}">${label}</a>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Guild にログイン</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}a{display:block;margin:.75rem 0;padding:.75rem 1rem;border:1px solid #888;border-radius:.5rem;color:inherit;text-decoration:none;text-align:center}</style></head><body><h1>Agent Guild にログイン</h1><p>${links?'利用するアカウントを選んでください。':'ログインは未設定です。管理者に連絡してください。'}</p>${links}</body></html>`;
}

export function createAuthService({clientId,clientSecret,origin,fetcher=fetch,now=Date.now,authorizeUrl='https://github.com/login/oauth/authorize',tokenUrl='https://github.com/login/oauth/access_token',userUrl='https://api.github.com/user',requiredOrg='',orgMembershipUrl=org=>`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,google=null}) {
  const appOrigin=new URL(origin);
  if (appOrigin.pathname!=='/' || appOrigin.search || appOrigin.hash || (appOrigin.protocol!=='https:' && !(appOrigin.protocol==='http:' && ['127.0.0.1','localhost'].includes(appOrigin.hostname)))) throw new Error('AGENT_GUILD_ORIGIN は HTTPS またはローカルホストの URL にしてください。');
  const secure=appOrigin.protocol==='https:';
  const allowedOrigins=new Set([appOrigin.origin]);
  if (appOrigin.protocol==='http:' && appOrigin.hostname==='127.0.0.1') allowedOrigins.add('http://127.0.0.1:5173');
  const callbackUrl=new URL('/api/auth/callback',appOrigin).toString();
  const googleCallbackUrl=new URL('/api/auth/google/callback',appOrigin).toString();
  const githubConfigured=Boolean(clientId && clientSecret);
  if (requiredOrg && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(requiredOrg)) throw new Error('AGENT_GUILD_GITHUB_ORG は GitHub の組織名にしてください。');
  // Google は client ID・secret・許可ドメインの3つが揃ったときだけ有効にする。一部だけなら起動を拒否する。
  const googleProvider=google && (google.clientId || google.clientSecret || google.domains) ? createGoogleProvider({fetcher,now,...google}) : null;
  const providers=[...(githubConfigured?['github']:[]),...(googleProvider?['google']:[])];
  const configured=providers.length>0;
  const states=new Map();
  const sessions=new Map();

  function setCookies(res,values) { res.setHeader('Set-Cookie',values); }
  function sessionCookie(value,age) { return `ag_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`; }
  function stateCookie(value,age) { return `ag_oauth=${value}; Path=/api/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`; }
  function googleStateCookie(value,age) { return `ag_oauth_google=${value}; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`; }
  function expired() {
    const time=now();
    for (const [key,value] of states) if (value.expires<=time) states.delete(key);
    for (const [key,value] of sessions) if (value.expires<=time) sessions.delete(key);
  }
  function current(req) {
    expired();
    const token=cookie(req,'ag_session');
    return token?sessions.get(hash(token))||null:null;
  }
  function requireSession(req,res,{csrf=false}={}) {
    const entry=current(req);
    if (!entry) {json(res,401,{error:'ログインしてください。'});return null;}
    if (csrf) {
      const submitted=req.headers['x-csrf-token'];
      if (typeof submitted!=='string'||!equalHash(hash(submitted),entry.csrfHash)||(req.headers.origin && !allowedOrigins.has(req.headers.origin))) {
        json(res,403,{error:'リクエストの確認に失敗しました。画面を再読み込みしてください。'});
        return null;
      }
    }
    return entry;
  }
  // state は1回だけ使える。別 provider の state や Cookie では受け付けない。
  function takeState(req,res,url,provider,cookieName,clearCookie) {
    const state=url.searchParams.get('state')||'';
    const entry=state?states.get(hash(state)):null;
    if (entry) states.delete(hash(state));
    setCookies(res,[clearCookie('',0)]);
    const binding=cookie(req,cookieName);
    if (!entry||entry.provider!==provider||entry.expires<=now()||!binding||!equalHash(hash(binding),entry.bindingHash)||!url.searchParams.get('code')) return null;
    return entry;
  }
  function startSession(res,user,clearCookie) {
    const sessionToken=random();
    const csrfToken=random();
    sessions.set(hash(sessionToken),{user,csrfToken,csrfHash:hash(csrfToken),expires:now()+SESSION_MS});
    setCookies(res,[clearCookie('',0),sessionCookie(sessionToken,SESSION_MS/1000)]);
    res.writeHead(302,{'Location':'/','Cache-Control':'no-store'});
    res.end();
  }
  async function handle(req,res,url) {
    if (url.pathname==='/api/auth/me'&&req.method==='GET') {
      const entry=current(req);
      json(res,200,entry?{authenticated:true,configured,providers,user:entry.user,csrfToken:entry.csrfToken}:{authenticated:false,configured,providers});
      return true;
    }
    if (url.pathname==='/api/auth/signin'&&req.method==='GET') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});
      res.end(signinPage(providers));
      return true;
    }
    if (url.pathname==='/api/auth/login'&&req.method==='GET') {
      if (!githubConfigured) {json(res,503,{error:'GitHubログインは未設定です。ローカル設定を確認してください。'});return true;}
      expired();
      const state=random();
      const binding=random();
      const codeVerifier=random();
      states.set(hash(state),{provider:'github',bindingHash:hash(binding),codeVerifier,expires:now()+STATE_MS});
      const target=new URL(authorizeUrl);
      target.searchParams.set('client_id',clientId);
      target.searchParams.set('redirect_uri',callbackUrl);
      target.searchParams.set('state',state);
      target.searchParams.set('code_challenge',challenge(codeVerifier));
      target.searchParams.set('code_challenge_method','S256');
      if (requiredOrg) target.searchParams.set('scope','read:org');
      setCookies(res,[stateCookie(binding,STATE_MS/1000)]);
      res.writeHead(302,{'Location':target.toString(),'Cache-Control':'no-store'});
      res.end();
      return true;
    }
    if (url.pathname==='/api/auth/callback'&&req.method==='GET') {
      const entry=takeState(req,res,url,'github','ag_oauth',stateCookie);
      if (!githubConfigured||!entry) {
        json(res,400,{error:'GitHubログインを確認できませんでした。最初からやり直してください。'});
        return true;
      }
      try {
        const tokenResponse=await fetcher(tokenUrl,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code:url.searchParams.get('code'),redirect_uri:callbackUrl,code_verifier:entry.codeVerifier}),signal:AbortSignal.timeout(10000)});
        if (!tokenResponse.ok) throw new Error('token exchange failed');
        const token=(await tokenResponse.json()).access_token;
        if (typeof token!=='string'||!token) throw new Error('token missing');
        const userResponse=await fetcher(userUrl,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'User-Agent':'agent-guild-local'},signal:AbortSignal.timeout(10000)});
        if (!userResponse.ok) throw new Error('user lookup failed');
        const user=await userResponse.json();
        if (!Number.isSafeInteger(user.id)||user.id<=0||typeof user.login!=='string'||!user.login) throw new Error('invalid user');
        if (requiredOrg) {
          // SAML SSO を使う組織では、トークンが SSO 認可されていないと 403 になる。
          const membership=await fetcher(orgMembershipUrl(requiredOrg),{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'User-Agent':'agent-guild-local'},signal:AbortSignal.timeout(10000)});
          const body=membership.ok?await membership.json():null;
          if (body?.state!=='active') {
            json(res,403,{error:`GitHub 組織 ${requiredOrg} の有効なメンバーだけが利用できます。SSO の認可を求められた場合は承認してから再度ログインしてください。`});
            return true;
          }
        }
        startSession(res,{id:String(user.id),login:user.login},stateCookie);
      } catch {
        json(res,502,{error:'GitHubログインを完了できませんでした。再試行してください。'});
      }
      return true;
    }
    if (url.pathname==='/api/auth/google/login'&&req.method==='GET') {
      if (!googleProvider) {json(res,503,{error:'Googleログインは未設定です。'});return true;}
      expired();
      const state=random();
      const binding=random();
      const nonce=random();
      const codeVerifier=random();
      states.set(hash(state),{provider:'google',bindingHash:hash(binding),nonce,codeVerifier,expires:now()+STATE_MS});
      setCookies(res,[googleStateCookie(binding,STATE_MS/1000)]);
      res.writeHead(302,{'Location':googleProvider.authorizeUrl({redirectUri:googleCallbackUrl,state,nonce,codeChallenge:challenge(codeVerifier)}),'Cache-Control':'no-store'});
      res.end();
      return true;
    }
    if (url.pathname==='/api/auth/google/callback'&&req.method==='GET') {
      const entry=takeState(req,res,url,'google','ag_oauth_google',googleStateCookie);
      if (!googleProvider||!entry) {
        json(res,400,{error:'Googleログインを確認できませんでした。最初からやり直してください。'});
        return true;
      }
      try {
        // ID token と access token は検証後に破棄し、セッションには provider 付きの ID とメールだけを残す。
        const user=await googleProvider.complete({code:url.searchParams.get('code'),codeVerifier:entry.codeVerifier,nonce:entry.nonce,redirectUri:googleCallbackUrl});
        if (!user) {
          json(res,403,{error:'許可された組織のアカウントだけが利用できます。'});
          return true;
        }
        startSession(res,user,googleStateCookie);
      } catch {
        json(res,502,{error:'Googleログインを完了できませんでした。再試行してください。'});
      }
      return true;
    }
    if (url.pathname==='/api/auth/logout'&&req.method==='POST') {
      if (!requireSession(req,res,{csrf:true})) return true;
      sessions.delete(hash(cookie(req,'ag_session')));
      setCookies(res,[sessionCookie('',0)]);
      json(res,200,{authenticated:false});
      return true;
    }
    return false;
  }
  return {configured,providers,handle,requireSession,current};
}

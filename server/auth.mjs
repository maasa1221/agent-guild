import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const SESSION_MS = 8 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
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

export function createAuthService({clientId,clientSecret,origin,fetcher=fetch,now=Date.now,authorizeUrl='https://github.com/login/oauth/authorize',tokenUrl='https://github.com/login/oauth/access_token',userUrl='https://api.github.com/user'}) {
  const appOrigin=new URL(origin);
  if (appOrigin.pathname!=='/' || appOrigin.search || appOrigin.hash || (appOrigin.protocol!=='https:' && !(appOrigin.protocol==='http:' && ['127.0.0.1','localhost'].includes(appOrigin.hostname)))) throw new Error('AGENT_GUILD_ORIGIN は HTTPS またはローカルホストの URL にしてください。');
  const secure=appOrigin.protocol==='https:';
  const allowedOrigins=new Set([appOrigin.origin]);
  if (appOrigin.protocol==='http:' && appOrigin.hostname==='127.0.0.1') allowedOrigins.add('http://127.0.0.1:5173');
  const callbackUrl=new URL('/api/auth/callback',appOrigin).toString();
  const configured=Boolean(clientId && clientSecret);
  const states=new Map();
  const sessions=new Map();

  function setCookies(res,values) { res.setHeader('Set-Cookie',values); }
  function sessionCookie(value,age) { return `ag_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`; }
  function stateCookie(value,age) { return `ag_oauth=${value}; Path=/api/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`; }
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
    if (!entry) {json(res,401,{error:'GitHubでログインしてください。'});return null;}
    if (csrf) {
      const submitted=req.headers['x-csrf-token'];
      if (typeof submitted!=='string'||!equalHash(hash(submitted),entry.csrfHash)||(req.headers.origin && !allowedOrigins.has(req.headers.origin))) {
        json(res,403,{error:'リクエストの確認に失敗しました。画面を再読み込みしてください。'});
        return null;
      }
    }
    return entry;
  }
  async function handle(req,res,url) {
    if (url.pathname==='/api/auth/me'&&req.method==='GET') {
      const entry=current(req);
      json(res,200,entry?{authenticated:true,configured,user:entry.user,csrfToken:entry.csrfToken}:{authenticated:false,configured});
      return true;
    }
    if (url.pathname==='/api/auth/login'&&req.method==='GET') {
      if (!configured) {json(res,503,{error:'GitHubログインは未設定です。ローカル設定を確認してください。'});return true;}
      expired();
      const state=random();
      const nonce=random();
      states.set(hash(state),{nonceHash:hash(nonce),expires:now()+STATE_MS});
      const target=new URL(authorizeUrl);
      target.searchParams.set('client_id',clientId);
      target.searchParams.set('redirect_uri',callbackUrl);
      target.searchParams.set('state',state);
      setCookies(res,[stateCookie(nonce,STATE_MS/1000)]);
      res.writeHead(302,{'Location':target.toString(),'Cache-Control':'no-store'});
      res.end();
      return true;
    }
    if (url.pathname==='/api/auth/callback'&&req.method==='GET') {
      const state=url.searchParams.get('state')||'';
      const code=url.searchParams.get('code')||'';
      const entry=state?states.get(hash(state)):null;
      if (entry) states.delete(hash(state));
      setCookies(res,[stateCookie('',0)]);
      const nonce=cookie(req,'ag_oauth');
      if (!configured||!entry||entry.expires<=now()||!nonce||!equalHash(hash(nonce),entry.nonceHash)||!code) {
        json(res,400,{error:'GitHubログインを確認できませんでした。最初からやり直してください。'});
        return true;
      }
      try {
        const tokenResponse=await fetcher(tokenUrl,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,redirect_uri:callbackUrl}),signal:AbortSignal.timeout(10000)});
        if (!tokenResponse.ok) throw new Error('token exchange failed');
        const token=(await tokenResponse.json()).access_token;
        if (typeof token!=='string'||!token) throw new Error('token missing');
        const userResponse=await fetcher(userUrl,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'User-Agent':'agent-guild-local'},signal:AbortSignal.timeout(10000)});
        if (!userResponse.ok) throw new Error('user lookup failed');
        const user=await userResponse.json();
        if (!Number.isSafeInteger(user.id)||user.id<=0||typeof user.login!=='string'||!user.login) throw new Error('invalid user');
        const sessionToken=random();
        const csrfToken=random();
        sessions.set(hash(sessionToken),{user:{id:String(user.id),login:user.login},csrfToken,csrfHash:hash(csrfToken),expires:now()+SESSION_MS});
        setCookies(res,[stateCookie('',0),sessionCookie(sessionToken,SESSION_MS/1000)]);
        res.writeHead(302,{'Location':'/','Cache-Control':'no-store'});
        res.end();
      } catch {
        json(res,502,{error:'GitHubログインを完了できませんでした。再試行してください。'});
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
  return {configured,handle,requireSession};
}

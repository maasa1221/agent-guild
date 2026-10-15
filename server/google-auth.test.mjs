import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {SignJWT,createLocalJWKSet,exportJWK,generateKeyPair} from 'jose';
import {createAuthService} from './auth.mjs';
import {parseGoogleDomains} from './google.mjs';

const CLIENT='fixture-google-client.apps.googleusercontent.com';
const DOMAIN='fixture-corp.test';
const challenge=verifier=>createHash('sha256').update(verifier).digest('base64url');

// 合成の RSA 鍵で実際に署名した ID token を作り、ローカル JWKS で検証させる。
async function keys(kid) {
  const {publicKey,privateKey}=await generateKeyPair('RS256',{extractable:true});
  const jwk={...await exportJWK(publicKey),kid,alg:'RS256',use:'sig'};
  return {jwk,privateKey,kid};
}

async function sign(key,claims,{kid=key.kid,alg='RS256'}={}) {
  const {iat,exp,...rest}=claims;
  const time=Math.floor(Date.now()/1000);
  return new SignJWT(rest).setProtectedHeader({alg,kid}).setIssuedAt(iat??time).setExpirationTime(exp??time+300).sign(key.privateKey);
}

async function setup(t,{domains=DOMAIN,github=true}={}) {
  const trusted=await keys('trusted');
  const untrusted=await keys('trusted');
  let issue=null;
  const calls=[];
  const fetcher=async (url,options)=>{
    calls.push({url,options});
    if (url==='https://oauth2.googleapis.com/token') {
      const body=new URLSearchParams(options.body);
      if (!body.get('code_verifier')||challenge(body.get('code_verifier'))!==issue.challenge) return new Response('{}',{status:400});
      return new Response(JSON.stringify({id_token:await issue.token(issue.nonce),access_token:'fixture-google-access'}),{status:200});
    }
    if (url==='https://github.com/login/oauth/access_token') return new Response(JSON.stringify({access_token:'fixture-gh'}),{status:200});
    if (url==='https://api.github.com/user') return new Response(JSON.stringify({id:123,login:'gh-alice'}),{status:200});
    throw new Error(`unexpected outbound request: ${url}`);
  };
  let auth;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if (await auth.handle(req,res,url)) return;
    const session=auth.requireSession(req,res,{csrf:true});
    if (!session) return;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({user:session.user}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  const origin=`http://127.0.0.1:${server.address().port}`;
  auth=createAuthService({...(github?{clientId:'fixture-gh-id',clientSecret:'fixture-gh-secret'}:{}),origin,fetcher,google:{clientId:CLIENT,clientSecret:'fixture-google-secret',domains,keyResolver:createLocalJWKSet({keys:[trusted.jwk]})}});
  const request=(route,options={})=>fetch(origin+route,{redirect:'manual',...options});
  const base=nonce=>({iss:'https://accounts.google.com',aud:CLIENT,azp:CLIENT,sub:'110000000000000000001',email:`alice@${DOMAIN}`,email_verified:true,hd:DOMAIN,nonce});
  async function start(route='/api/auth/google/login') {
    const response=await request(route);
    const location=new URL(response.headers.get('location'));
    const cookie=response.headers.getSetCookie()[0].split(';')[0];
    return {response,location,cookie,state:location.searchParams.get('state')};
  }
  // claims(nonce) で ID token の内容を決め、callback までを1回実行する。
  // raw を渡すと、署名後に加工したトークンをそのまま返す。
  async function attempt(claims,{key=trusted,header={},cookieOverride,stateOverride,raw}={}) {
    const begun=await start();
    issue={nonce:begun.location.searchParams.get('nonce'),challenge:begun.location.searchParams.get('code_challenge'),token:raw||(nonce=>sign(key,claims(nonce),header))};
    const response=await request(`/api/auth/google/callback?code=fixture-code&state=${stateOverride??begun.state}`,{headers:{Cookie:cookieOverride??begun.cookie}});
    const session=response.headers.getSetCookie().find(value=>value.startsWith('ag_session=')&&!value.includes('Max-Age=0'));
    return {response,session:session?.split(';')[0],begun};
  }
  return {auth,origin,request,start,attempt,base,trusted,untrusted,calls};
}

test('Google login uses fixed endpoints, minimal scopes, PKCE, nonce and a namespaced verified sub',async t=>{
  const {origin,request,start,attempt,base,calls}=await setup(t);
  const {response,location}=await start();
  assert.equal(response.status,302);
  assert.equal(location.origin+location.pathname,'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('scope'),'openid email');
  assert.equal(location.searchParams.get('response_type'),'code');
  assert.equal(location.searchParams.get('redirect_uri'),origin+'/api/auth/google/callback');
  assert.equal(location.searchParams.get('code_challenge_method'),'S256');
  assert.equal(location.searchParams.has('access_type'),false);
  assert.match(location.searchParams.get('nonce'),/^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers.getSetCookie()[0],/^ag_oauth_google=[^;]+; Path=\/api\/auth\/google\/callback; HttpOnly; SameSite=Lax/);

  const ok=await attempt(base);
  assert.equal(ok.response.status,302);
  assert.ok(ok.session);
  const exchange=calls.find(call=>call.url==='https://oauth2.googleapis.com/token');
  const sent=new URLSearchParams(exchange.options.body);
  assert.equal(sent.get('grant_type'),'authorization_code');
  assert.equal(sent.get('redirect_uri'),origin+'/api/auth/google/callback');
  const me=await (await request('/api/auth/me',{headers:{Cookie:ok.session}})).json();
  assert.deepEqual(me.user,{id:'google:110000000000000000001',login:`alice@${DOMAIN}`,provider:'google'});
  assert.deepEqual(me.providers,['github','google']);
  assert.equal(JSON.stringify(me).includes('fixture-google-access'),false);
  assert.equal(JSON.stringify(me).includes('eyJ'),false);
  const write=await request('/api/write',{method:'POST',headers:{Cookie:ok.session,'X-CSRF-Token':me.csrfToken,Origin:origin}});
  assert.equal((await write.json()).user.id,'google:110000000000000000001');
  assert.equal((await request('/api/write',{method:'POST',headers:{Cookie:ok.session,Origin:origin}})).status,403);
  assert.equal((await request('/api/auth/logout',{method:'POST',headers:{Cookie:ok.session,'X-CSRF-Token':me.csrfToken,Origin:origin}})).status,200);
  assert.equal((await (await request('/api/auth/me',{headers:{Cookie:ok.session}})).json()).authenticated,false);
});

test('Google and GitHub identities with the same number or email never collide',async t=>{
  const {request,attempt,base}=await setup(t);
  const google=await attempt(nonce=>({...base(nonce),sub:'123',email:`gh-alice@${DOMAIN}`}));
  const googleUser=(await (await request('/api/auth/me',{headers:{Cookie:google.session}})).json()).user;
  const gh=await request('/api/auth/login');
  const ghState=new URL(gh.headers.get('location')).searchParams.get('state');
  const ghCallback=await request(`/api/auth/callback?code=fixture&state=${ghState}`,{headers:{Cookie:gh.headers.getSetCookie()[0].split(';')[0]}});
  const ghCookie=ghCallback.headers.getSetCookie().find(value=>value.startsWith('ag_session=')).split(';')[0];
  const githubUser=(await (await request('/api/auth/me',{headers:{Cookie:ghCookie}})).json()).user;
  assert.deepEqual(githubUser,{id:'123',login:'gh-alice'});
  assert.equal(googleUser.id,'google:123');
  assert.notEqual(googleUser.id,githubUser.id);
});

test('ID tokens with bad signatures or claims are rejected without a session',async t=>{
  const {attempt,base,untrusted,trusted}=await setup(t);
  const now=Math.floor(Date.now()/1000);
  const cases={
    'wrong issuer':nonce=>({...base(nonce),iss:'https://accounts.google.test'}),
    'wrong audience':nonce=>({...base(nonce),aud:'other-client'}),
    'wrong azp':nonce=>({...base(nonce),azp:'other-client'}),
    'multiple audiences without azp':nonce=>{const claims={...base(nonce),aud:[CLIENT,'other-client']};delete claims.azp;return claims;},
    'expired':nonce=>({...base(nonce),iat:now-3600,exp:now-120}),
    'wrong nonce':()=>base('another-nonce'),
    'missing nonce':nonce=>{const claims=base(nonce);delete claims.nonce;return claims;},
    'invalid sub':nonce=>({...base(nonce),sub:'bad sub'}),
  };
  for (const [name,claims] of Object.entries(cases)) {
    const {response,session}=await attempt(claims);
    assert.equal(response.status,502,name);
    assert.equal(session,undefined,name);
  }
  const tampered=await attempt(base,{key:{...trusted,privateKey:untrusted.privateKey}});
  assert.equal(tampered.response.status,502,'signed by an unknown key with a trusted kid');
  assert.equal(tampered.session,undefined);
});

test('tokens edited after signing or left unsigned fail verification',async t=>{
  const {attempt,trusted,base}=await setup(t);
  const time=Math.floor(Date.now()/1000);
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const forgeries={
    // 許可外ドメインで正しく署名したトークンの payload だけを許可ドメインへ書き換える。
    'edited payload':async nonce=>{
      const [header,,signature]=(await sign(trusted,{...base(nonce),email:'mallory@outside.test',hd:'outside.test'})).split('.');
      return `${header}.${encode({...base(nonce),iat:time,exp:time+300})}.${signature}`;
    },
    'alg none':async nonce=>`${encode({alg:'none',kid:'trusted'})}.${encode({...base(nonce),iat:time,exp:time+300})}.`,
  };
  for (const [name,raw] of Object.entries(forgeries)) {
    const {response,session}=await attempt(null,{raw});
    assert.equal(response.status,502,name);
    assert.equal(session,undefined,name);
  }
});

test('unverified email, missing or foreign hd and look-alike domains are refused',async t=>{
  const {attempt,base}=await setup(t,{domains:`${DOMAIN},second-corp.test`});
  const cases={
    'email_verified false':nonce=>({...base(nonce),email_verified:false}),
    'email_verified string':nonce=>({...base(nonce),email_verified:'true'}),
    'email_verified missing':nonce=>{const claims=base(nonce);delete claims.email_verified;return claims;},
    'email missing':nonce=>{const claims=base(nonce);delete claims.email;return claims;},
    'hd missing (consumer account)':nonce=>{const claims=base(nonce);delete claims.hd;return claims;},
    'hd outside allowlist':nonce=>({...base(nonce),hd:'outside.test',email:'alice@outside.test'}),
    'hd suffix spoof':nonce=>({...base(nonce),hd:`evil-${DOMAIN}`,email:`alice@evil-${DOMAIN}`}),
    'hd parent-domain spoof':nonce=>({...base(nonce),hd:`${DOMAIN}.evil.test`,email:`alice@${DOMAIN}.evil.test`}),
    'subdomain of allowed domain':nonce=>({...base(nonce),hd:`sub.${DOMAIN}`,email:`alice@sub.${DOMAIN}`}),
    'email domain differs from allowed hd':nonce=>({...base(nonce),email:'alice@outside.test'}),
    'email with allowed suffix only':nonce=>({...base(nonce),email:`alice@x${DOMAIN}`}),
  };
  for (const [name,claims] of Object.entries(cases)) {
    const {response,session}=await attempt(claims);
    assert.equal(response.status,403,name);
    assert.equal(session,undefined,name);
  }
  const second=await attempt(nonce=>({...base(nonce),hd:'second-corp.test',email:'bob@SECOND-corp.test',sub:'2'}));
  assert.equal(second.response.status,302,'a second allowed Workspace domain');
});

test('state replay, cookie mismatch and provider confusion are rejected before any token exchange',async t=>{
  const {request,start,attempt,base,calls}=await setup(t);
  const used=await attempt(base);
  assert.equal(used.response.status,302);
  const replay=await request(`/api/auth/google/callback?code=fixture-code&state=${used.begun.state}`,{headers:{Cookie:used.begun.cookie}});
  assert.equal(replay.status,400);
  const before=calls.length;
  const wrongCookie=await attempt(base,{cookieOverride:'ag_oauth_google=forged'});
  assert.equal(wrongCookie.response.status,400);
  const github=await request('/api/auth/login');
  const ghState=new URL(github.headers.get('location')).searchParams.get('state');
  const ghBinding=github.headers.getSetCookie()[0].split(';')[0].replace('ag_oauth=','');
  const crossToGoogle=await request(`/api/auth/google/callback?code=x&state=${ghState}`,{headers:{Cookie:`ag_oauth_google=${ghBinding}`}});
  assert.equal(crossToGoogle.status,400);
  const google=await start();
  const googleBinding=google.cookie.replace('ag_oauth_google=','');
  const crossToGithub=await request(`/api/auth/callback?code=x&state=${google.state}`,{headers:{Cookie:`ag_oauth=${googleBinding}`}});
  assert.equal(crossToGithub.status,400);
  assert.equal(calls.length,before,'no token endpoint was contacted');
});

test('token endpoint failures and timeouts return a generic error',async t=>{
  const failing=async()=>{throw new DOMException('The operation was aborted due to timeout','TimeoutError');};
  const trusted=await keys('k');
  const auth=createAuthService({origin:'http://127.0.0.1:1',google:{clientId:CLIENT,clientSecret:'fixture-google-secret',domains:DOMAIN,keyResolver:createLocalJWKSet({keys:[trusted.jwk]}),fetcher:failing}});
  const server=http.createServer(async(req,res)=>auth.handle(req,res,new URL(req.url,'http://localhost')));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  const local=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(local+'/api/auth/google/login',{redirect:'manual'});
  const state=new URL(login.headers.get('location')).searchParams.get('state');
  const response=await fetch(`${local}/api/auth/google/callback?code=x&state=${state}`,{redirect:'manual',headers:{Cookie:login.headers.getSetCookie()[0].split(';')[0]}});
  assert.equal(response.status,502);
  assert.deepEqual(await response.json(),{error:'Googleログインを完了できませんでした。再試行してください。'});
});

test('partial Google settings and invalid domain allowlists are refused at construction',()=>{
  const origin='http://127.0.0.1:46077';
  for (const google of [{clientId:CLIENT},{clientId:CLIENT,clientSecret:'s'},{clientSecret:'s',domains:DOMAIN},{domains:DOMAIN}]) {
    assert.throws(()=>createAuthService({origin,google}),/AGENT_GUILD_GOOGLE/,JSON.stringify(google));
  }
  for (const domains of [' ',',',`${DOMAIN},`,'*.corp.test','https://corp.test','corp','Corp.test','corp.test/path','@corp.test','corp..test']) {
    assert.throws(()=>parseGoogleDomains(domains),/AGENT_GUILD_GOOGLE_DOMAINS/,domains);
  }
  assert.deepEqual([...parseGoogleDomains(`${DOMAIN}, second-corp.test`)],[DOMAIN,'second-corp.test']);
  const disabled=createAuthService({origin,clientId:'id',clientSecret:'secret'});
  assert.deepEqual(disabled.providers,['github']);
});

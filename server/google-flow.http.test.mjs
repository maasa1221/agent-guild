import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from './storage.mjs';

const source=path.dirname(fileURLToPath(import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const GOOGLE={AGENT_GUILD_GOOGLE_CLIENT_ID:'fixture-google-client.apps.googleusercontent.com',AGENT_GUILD_GOOGLE_CLIENT_SECRET:'fixture-google-secret',AGENT_GUILD_GOOGLE_DOMAINS:'fixture-corp.test'};
const GITHUB={AGENT_GUILD_GITHUB_CLIENT_ID:'fixture-id',AGENT_GUILD_GITHUB_CLIENT_SECRET:'fixture-secret'};

// 一時ディレクトリに server/ を複製し、jose はリポジトリの node_modules へのリンクで参照させる。
async function startServer(t,env) {
  const root=mkdtempSync(path.join(os.tmpdir(),'agent-guild-google-'));
  cpSync(source,path.join(root,'server'),{recursive:true});
  symlinkSync(path.join(source,'..','node_modules'),path.join(root,'node_modules'),'dir');
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const clean={...process.env};
  for (const key of Object.keys(clean)) if (key.startsWith('AGENT_GUILD_')) delete clean[key];
  const child=spawn(process.execPath,['--import',path.join(root,'server','ownership.fixture.mjs'),'--import',path.join(root,'server','google.fixture.mjs'),path.join(root,'server','index.mjs')],{env:{...clean,PORT:String(port),AGENT_GUILD_ORIGIN:origin,...env},stdio:['ignore','ignore','pipe']});
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(()=>{child.kill();rmSync(root,{recursive:true,force:true});});
  const request=(route,options={})=>fetch(origin+route,{redirect:'manual',...options});
  for (let i=0;i<500;i++) {
    if (child.exitCode!==null) return {exitCode:child.exitCode,stderr,root};
    try {await request('/api/auth/me');break;} catch {await sleep(20);}
  }
  async function session(response) {
    assert.equal(response.status,302,await response.clone().text());
    const cookie=response.headers.getSetCookie().find(x=>x.startsWith('ag_session=')).split(';')[0];
    const me=await (await request('/api/auth/me',{headers:{Cookie:cookie}})).json();
    return {cookie,csrf:me.csrfToken,user:me.user};
  }
  async function googleCallback(name) {
    const start=await request('/api/auth/google/login');
    const location=new URL(start.headers.get('location'));
    const cookie=start.headers.getSetCookie()[0].split(';')[0];
    return request(`/api/auth/google/callback?code=${name}.${location.searchParams.get('nonce')}&state=${location.searchParams.get('state')}`,{headers:{Cookie:cookie}});
  }
  async function githubCallback(code) {
    const start=await request('/api/auth/login');
    const location=new URL(start.headers.get('location'));
    return request(`/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,{headers:{Cookie:start.headers.getSetCookie()[0].split(';')[0]}});
  }
  const post=(route,user,value={})=>request(route,{method:'POST',headers:{Cookie:user.cookie,'X-CSRF-Token':user.csrf,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
  return {root,origin,request,post,exited,googleLogin:async name=>session(await googleCallback(name)),githubLogin:async code=>session(await githubCallback(code)),googleCallback,githubCallback};
}

test('Google users post, answer and accept for free; other providers and users cannot accept; audit is stored',async t=>{
  const {root,request,post,googleLogin,githubLogin,googleCallback}=await startServer(t,{...GITHUB,...GOOGLE});
  const page=await request('/');
  assert.equal(page.status,302);
  assert.equal(page.headers.get('location'),'/api/auth/signin');
  const signin=await (await request('/api/auth/signin')).text();
  assert.match(signin,/href="\/api\/auth\/login"/);
  assert.match(signin,/href="\/api\/auth\/google\/login"/);
  assert.equal((await request('/api/listings')).status,401);
  const anonymous=await (await request('/api/auth/me')).json();
  assert.deepEqual(anonymous,{authenticated:false,configured:true,providers:['github','google']});

  const outside=await googleCallback('goutside');
  assert.equal(outside.status,403);
  assert.equal(outside.headers.getSetCookie().some(x=>x.startsWith('ag_session=')&&!x.includes('Max-Age=0')),false);

  const alice=await googleLogin('galice');
  const bob=await googleLogin('gbob');
  const ghAlice=await githubLogin('alice');
  const sameNumber=await googleLogin('gsame');
  assert.equal(alice.user.id,'google:200000000000000000001');
  assert.equal(ghAlice.user.id,'123');
  assert.equal(sameNumber.user.id,'google:123');
  assert.equal(sameNumber.user.login,alice.user.login,'same email, still a different identity');

  const created=await post('/api/listings',alice,{issueUrl:'https://github.com/owner/repo/issues/1',acceptance:'Fixture acceptance',aiPolicy:'poster_declared',aiEvidence:'Fixture evidence'});
  assert.equal(created.status,201);
  const listing=await created.json();
  assert.equal(listing.posterId,alice.user.id);
  assert.equal((await post(`/api/listings/${listing.id}/answers`,alice,{text:'Answering my own quest'})).status,403);
  const answered=await post(`/api/listings/${listing.id}/answers`,bob,{text:'Synthetic completed answer'});
  assert.equal(answered.status,201);
  const answerId=(await answered.json()).answers[0].id;

  for (const intruder of [bob,ghAlice,sameNumber]) {
    const denied=await post(`/api/listings/${listing.id}/payment`,intruder,{action:'accept',answerId});
    assert.equal(denied.status,403,intruder.user.id);
  }
  const unchanged=await (await request(`/api/listings/${listing.id}`,{headers:{Cookie:alice.cookie}})).json();
  assert.equal(unchanged.acceptedAnswerId,null);
  assert.deepEqual(unchanged.reward.history,[]);

  const accepted=await post(`/api/listings/${listing.id}/payment`,alice,{action:'accept',answerId});
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).acceptedAnswerId,answerId);

  const store=openStore(path.join(root,'data'));
  t.after(()=>store.close());
  const saved=store.read().listings.find(x=>x.id===listing.id);
  assert.equal(saved.posterId,'google:200000000000000000001');
  assert.equal(saved.answers[0].authorId,'google:200000000000000000002');
  assert.equal(saved.acceptedAnswerId,answerId);
  assert.deepEqual(store.audit().map(x=>[x.actorId,x.targetId,x.operation,x.result]),[
    ['google:200000000000000000002',listing.id,'accept','rejected_403'],
    ['123',listing.id,'accept','rejected_403'],
    ['google:123',listing.id,'accept','rejected_403'],
    ['google:200000000000000000001',listing.id,'accept','applied'],
  ]);
});

test('a GitHub listing cannot be accepted by a Google account with the same numeric sub',async t=>{
  const {request,post,googleLogin,githubLogin}=await startServer(t,{...GITHUB,...GOOGLE});
  const ghAlice=await githubLogin('alice');
  const ghBob=await githubLogin('bob');
  const sameNumber=await googleLogin('gsame');
  const listing=await (await post('/api/listings',ghAlice,{issueUrl:'https://github.com/owner/repo/issues/3',acceptance:'Fixture acceptance',aiPolicy:'poster_declared',aiEvidence:'Fixture evidence'})).json();
  const answerId=(await (await post(`/api/listings/${listing.id}/answers`,ghBob,{text:'Synthetic completed answer'})).json()).answers[0].id;
  assert.equal((await post(`/api/listings/${listing.id}/payment`,sameNumber,{action:'accept',answerId})).status,403);
  assert.equal((await (await request(`/api/listings/${listing.id}`,{headers:{Cookie:ghAlice.cookie}})).json()).acceptedAnswerId,null);
  assert.equal((await post(`/api/listings/${listing.id}/payment`,ghAlice,{action:'accept',answerId})).status,200);
});

test('internal mode refuses to start with missing, partial or example settings',async t=>{
  const internal={AGENT_GUILD_ORIGIN:'https://guild.fixture-corp.test',...GITHUB,AGENT_GUILD_GITHUB_ORG:'fixture-org',...GOOGLE};
  const cases={
    'https origin without organization':{...internal,AGENT_GUILD_GITHUB_ORG:''},
    'https origin with GitHub only':{AGENT_GUILD_ORIGIN:'https://guild.fixture-corp.test',...GITHUB,AGENT_GUILD_GITHUB_ORG:'fixture-org'},
    'explicit internal on loopback http':{...internal,AGENT_GUILD_ORIGIN:'',AGENT_GUILD_INTERNAL:'1'},
    'explicit internal with nothing else':{AGENT_GUILD_INTERNAL:'1'},
    'partial Google settings on loopback':{...GITHUB,AGENT_GUILD_GOOGLE_CLIENT_ID:'fixture-google-client'},
    'example origin':{...internal,AGENT_GUILD_ORIGIN:'https://agent-guild.example.com'},
    'example organization':{...internal,AGENT_GUILD_GITHUB_ORG:'your-org'},
  };
  for (const [name,env] of Object.entries(cases)) {
    const result=await startServer(t,env);
    assert.notEqual(result.exitCode??null,null,name);
    assert.notEqual(result.exitCode,0,name);
    assert.doesNotMatch(result.stderr,/fixture-secret|fixture-google-secret/,name);
  }
});

test('a complete internal configuration serves only the sign-in page until an allowed login',async t=>{
  const {request,googleCallback,githubCallback}=await startServer(t,{AGENT_GUILD_ORIGIN:'https://guild.fixture-corp.test',...GITHUB,AGENT_GUILD_GITHUB_ORG:'fixture-org',...GOOGLE});
  assert.equal((await request('/')).headers.get('location'),'/api/auth/signin');
  assert.equal((await request('/api/listings')).status,401);
  assert.equal((await request('/api/listings/demo-cli-14647')).status,401);
  assert.equal((await githubCallback('bob')).status,403);
  assert.equal((await googleCallback('goutside')).status,403);
  const github=await githubCallback('alice');
  assert.equal(github.status,302);
  assert.match(github.headers.getSetCookie().find(x=>x.startsWith('ag_session=')),/; Secure/);
  const google=await googleCallback('galice');
  assert.equal(google.status,302);
  const cookie=google.headers.getSetCookie().find(x=>x.startsWith('ag_session=')).split(';')[0];
  assert.equal((await request('/api/listings',{headers:{Cookie:cookie}})).status,200);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const source=path.dirname(fileURLToPath(import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function startServer(t,env={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'agent-guild-free-'));
  cpSync(source,path.join(root,'server'),{recursive:true});
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import',path.join(root,'server','ownership.fixture.mjs'),path.join(root,'server','index.mjs')],{env:{...process.env,PORT:String(port),AGENT_GUILD_ORIGIN:origin,AGENT_GUILD_GITHUB_CLIENT_ID:'fixture-id',AGENT_GUILD_GITHUB_CLIENT_SECRET:'fixture-secret',...env},stdio:['ignore','ignore','pipe']});
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  t.after(()=>{child.kill();rmSync(root,{recursive:true,force:true});});
  const request=(route,options={})=>fetch(origin+route,{redirect:'manual',...options});
  let ready=false;
  for(let i=0;i<500;i++){if(child.exitCode!==null)throw new Error(`server exited: ${stderr}`);try{await request('/api/auth/me');ready=true;break;}catch{await sleep(20);}}
  assert.ok(ready,stderr);
  async function callback(code){
    const start=await request('/api/auth/login');
    const location=new URL(start.headers.get('location'));
    const oauthCookie=start.headers.getSetCookie()[0].split(';')[0];
    const response=await request(`/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,{headers:{Cookie:oauthCookie}});
    return {location,response};
  }
  async function login(code){
    const {response}=await callback(code);
    assert.equal(response.status,302);
    const cookie=response.headers.getSetCookie().find(x=>x.startsWith('ag_session=')).split(';')[0];
    const me=await (await request('/api/auth/me',{headers:{Cookie:cookie}})).json();
    return {cookie,csrf:me.csrfToken};
  }
  const post=(route,user,value={})=>request(route,{method:'POST',headers:{Cookie:user.cookie,'X-CSRF-Token':user.csrf,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
  return {request,callback,login,post};
}

test('free edition is the default: no reward amounts, no wallets, acceptance still completes',async t=>{
  const {request,login,post}=await startServer(t);
  assert.equal((await (await request('/api/listings')).json()).rewards,false);
  const alice=await login('alice'),bob=await login('bob');
  const listing={issueUrl:'https://github.com/owner/repo/issues/1',acceptance:'Fixture acceptance',aiPolicy:'poster_declared',aiEvidence:'Fixture evidence'};
  const paid=await post('/api/listings',alice,{...listing,amount:10});
  assert.equal(paid.status,400);
  assert.match((await paid.json()).error,/無料版/);
  const created=await post('/api/listings',alice,{...listing,amount:0});
  assert.equal(created.status,201);
  const id=(await created.json()).id;
  assert.equal((await post('/api/wallet',bob,{wallet:'0x'+'b'.repeat(40)})).status,404);
  const answered=await post(`/api/listings/${id}/answers`,bob,{text:'Synthetic completed answer'});
  const answerId=(await answered.json()).answers[0].id;
  const accepted=await (await post(`/api/listings/${id}/payment`,alice,{action:'accept',answerId})).json();
  assert.equal(accepted.acceptedAnswerId,answerId);
  assert.deepEqual(accepted.reward.history.map(h=>h.event),['accepted_no_reward']);
  assert.equal((await (await request('/api/listings',{headers:{Cookie:bob.cookie}})).json()).wallet,'');
});

test('organization restriction requires an active member login for every page and API',async t=>{
  const {request,callback,login}=await startServer(t,{AGENT_GUILD_GITHUB_ORG:'fixture-org'});
  const page=await request('/');
  assert.equal(page.status,302);
  assert.equal(page.headers.get('location'),'/api/auth/login');
  assert.equal((await request('/assets/app.js')).status,302);
  assert.equal((await request('/api/listings')).status,401);
  assert.equal((await request('/api/listings/demo-cli-14647')).status,401);
  assert.equal((await (await request('/api/auth/me')).json()).authenticated,false);

  const {location}=await callback('alice');
  assert.equal(location.searchParams.get('scope'),'read:org');
  const alice=await login('alice');
  assert.equal((await request('/api/listings',{headers:{Cookie:alice.cookie}})).status,200);

  for (const code of ['bob','charlie']) {
    const {response}=await callback(code);
    assert.equal(response.status,403,code);
    assert.match((await response.json()).error,/fixture-org/);
    assert.equal(response.headers.getSetCookie().some(x=>x.startsWith('ag_session=')&&!x.includes('Max-Age=0')),false,code);
  }
});

test('login can be required without an organization, and an invalid organization name is rejected at startup',async t=>{
  const {request,login}=await startServer(t,{AGENT_GUILD_REQUIRE_LOGIN:'1'});
  assert.equal((await request('/api/listings')).status,401);
  const charlie=await login('charlie');
  assert.equal((await request('/api/listings',{headers:{Cookie:charlie.cookie}})).status,200);
  await assert.rejects(startServer(t,{AGENT_GUILD_GITHUB_ORG:'bad/org'}),/server exited/);
});

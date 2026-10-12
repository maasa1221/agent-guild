import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const source=path.dirname(fileURLToPath(import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function freePort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('two users and anonymous requests enforce ownership without changing denied state',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'agent-guild-ownership-'));
  cpSync(source,path.join(root,'server'),{recursive:true});
  mkdirSync(path.join(root,'data'));
  const legacy={listings:[{id:'legacy',sourceUrl:'https://github.com/owner/old/issues/2',title:'Legacy',answers:[{id:'old-answer',text:'Old work'}],reward:{amount:10,status:'ready',history:[]}}],users:{responder:{wallet:'0x'+'a'.repeat(40)}}};
  writeFileSync(path.join(root,'data','listings.json'),JSON.stringify(legacy));
  const port=await freePort();
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import',path.join(root,'server','ownership.fixture.mjs'),path.join(root,'server','index.mjs')],{env:{...process.env,PORT:String(port),AGENT_GUILD_ORIGIN:origin,AGENT_GUILD_GITHUB_CLIENT_ID:'fixture-id',AGENT_GUILD_GITHUB_CLIENT_SECRET:'fixture-secret'},stdio:'ignore'});
  t.after(()=>{child.kill();rmSync(root,{recursive:true,force:true});});
  const request=(route,options={})=>fetch(origin+route,{redirect:'manual',...options});
  let ready=false;
  for (let i=0;i<100;i++) {
    if (child.exitCode!==null) throw new Error(`server exited: ${child.exitCode}`);
    try {await request('/api/auth/me');ready=true;break;} catch {await sleep(20);}
  }
  assert.ok(ready,'server starts');
  async function login(code) {
    const start=await request('/api/auth/login');
    assert.equal(start.status,302);
    const state=new URL(start.headers.get('location')).searchParams.get('state');
    const oauthCookie=start.headers.getSetCookie()[0].split(';')[0];
    const callback=await request(`/api/auth/callback?code=${code}&state=${state}`,{headers:{Cookie:oauthCookie}});
    assert.equal(callback.status,302);
    const cookie=callback.headers.getSetCookie().find(x=>x.startsWith('ag_session=')).split(';')[0];
    const me=await (await request('/api/auth/me',{headers:{Cookie:cookie}})).json();
    return {cookie,csrf:me.csrfToken,id:me.user.id};
  }
  const alice=await login('alice');
  const bob=await login('bob');
  const charlie=await login('charlie');
  const post=(route,user,value)=>request(route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrf}:{})},body:JSON.stringify(value)});
  const list=async user=>(await (await request('/api/listings',{headers:user?{Cookie:user.cookie}:{}})).json());
  assert.equal((await post('/api/listings',null,{issueUrl:'https://github.com/owner/repo/issues/1'})).status,401);
  const created=await post('/api/listings',alice,{issueUrl:'https://github.com/owner/repo/issues/1',acceptance:'Fixture acceptance',aiPolicy:'poster_declared',aiEvidence:'Fixture evidence',amount:10,actor:'bob'});
  assert.equal(created.status,201);
  const quest=await created.json();
  assert.equal(quest.posterId,alice.id);
  const base=`/api/listings/${quest.id}`;
  assert.equal((await post(`${base}/answers`,alice,{text:'Owner must not answer'})).status,403);
  const delivered=await post(`${base}/answers`,bob,{text:'Bob completed the task',actor:'alice',authorId:alice.id});
  assert.equal(delivered.status,201);
  const answer=(await delivered.json()).answers[0];
  assert.equal(answer.authorId,bob.id);
  assert.equal((await post(`${base}/payment`,bob,{action:'accept',answerId:answer.id,actor:'requester'})).status,403);
  assert.equal((await post(`${base}/payment`,charlie,{action:'cancel',actor:'requester'})).status,403);
  assert.equal((await post(`${base}/payment`,null,{action:'cancel'})).status,401);
  assert.equal((await list()).listings.find(x=>x.id===quest.id).reward.status,'ready');
  assert.equal((await post(`${base}/payment`,alice,{action:'accept',answerId:answer.id})).status,200);
  assert.equal((await list()).listings.find(x=>x.id===quest.id).reward.status,'failed');
  assert.equal((await post(`${base}/payment`,bob,{action:'accept',answerId:answer.id})).status,403);
  assert.equal((await list()).listings.find(x=>x.id===quest.id).reward.status,'failed');
  const wallet='0x'+'b'.repeat(40);
  assert.equal((await post('/api/wallet',bob,{wallet,userId:alice.id})).status,200);
  assert.equal((await list(alice)).wallet,'');
  assert.equal((await list(bob)).wallet,wallet);
  assert.equal((await list(charlie)).wallet,'');
  assert.equal((await post(`${base}/payment`,alice,{action:'accept',answerId:answer.id})).status,200);
  const paid=(await list()).listings.find(x=>x.id===quest.id);
  assert.equal(paid.reward.status,'paid');
  assert.equal(paid.reward.paidTo,wallet);
  assert.equal((await post(`${base}/payment`,alice,{action:'accept',answerId:answer.id})).status,400);
  const cancellable=await post('/api/listings',alice,{issueUrl:'https://github.com/owner/repo/issues/3',acceptance:'Fixture acceptance',aiPolicy:'poster_declared',aiEvidence:'Fixture evidence',amount:10});
  assert.equal(cancellable.status,201);
  const cancelId=(await cancellable.json()).id;
  assert.equal((await post(`/api/listings/${cancelId}/payment`,bob,{action:'cancel'})).status,403);
  assert.equal((await post(`/api/listings/${cancelId}/payment`,alice,{action:'cancel'})).status,200);
  assert.equal((await list()).listings.find(x=>x.id===cancelId).reward.status,'cancelled');
  assert.equal((await post('/api/listings/legacy/payment',alice,{action:'cancel'})).status,403);
  assert.equal((await post('/api/listings/legacy/answers',bob,{text:'Cannot answer legacy'})).status,403);
  assert.equal((await list()).listings.find(x=>x.id==='legacy').reward.status,'ready');
});

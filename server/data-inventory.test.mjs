import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {cpSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {DATA_INVENTORY,findReferences,scanStoredData} from './data-inventory.mjs';
import {openStore} from './storage.mjs';

const source=path.dirname(fileURLToPath(import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const aliceWallet='0x'+'a'.repeat(40),bobWallet='0x'+'b'.repeat(40);

test('every field written through the synthetic API flows is in the inventory, and user references are traceable',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'agent-guild-inventory-'));
  cpSync(source,path.join(root,'server'),{recursive:true});
  const dataDir=path.join(root,'data');
  mkdirSync(dataDir);
  // 旧 JSON 移行も含めて、原本・複製・responder_wallet が作られる経路を通す。
  const legacy={id:'legacy-quest',demo:false,posterId:'123',sourceUrl:'https://github.com/owner/repo/issues/1',repo:'owner/repo',number:1,title:'Fixture issue',body:'Fixture',language:'Go',labels:['bug'],state:'open',githubUpdatedAt:'2026-10-12T00:00:00Z',description:'Legacy listing',acceptance:'Legacy acceptance',aiPolicy:'poster_declared',aiEvidence:'Legacy evidence',approvalEvidence:'https://github.com/owner/repo/issues/1#issuecomment-99',approvalStatus:'poster_claimed',working:false,acceptedAnswerId:null,createdAt:'2026-10-12T00:00:00.000Z',answers:[],reward:{amount:5,status:'ready',history:[]}};
  writeFileSync(path.join(dataDir,'listings.json'),JSON.stringify({listings:[legacy],users:{responder:{wallet:aliceWallet}}}));
  const statePath=path.join(root,'fixture-state');
  writeFileSync(statePath,'valid');
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import',path.join(root,'server','ownership.fixture.mjs'),path.join(root,'server','index.mjs')],{env:{...process.env,PORT:String(port),AGENT_GUILD_ORIGIN:origin,AGENT_GUILD_GITHUB_CLIENT_ID:'fixture-id',AGENT_GUILD_GITHUB_CLIENT_SECRET:'fixture-secret',AGENT_GUILD_ADMIN_IDS:'789',AGENT_GUILD_FIXTURE_STATE:statePath},stdio:['ignore','ignore','pipe']});
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  t.after(()=>{child.kill();rmSync(root,{recursive:true,force:true});});
  const request=(route,options={})=>fetch(origin+route,{redirect:'manual',...options});
  let ready=false;
  for(let i=0;i<500;i++){if(child.exitCode!==null)throw new Error(`server exited: ${stderr}`);try{await request('/api/auth/me');ready=true;break;}catch{await sleep(20);}}
  assert.ok(ready,stderr);
  async function login(code){
    const start=await request('/api/auth/login');
    const state=new URL(start.headers.get('location')).searchParams.get('state');
    const oauthCookie=start.headers.getSetCookie()[0].split(';')[0];
    const callback=await request(`/api/auth/callback?code=${code}&state=${state}`,{headers:{Cookie:oauthCookie}});
    assert.equal(callback.status,302);
    const cookie=callback.headers.getSetCookie().find(x=>x.startsWith('ag_session=')).split(';')[0];
    const me=await (await request('/api/auth/me',{headers:{Cookie:cookie}})).json();
    return {cookie,csrf:me.csrfToken};
  }
  const alice=await login('alice'),bob=await login('bob'),admin=await login('charlie');
  const post=(route,user,value={})=>request(route,{method:'POST',headers:{Cookie:user.cookie,'X-CSRF-Token':user.csrf,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});

  const created=await post('/api/listings',alice,{issueUrl:'https://github.com/owner/repo/issues/3',description:'Synthetic note',acceptance:'Fixture acceptance',aiPolicy:'poster_declared',aiEvidence:'Fixture evidence',amount:10});
  assert.equal(created.status,201);
  const id=(await created.json()).id;
  assert.equal((await post('/api/wallet',bob,{wallet:bobWallet})).status,200);
  const answered=await post(`/api/listings/${id}/answers`,bob,{text:'Synthetic completed answer',evidence:'https://github.com/owner/repo/pull/5'});
  assert.equal(answered.status,201);
  const answerId=(await answered.json()).answers[0].id;
  assert.equal((await post('/api/listings/legacy-quest/answers',bob,{text:'Answer on the legacy quest'})).status,201);
  assert.equal((await post('/api/listings/legacy-quest/evidence-check',alice)).status,200);
  assert.equal((await post(`/api/listings/${id}/payment`,alice,{action:'accept',answerId})).status,200);
  assert.equal((await post('/api/listings/legacy-quest/payment',alice,{action:'cancel'})).status,200);
  assert.equal((await post('/api/listings/legacy-quest/payment',alice,{action:'cancel'})).status,409);
  assert.equal((await post('/api/reports',bob,{listingId:'legacy-quest',reason:'Synthetic report reason'})).status,201);
  assert.equal((await post('/api/moderation/legacy-quest',admin,{action:'hide',reason:'Synthetic hide reason'})).status,200);
  assert.equal((await post('/api/moderation/legacy-quest',admin,{action:'restore',reason:'Synthetic restore reason'})).status,200);
  child.kill();
  await once(child,'exit');

  const scan=scanStoredData(dataDir);
  assert.deepEqual(scan.unknownFields,[]);
  assert.deepEqual(scan.unknownTables,[]);
  assert.deepEqual(scan.unknownFiles,[]);
  assert.deepEqual(scan.missingRequired,[]);
  for (const name of ['listings.json','listings.json.backup-{digest}']) assert.ok(scan.observed.includes(name),name);

  const fields=hits=>[...new Set(hits.map(hit=>hit.field))].sort();
  assert.deepEqual(fields(findReferences(dataDir,{userId:'456',wallet:bobWallet})),['answers.payload.authorId','rewards.payload.history[].to','rewards.payload.paidTo','settings[reports][].reporterId','settings[wallet:{userId}]']);
  assert.deepEqual(fields(findReferences(dataDir,{userId:'123',wallet:aliceWallet})),['audit.actor_id','listings.payload.evidenceCheckedBy','listings.payload.posterId','settings[responder_wallet]']);
  assert.deepEqual(fields(findReferences(dataDir,{userId:'789'})),['settings[moderation].{listingId}.updatedBy','settings[moderation_history][].actorId']);
  assert.equal(findReferences(dataDir,{userId:'456'}).filter(hit=>hit.field==='answers.payload.authorId').length,2);
  assert.deepEqual(findReferences(dataDir,{userId:'999',wallet:'0x'+'f'.repeat(40)}),[]);
});

test('unregistered fields, settings keys, tables and files are reported instead of passing silently',t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-inventory-unknown-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const store=openStore(dataDir);
  store.mutate(state=>{state.listings.push({id:'q',posterId:'1',contactEmail:'someone@example.com',answers:[{id:'a',authorId:'2',phone:'000'}],reward:{amount:0,status:'none',history:[],note:'x'}});});
  store.close();
  const db=new DatabaseSync(path.join(dataDir,'listings.sqlite'));
  db.exec("INSERT INTO settings (key,value) VALUES ('newsletter','plain text'); CREATE TABLE sessions (id TEXT)");
  db.close();
  writeFileSync(path.join(dataDir,'export.csv'),'id\n1\n');
  const scan=scanStoredData(dataDir);
  assert.deepEqual(scan.unknownFields,['answers.payload.phone','listings.payload.contactEmail','rewards.payload.note','settings[newsletter]']);
  assert.deepEqual(scan.unknownTables,['sessions']);
  assert.deepEqual(scan.unknownFiles,['export.csv']);
  assert.ok(scan.missingRequired.includes('listings.payload.title'));
});

test('inventory entries are unique and classified',()=>{
  const fields=DATA_INVENTORY.map(item=>item.field);
  assert.equal(new Set(fields).size,fields.length);
  const kinds=new Set(['database','legacy_copy','system','user_id','user_text','github_copy','wallet','moderation']);
  for (const item of DATA_INVENTORY) {
    assert.ok(kinds.has(item.kind),item.field);
    if (item.kind==='user_id') assert.ok(item.refs.includes('user'),item.field);
    if (item.kind==='wallet') assert.ok(item.refs.includes('wallet'),item.field);
  }
});

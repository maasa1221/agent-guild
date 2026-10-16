import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from './storage.mjs';

test('version 1 data gains an audit table without changing existing records',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-audit-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=openStore(dir);
  first.mutate(state=>{
    state.listings.push({id:'existing',answers:[],reward:{amount:10,status:'ready',history:[]}});
    state.wallets['123']='0x'+'a'.repeat(40);
  });
  first.close();
  const old=new DatabaseSync(path.join(dir,'listings.sqlite'));
  old.exec('DROP TABLE audit; PRAGMA user_version = 1');
  old.close();
  const upgraded=openStore(dir);
  assert.equal(upgraded.read().listings[0].id,'existing');
  assert.equal(upgraded.read().wallets['123'],'0x'+'a'.repeat(40));
  assert.deepEqual(upgraded.audit(),[]);
  upgraded.mutate(state=>{state.listings[0].reward.status='cancelled';},{actorId:'123',targetId:'existing',operation:'cancel'});
  assert.deepEqual(upgraded.audit().map(x=>[x.actorId,x.targetId,x.operation,x.result]),[['123','existing','cancel','applied']]);
  upgraded.close();
});

test('audit accepts namespaced Google IDs next to GitHub numeric IDs and rejects malformed actors without saving',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-audit-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=openStore(dir);
  t.after(()=>store.close());
  store.mutate(state=>{state.listings.push({id:'quest',posterId:'google:2001',answers:[],reward:{amount:0,status:'none',history:[]}});});
  store.mutate(state=>{state.listings[0].working=true;},{actorId:'google:2001',targetId:'quest',operation:'accept'});
  store.mutate(()=>{},{actorId:'456',targetId:'quest',operation:'cancel'});
  for (const actorId of ['','0','012','google:','google:a b','google:'+'a'.repeat(256),'github:123','GOOGLE:1','email:alice@fixture-corp.test',123]) {
    assert.throws(()=>store.mutate(state=>{state.listings[0].working=false;},{actorId,targetId:'quest',operation:'accept'}),/監査対象/,String(actorId));
  }
  assert.equal(store.read().listings[0].working,true,'rejected audit rolls back the change');
  assert.deepEqual(store.audit().map(x=>[x.actorId,x.operation,x.result]),[['google:2001','accept','applied'],['456','cancel','applied']]);
});

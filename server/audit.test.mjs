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

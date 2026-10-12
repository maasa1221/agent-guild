import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {openStore} from './storage.mjs';

function fixture(id='quest-1') {
  return {id,sourceUrl:'https://github.com/owner/repo/issues/1',title:'Existing quest',acceptedAnswerId:'answer-1',answers:[{id:'answer-1',text:'Existing answer',createdAt:'2026-10-12T00:00:00Z'}],reward:{amount:10,status:'paid',paidTo:'0xabc',history:[{event:'simulated_payment',at:'2026-10-12T00:00:00Z',to:'0xabc'}]}};
}

function temporaryData(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-storage-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return dir;
}

test('migrates JSON once, preserves original and backup, and persists updates after restart',t=>{
  const dir=temporaryData(t);
  const legacy={listings:[fixture()],users:{responder:{wallet:'0xabc'}}};
  const original=JSON.stringify(legacy);
  const jsonPath=path.join(dir,'listings.json');
  writeFileSync(jsonPath,original);
  const store=openStore(dir);
  assert.deepEqual(store.read(),{...legacy,wallets:{},moderation:{},reports:[],moderationHistory:[]});
  assert.equal(readFileSync(jsonPath,'utf8'),original);
  assert.equal(readFileSync(store.backupPath,'utf8'),original);
  store.mutate(state=>{
    state.listings[0].answers.push({id:'answer-2',text:'New answer'});
    state.listings[0].reward.history.push({event:'checked',at:'2026-10-12T01:00:00Z'});
    state.users.responder.wallet='0xdef';
    state.wallets['123']='0x'+'a'.repeat(40);
  });
  store.close();
  const reopened=openStore(dir);
  assert.equal(reopened.backupPath,null);
  assert.equal(reopened.read().listings[0].answers[1].id,'answer-2');
  assert.equal(reopened.read().listings[0].reward.history.length,2);
  assert.equal(reopened.read().users.responder.wallet,'0xdef');
  assert.equal(reopened.read().wallets['123'],'0x'+'a'.repeat(40));
  assert.equal(reopened.read().wallets['456'],undefined);
  assert.equal(readFileSync(jsonPath,'utf8'),original);
  assert.equal(readdirSync(dir).filter(name=>name.includes('.backup-')).length,1);
  reopened.close();
});

test('transaction rolls back a broken related update; two handles see current data',t=>{
  const dir=temporaryData(t);
  const first=openStore(dir);
  first.mutate(state=>state.listings.push(fixture()));
  const second=openStore(dir);
  assert.throws(()=>second.mutate(state=>{
    state.listings[0].reward.status='failed';
    state.listings[0].answers.push({id:'answer-1',text:'Duplicate ID'});
  }));
  assert.equal(first.read().listings[0].reward.status,'paid');
  assert.equal(first.read().listings[0].answers.length,1);
  second.mutate(state=>{state.users.responder.wallet='0xdef';});
  first.mutate(state=>{state.listings[0].title='Updated after second handle';});
  assert.equal(second.read().listings[0].title,'Updated after second handle');
  assert.equal(second.read().users.responder.wallet,'0xdef');
  first.close();
  second.close();
});

test('invalid legacy JSON leaves original in place without creating a database',t=>{
  const dir=temporaryData(t);
  const jsonPath=path.join(dir,'listings.json');
  for (const invalid of [null,false,0,{listings:'invalid',users:{responder:{wallet:''}}}]) {
    const original=JSON.stringify(invalid);
    writeFileSync(jsonPath,original);
    assert.throws(()=>openStore(dir),/保存データの形式/);
    assert.equal(existsSync(path.join(dir,'listings.sqlite')),false);
    assert.equal(readdirSync(dir).filter(name=>name.includes('.backup-')).length,0);
    assert.equal(readFileSync(jsonPath,'utf8'),original);
  }
});

test('simultaneous first opens cannot replace an already committed database',t=>{
  const dir=temporaryData(t);
  const original=JSON.stringify({listings:[fixture()],users:{responder:{wallet:''}}});
  writeFileSync(path.join(dir,'listings.json'),original);
  const dbPath=path.join(dir,'listings.sqlite');
  const link=fs.linkSync;
  let interleaved=false;
  fs.linkSync=(from,to)=>{
    if (to===dbPath&&!interleaved) {
      interleaved=true;
      const second=openStore(dir);
      second.mutate(state=>{state.users.responder.wallet='0x'+'a'.repeat(40);});
      second.close();
    }
    return link(from,to);
  };
  syncBuiltinESMExports();
  try {
    const first=openStore(dir);
    assert.equal(first.read().users.responder.wallet,'0x'+'a'.repeat(40));
    assert.equal(readdirSync(dir).filter(name=>name.includes('.backup-')).length,1);
    first.close();
  } finally {
    fs.linkSync=link;
    syncBuiltinESMExports();
  }
});

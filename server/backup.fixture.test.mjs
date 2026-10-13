import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from './storage.mjs';

function verifyRestoredCopy(dir,expectedState,expectedAudit) {
  const dbPath=path.join(dir,'listings.sqlite');
  assert.ok(existsSync(dbPath),'バックアップに SQLite DB が必要です。');
  const db=new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally { db.close(); }
  const store=openStore(dir);
  try {
    assert.deepEqual(store.read(),expectedState);
    assert.deepEqual(store.audit(),expectedAudit);
  } finally { store.close(); }
}

test('closed synthetic SQLite store restores twice from one backup; missing or corrupt copies fail verification',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'agent-guild-backup-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source');
  const backup=path.join(root,'backup');
  const restored=path.join(root,'restored');
  const rollback=path.join(root,'rollback');
  const missing=path.join(root,'missing');
  const corrupt=path.join(root,'corrupt');

  const original=openStore(source);
  original.mutate(state=>{
    state.listings.push({
      id:'synthetic-issue',title:'Synthetic issue',posterId:'101',acceptedAnswerId:'answer-2',
      answers:[{id:'answer-1',authorId:'201',text:'First'},{id:'answer-2',authorId:'202',text:'Accepted'}],
      reward:{amount:10,status:'paid',paidTo:'0x'+'a'.repeat(40),history:[{event:'simulated_payment',to:'0x'+'a'.repeat(40)}]},
    });
  },{actorId:'101',targetId:'synthetic-issue',operation:'accept'});
  const expectedState=original.read();
  const expectedAudit=original.audit();
  original.close();

  // 停止後に data/ 全体をコピーし、別の場所で起動し直す。
  cpSync(source,backup,{recursive:true});
  const backupBytes=readFileSync(path.join(backup,'listings.sqlite'));
  cpSync(backup,restored,{recursive:true});
  verifyRestoredCopy(restored,expectedState,expectedAudit);
  const reopened=openStore(restored);
  assert.equal(reopened.read().listings[0].acceptedAnswerId,'answer-2');
  assert.equal(reopened.read().listings[0].answers.length,2);
  reopened.mutate(state=>{state.listings[0].title='Changed only in the restored copy';});
  reopened.close();

  // 復元先が変更されてもバックアップから別の隔離先へ元の状態を復元できる。
  cpSync(backup,rollback,{recursive:true});
  verifyRestoredCopy(rollback,expectedState,expectedAudit);
  assert.deepEqual(readFileSync(path.join(backup,'listings.sqlite')),backupBytes);

  mkdirSync(missing);
  assert.throws(()=>verifyRestoredCopy(missing,expectedState,expectedAudit),/SQLite DB/);
  mkdirSync(corrupt);
  writeFileSync(path.join(corrupt,'listings.sqlite'),'not a SQLite database');
  assert.throws(()=>verifyRestoredCopy(corrupt,expectedState,expectedAudit),/database/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from './storage.mjs';
import {verifyBackup} from './verify-backup.mjs';

// 本番の固定パス（/opt/agent-guild, /var/backups/agent-guild）と実 systemd には触れない。
// backup.sh 本体は固定パスを渡すだけなので実行せず、同じ処理関数を一時ディレクトリと偽の systemctl で呼ぶ。
const root=path.resolve(import.meta.dirname,'..');
const lib=path.join(root,'deploy/backup-lib.sh');
const entry=path.join(root,'deploy/backup.sh');
const verifier=path.join(root,'server/verify-backup.mjs');
const STAMP='20261016-040000';
const ACTOR='987654321';
const MARKER='synthetic-payload-marker';
const WALLET='0x'+'c'.repeat(40);

function tempRoot(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-backup-'));
  assert.ok(dir.startsWith(os.tmpdir()+path.sep));
  t.after(()=>{
    // 権限を外した検証用ディレクトリも消せるように戻す。
    spawnSync('chmod',['-R','u+rwx',dir]);
    rmSync(dir,{recursive:true,force:true});
  });
  return dir;
}

// 偽の systemctl。呼び出しを記録し、状態をファイルで持つ。agent-guild 以外の操作は失敗させる。
function fakeSystemctl(dir,initial) {
  const bin=path.join(dir,'fake-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin,'state'),`${initial}\n`);
  const file=path.join(bin,'fake-systemctl');
  writeFileSync(file,`#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/log"
[ "$2" = agent-guild ] && [ $# -eq 2 ] || exit 64
case "$1" in
  is-active) state=$(cat "$dir/state"); echo "$state"; [ "$state" = active ] ;;
  stop) echo inactive > "$dir/state" ;;
  start) [ -e "$dir/fail-start" ] && exit 1; echo active > "$dir/state" ;;
  *) exit 64 ;;
esac
`);
  chmodSync(file,0o755);
  // 万一 PATH 上の systemctl が呼ばれたら失敗させる。
  const guard=path.join(bin,'systemctl');
  writeFileSync(guard,'#!/bin/sh\necho "real systemctl must not be called" >&2\nexit 99\n');
  chmodSync(guard,0o755);
  return {
    file,bin,
    calls:()=>existsSync(path.join(bin,'log'))?readFileSync(path.join(bin,'log'),'utf8').trim().split('\n'):[],
    state:()=>readFileSync(path.join(bin,'state'),'utf8').trim(),
    failStart:()=>writeFileSync(path.join(bin,'fail-start'),''),
  };
}

function runBackup(systemctl,{src,dest,keep='14',stamp=STAMP}) {
  return spawnSync('bash',['-c','set -euo pipefail; . "$1"; shift; agent_guild_backup "$@"','_',lib,src,dest,keep,stamp,systemctl.file,process.execPath,verifier],{
    encoding:'utf8',
    env:{...process.env,PATH:`${systemctl.bin}:${process.env.PATH}`},
  });
}

function seedStore(dir) {
  const store=openStore(dir);
  store.mutate(state=>{
    state.listings.push({
      id:'synthetic-issue',title:MARKER,posterId:ACTOR,acceptedAnswerId:'answer-2',
      answers:[{id:'answer-1',authorId:'201',text:'First'},{id:'answer-2',authorId:'202',text:'Accepted'}],
      reward:{amount:10,status:'paid',paidTo:WALLET,history:[{event:'simulated_payment',to:WALLET}]},
    });
    state.wallets[ACTOR]=WALLET;
  },{actorId:ACTOR,targetId:'synthetic-issue',operation:'accept'});
  const expected={state:store.read(),audit:store.audit()};
  store.close();
  return expected;
}

function setup(t,{initial='active',seed=true}={}) {
  const dir=tempRoot(t);
  const src=path.join(dir,'data');
  const dest=path.join(dir,'backups');
  const expected=seed?seedStore(src):null;
  if (!seed) mkdirSync(src);
  return {dir,src,dest,expected,systemctl:fakeSystemctl(dir,initial)};
}

function assertNoSecrets(output) {
  for (const value of [ACTOR,MARKER,WALLET,'c'.repeat(20)]) assert.doesNotMatch(output,new RegExp(value));
}

function generation(dest,name) {
  const dir=path.join(dest,name);
  mkdirSync(dir,{recursive:true});
  writeFileSync(path.join(dir,'marker'),name);
}

test('backup copies a stopped store, verifies it and restores the same state twice into isolated directories',t=>{
  const {dir,src,dest,expected,systemctl}=setup(t);
  chmodSync(src,0o750);
  const result=runBackup(systemctl,{src,dest});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(systemctl.calls(),['is-active agent-guild','stop agent-guild','start agent-guild']);
  assert.equal(systemctl.state(),'active');
  assert.match(result.stdout,/verify-backup: ok schema=2 listings=1 answers=2 audit=1/);
  assertNoSecrets(result.stdout+result.stderr);

  const backup=path.join(dest,STAMP);
  assert.deepEqual(readdirSync(dest),[STAMP]);
  assert.equal(statSync(dest).mode&0o777,0o700);
  assert.equal(statSync(backup).mode&0o777,0o750);
  // 検査は読み取り専用で、バックアップに補助ファイルを作らない。
  assert.deepEqual(readdirSync(backup),['listings.sqlite']);
  const backupBytes=readFileSync(path.join(backup,'listings.sqlite'));

  for (const name of ['restore-a','restore-b']) {
    const restored=path.join(dir,name);
    cpSync(backup,restored,{recursive:true});
    assert.deepEqual(verifyBackup(restored),{schema:2,listings:1,answers:2,audit:1});
    const store=openStore(restored);
    try {
      assert.deepEqual(store.read(),expected.state);
      assert.deepEqual(store.audit(),expected.audit);
      store.mutate(state=>{state.listings[0].title='Changed only in this restored copy';});
    } finally { store.close(); }
  }
  assert.deepEqual(readFileSync(path.join(backup,'listings.sqlite')),backupBytes);
});

test('an existing readable backup root is tightened to 0700 while the copied data directory keeps its mode',t=>{
  const {src,dest,systemctl}=setup(t);
  chmodSync(src,0o750);
  mkdirSync(dest);
  chmodSync(dest,0o755);
  const result=runBackup(systemctl,{src,dest});
  assert.equal(result.status,0,result.stderr);
  assert.equal(statSync(dest).mode&0o777,0o700);
  assert.equal(statSync(path.join(dest,STAMP)).mode&0o777,0o750);
});

test('an intentionally stopped service stays stopped after backup',t=>{
  const {src,dest,systemctl}=setup(t,{initial:'inactive'});
  const result=runBackup(systemctl,{src,dest});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(systemctl.calls(),['is-active agent-guild','stop agent-guild']);
  assert.equal(systemctl.state(),'inactive');
});

test('retention keeps the fresh generation and only prunes timestamp generations',t=>{
  const {src,dest,systemctl}=setup(t);
  for (const name of ['20261001-000000','20261002-000000','20261003-000000','20261004-000000','20261005-000000','20991231-000000']) generation(dest,name);
  generation(dest,'manual-copy');
  generation(dest,'20261002-000000.partial');
  const result=runBackup(systemctl,{src,dest,keep:'3'});
  assert.equal(result.status,0,result.stderr);
  // 時計が戻って新しい世代より後ろに並ぶ名前があっても、今回の世代は消さない。
  assert.deepEqual(readdirSync(dest).sort(),['20261002-000000.partial','20261005-000000',STAMP,'20991231-000000','manual-copy'].sort());

  const again=runBackup(systemctl,{src,dest,keep:'1',stamp:'20261017-040000'});
  assert.equal(again.status,0,again.stderr);
  assert.deepEqual(readdirSync(dest).sort(),['20261002-000000.partial','20261017-040000','manual-copy'].sort());
});

test('zero, negative, malformed or too large retention is rejected before stopping the service',t=>{
  const {src,dest,systemctl}=setup(t);
  for (const keep of ['0','-1','abc','1.5','08','1e2','366','',' 3','3 ','14\n1']) {
    const result=runBackup(systemctl,{src,dest,keep});
    assert.notEqual(result.status,0,JSON.stringify(keep));
    assert.match(result.stderr,/AGENT_GUILD_BACKUP_KEEP は 1〜365/,JSON.stringify(keep));
  }
  assert.deepEqual(systemctl.calls(),[]);
  assert.equal(existsSync(dest),false);
  for (const keep of ['1','365']) {
    const result=runBackup(systemctl,{src,dest,keep,stamp:`20261016-0400${keep.padStart(2,'0').slice(-2)}`});
    assert.equal(result.status,0,result.stderr);
  }
});

test('unsafe paths and an existing generation with the same name are refused before stopping the service',t=>{
  const {dir,src,dest,systemctl}=setup(t);
  generation(dest,STAMP);
  chmodSync(dest,0o755);
  const before=readFileSync(path.join(dest,STAMP,'marker'),'utf8');
  const cases=[
    {src,dest},
    {src,dest:path.join(src,'nested')},
    {src:'relative/data',dest},
    {src,dest:`${dir}/./backups`},
    {src,dest:`${dir}/backups/`},
    {src,dest,stamp:'2026-10-16'},
  ];
  for (const options of cases) {
    const result=runBackup(systemctl,options);
    assert.notEqual(result.status,0,JSON.stringify(options));
  }
  rmSync(path.join(dest,STAMP),{recursive:true});
  generation(dest,`${STAMP}.partial`);
  assert.notEqual(runBackup(systemctl,{src,dest}).status,0);
  assert.deepEqual(systemctl.calls(),[]);
  // 拒否した実行では保存先の権限も変えない。
  assert.equal(statSync(dest).mode&0o777,0o755);
  assert.equal(readFileSync(path.join(dest,`${STAMP}.partial`,'marker'),'utf8'),`${STAMP}.partial`);
  assert.equal(before,STAMP);
});

function assertFailedRunKeptGenerations(dest,result,systemctl) {
  assert.equal(result.status,1,result.stdout+result.stderr);
  assertNoSecrets(result.stdout+result.stderr);
  // 以前の世代と無関係な .partial は残り、今回の .partial と未検査の世代は残らない。
  assert.deepEqual(readdirSync(dest).sort(),['20261001-000000','20261002-000000.partial']);
  assert.equal(readFileSync(path.join(dest,'20261001-000000','marker'),'utf8'),'20261001-000000');
  assert.deepEqual(systemctl.calls(),['is-active agent-guild','stop agent-guild','start agent-guild']);
  assert.equal(systemctl.state(),'active');
}

function failingSetup(t,options) {
  const context=setup(t,options);
  generation(context.dest,'20261001-000000');
  generation(context.dest,'20261002-000000.partial');
  return context;
}

test('missing database is refused without creating one, keeps prior generations and restarts the service',t=>{
  const {src,dest,systemctl}=failingSetup(t,{seed:false});
  writeFileSync(path.join(src,'notes.txt'),'not a database');
  const result=runBackup(systemctl,{src,dest,keep:'1'});
  assert.match(result.stderr,/phase=database-file/);
  assertFailedRunKeptGenerations(dest,result,systemctl);
  assert.deepEqual(readdirSync(src),['notes.txt']);
});

test('corrupt, legacy and unsupported schema databases are refused without migrating the original',t=>{
  for (const [name,prepare,phase] of [
    ['corrupt',file=>writeFileSync(file,`not a SQLite database ${MARKER}`),/phase=(open|integrity)/],
    ['schema 1',file=>{const db=new DatabaseSync(file);db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version = 1;`);db.close();},/phase=schema/],
    ['schema 3',file=>{const db=new DatabaseSync(file);db.exec('PRAGMA user_version = 3;');db.close();},/phase=schema/],
  ]) {
    const {src,dest,systemctl}=failingSetup(t,{seed:false});
    const file=path.join(src,'listings.sqlite');
    prepare(file);
    const original=readFileSync(file);
    const result=runBackup(systemctl,{src,dest,keep:'1'});
    assert.match(result.stderr,phase,name);
    assertFailedRunKeptGenerations(dest,result,systemctl);
    assert.deepEqual(readFileSync(file),original,name);
    assert.deepEqual(readdirSync(src),['listings.sqlite'],name);
  }
});

test('copy failure keeps prior generations and restarts the service',{skip:process.getuid?.()===0&&'root can read unreadable files'},t=>{
  const {src,dest,systemctl}=failingSetup(t);
  const locked=path.join(src,'locked');
  mkdirSync(locked);
  writeFileSync(path.join(locked,'file'),'x');
  chmodSync(locked,0o000);
  const result=runBackup(systemctl,{src,dest,keep:'1'});
  assert.match(result.stderr,/コピーに失敗しました/);
  assertFailedRunKeptGenerations(dest,result,systemctl);
});

test('restart failure is reported as failure after publishing the verified backup, without pruning',t=>{
  const {src,dest,systemctl}=failingSetup(t);
  systemctl.failStart();
  const result=runBackup(systemctl,{src,dest,keep:'1'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/再起動に失敗しました/);
  assert.deepEqual(readdirSync(dest).sort(),['20261001-000000','20261002-000000.partial',STAMP]);
  assert.deepEqual(verifyBackup(path.join(dest,STAMP)),{schema:2,listings:1,answers:2,audit:1});
  assert.deepEqual(systemctl.calls(),['is-active agent-guild','stop agent-guild','start agent-guild']);
});

function runVerifier(dir) {
  return spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',verifier,...(dir===undefined?[]:[dir])],{encoding:'utf8'});
}

function phaseOf(dir) {
  try { verifyBackup(dir); return 'ok'; }
  catch (error) { assert.doesNotMatch(String(error.message),new RegExp(`${MARKER}|${ACTOR}`)); return error.phase; }
}

test('restore verification never creates a database and rejects copies the application cannot read',t=>{
  const dir=tempRoot(t);
  const missing=path.join(dir,'missing');
  assert.equal(phaseOf(missing),'directory');
  assert.equal(existsSync(missing),false);
  const empty=path.join(dir,'empty');
  mkdirSync(empty);
  assert.equal(phaseOf(empty),'database-file');
  assert.deepEqual(readdirSync(empty),[]);

  const valid=path.join(dir,'valid');
  seedStore(valid);
  const linked=path.join(dir,'linked');
  mkdirSync(linked);
  symlinkSync(path.join(valid,'listings.sqlite'),path.join(linked,'listings.sqlite'));
  assert.equal(phaseOf(linked),'database-file');

  const broken=(name,sql)=>{
    const copy=path.join(dir,name);
    cpSync(valid,copy,{recursive:true});
    const db=new DatabaseSync(path.join(copy,'listings.sqlite'));
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sql);
    db.close();
    return copy;
  };
  assert.equal(phaseOf(broken('missing-column','ALTER TABLE audit DROP COLUMN result')),'tables');
  assert.equal(phaseOf(broken('missing-table','DROP TABLE settings')),'tables');
  assert.equal(phaseOf(broken('orphan-answer',`INSERT INTO answers (id, listing_id, position, payload) VALUES ('orphan', 'gone', 0, '{"id":"orphan"}')`)),'foreign-keys');
  assert.equal(phaseOf(broken('missing-reward','DELETE FROM rewards')),'data');
  assert.equal(phaseOf(broken('bad-json',`UPDATE listings SET payload = '{"title":"${MARKER}"'`)),'data');
  assert.equal(phaseOf(broken('bad-shape',`UPDATE answers SET payload = '"${MARKER}"'`)),'data');
  assert.equal(phaseOf(broken('bad-settings',`UPDATE settings SET value = '{}' WHERE key = 'reports'`)),'data');
  assert.equal(phaseOf(broken('bad-audit',`UPDATE audit SET at = x'01'`)),'audit');

  const bad=runVerifier(path.join(dir,'bad-json'));
  assert.equal(bad.status,1);
  assert.equal(bad.stderr.trim(),'verify-backup: failed phase=data');
  assertNoSecrets(bad.stdout+bad.stderr);
  assert.equal(runVerifier().status,2);
  const ok=runVerifier(valid);
  assert.equal(ok.status,0,ok.stderr);
  assert.equal(ok.stdout.trim(),'verify-backup: ok schema=2 listings=1 answers=2 audit=1');
});

test('restore verification reads committed WAL content copied with the database',t=>{
  const dir=tempRoot(t);
  const src=path.join(dir,'data');
  seedStore(src);
  const store=openStore(src);
  store.mutate(state=>{state.reports.push({listingId:'synthetic-issue'});});
  // WAL に未反映の更新がある状態でコピーし、アプリと同じく WAL を含めて読めることを確認する。
  const copy=path.join(dir,'copy');
  cpSync(src,copy,{recursive:true});
  store.close();
  assert.ok(statSync(path.join(copy,'listings.sqlite-wal')).size>0);
  assert.deepEqual(verifyBackup(copy),{schema:2,listings:1,answers:2,audit:1});
});

test('production entrypoint keeps fixed paths and default retention, and scripts pass bash syntax checks',()=>{
  const text=readFileSync(entry,'utf8');
  assert.match(text,/^app=\/opt\/agent-guild$/m);
  assert.match(text,/"\$app\/data" \/var\/backups\/agent-guild "\$\{AGENT_GUILD_BACKUP_KEEP:-14\}"/);
  assert.match(text,/systemctl \/usr\/bin\/node "\$app\/server\/verify-backup\.mjs"/);
  for (const file of [entry,lib]) {
    const result=spawnSync('bash',['-n',file],{encoding:'utf8'});
    assert.equal(result.status,0,`${file}: ${result.stderr}`);
  }
});

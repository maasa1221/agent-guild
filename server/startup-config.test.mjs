import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {cpSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from './storage.mjs';

const source=path.dirname(fileURLToPath(import.meta.url));
const BAD={AGENT_GUILD_POST_LIMIT:'invalid',AGENT_GUILD_POST_WINDOW_MS:'0'};

// server/ だけを一時ディレクトリへ複製し、実データ・systemd・OAuth・ネットワークに触れずに起動する。
function isolatedServer(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'agent-guild-startup-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  cpSync(source,path.join(root,'server'),{recursive:true});
  return root;
}

async function freePort() {
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const {port}=listener.address();
  await new Promise(resolve=>listener.close(resolve));
  return port;
}

// 親プロセスの環境は渡さない。待ち受けてしまった場合は timeout で止まり status が null になる。
function start(root,port,env) {
  return spawnSync(process.execPath,[path.join(root,'server','index.mjs')],{env:{PORT:String(port),...env},encoding:'utf8',timeout:10000});
}

// 移行前の形式（schema 1）の合成 DB を作り、WAL を閉じた状態のファイルを返す。
function schemaOneStore(dataDir) {
  const store=openStore(dataDir);
  store.mutate(state=>{state.listings.push({id:'synthetic',answers:[],reward:{amount:0,status:'none',history:[]}});});
  store.close();
  const db=new DatabaseSync(path.join(dataDir,'listings.sqlite'));
  db.exec('DROP TABLE audit; PRAGMA journal_mode = DELETE; PRAGMA user_version = 1');
  db.close();
}

const snapshot=dir=>Object.fromEntries(readdirSync(dir).sort().map(name=>[name,readFileSync(path.join(dir,name))]));
const userVersion=file=>readFileSync(file).readUInt32BE(60);

for (const [key,value] of Object.entries(BAD)) {
  test(`invalid ${key} exits before creating data/ or listening`,async t=>{
    const root=isolatedServer(t);
    const port=await freePort();
    const result=start(root,port,{[key]:value});
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,new RegExp(`投稿制限の設定が正しくありません: ${key}\\n`));
    assert.ok(!result.stderr.includes(`=${value}`) && !result.stderr.includes(`'${value}'`),'値をエラー出力に含めない');
    assert.doesNotMatch(result.stdout,/Agent Guild:/);
    assert.equal(existsSync(path.join(root,'data')),false);
  });

  test(`invalid ${key} leaves an existing schema 1 DB byte-identical and unmigrated`,async t=>{
    const root=isolatedServer(t);
    const data=path.join(root,'data');
    schemaOneStore(data);
    const before=snapshot(data);
    assert.deepEqual(Object.keys(before),['listings.sqlite']);
    assert.equal(userVersion(path.join(data,'listings.sqlite')),1);
    const result=start(root,await freePort(),{[key]:value});
    assert.equal(result.status,1,result.stderr);
    assert.doesNotMatch(result.stdout,/Agent Guild:/);
    assert.deepEqual(snapshot(data),before);
  });
}

test('control: valid settings migrate the same schema 1 DB and listen',async t=>{
  const root=isolatedServer(t);
  const data=path.join(root,'data');
  schemaOneStore(data);
  const port=await freePort();
  const child=spawn(process.execPath,[path.join(root,'server','index.mjs')],{env:{PORT:String(port),AGENT_GUILD_POST_LIMIT:'+05',AGENT_GUILD_POST_WINDOW_MS:'1000'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  let output='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('server did not listen')),10000);
    child.stdout.on('data',chunk=>{output+=chunk;if (output.includes('Agent Guild:')) {clearTimeout(timer);resolve();}});
    child.on('exit',code=>{clearTimeout(timer);reject(new Error(`server exited ${code}`));});
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  await exited;
  const db=new DatabaseSync(path.join(data,'listings.sqlite'),{readOnly:true});
  t.after(()=>db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
});

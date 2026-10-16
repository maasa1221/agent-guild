import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const deploy=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','deploy');
const APP={AGENT_GUILD_ORIGIN:'https://guild.fixture-corp.test',AGENT_GUILD_GITHUB_CLIENT_ID:'fixture-id',AGENT_GUILD_GITHUB_CLIENT_SECRET:'fixture-secret-value',AGENT_GUILD_GITHUB_ORG:'fixture-org',AGENT_GUILD_GOOGLE_CLIENT_ID:'fixture-google-client',AGENT_GUILD_GOOGLE_CLIENT_SECRET:'fixture-google-secret-value',AGENT_GUILD_GOOGLE_DOMAINS:'fixture-corp.test,second-corp.test'};
const CADDY={AGENT_GUILD_DOMAIN:'guild.fixture-corp.test',AGENT_GUILD_ALLOWED_IPS:'10.20.0.0/16 172.16.5.4 fd00:1234::/48'};

// 一時ディレクトリの設定ファイルだけを読む。ホストの変更は行わない。
function preflight(t,app,caddy) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-preflight-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const write=(name,values)=>values&&writeFileSync(path.join(dir,name),Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  write('app.env',app);
  write('caddy.env',caddy);
  return spawnSync('bash',[path.join(deploy,'preflight.sh'),dir],{encoding:'utf8'});
}

test('preflight accepts a complete synthetic configuration',t=>{
  const result=preflight(t,APP,CADDY);
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('preflight rejects missing, partial, example and malformed inputs without printing secrets',t=>{
  const cases={
    'missing app.env':[null,CADDY],
    'missing caddy.env':[APP,null],
    ...Object.fromEntries(Object.keys(APP).map(key=>[`empty ${key}`,[{...APP,[key]:''},CADDY]])),
    ...Object.fromEntries(Object.keys(CADDY).map(key=>[`empty ${key}`,[APP,{...CADDY,[key]:''}]])),
    'example origin':[{...APP,AGENT_GUILD_ORIGIN:'https://agent-guild.example.com'},{...CADDY,AGENT_GUILD_DOMAIN:'agent-guild.example.com'}],
    'origin and domain differ':[APP,{...CADDY,AGENT_GUILD_DOMAIN:'other.fixture-corp.test'}],
    'placeholder organization':[{...APP,AGENT_GUILD_GITHUB_ORG:'your-org'},CADDY],
    'example Google domain':[{...APP,AGENT_GUILD_GOOGLE_DOMAINS:'example.com'},CADDY],
    'wildcard Google domain':[{...APP,AGENT_GUILD_GOOGLE_DOMAINS:'*.fixture-corp.test'},CADDY],
    'uppercase Google domain':[{...APP,AGENT_GUILD_GOOGLE_DOMAINS:'Fixture-corp.test'},CADDY],
    'trailing comma in Google domains':[{...APP,AGENT_GUILD_GOOGLE_DOMAINS:'fixture-corp.test,'},CADDY],
    'empty item in Google domains':[{...APP,AGENT_GUILD_GOOGLE_DOMAINS:'fixture-corp.test,,second-corp.test'},CADDY],
    'documentation CIDR':[APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:'203.0.113.10/32'}],
    'any IPv4':[APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:'10.0.0.0/8 0.0.0.0/0'}],
    'any IPv6':[APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:'::/0'}],
    'bad octet':[APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:'10.0.0.256/32'}],
    'bad prefix':[APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:'10.0.0.0/33'}],
    'hostname instead of CIDR':[APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:'office.fixture-corp.test'}],
  };
  for (const [name,[app,caddy]] of Object.entries(cases)) {
    const result=preflight(t,app,caddy);
    assert.equal(result.status,1,name);
    assert.doesNotMatch(result.stdout+result.stderr,/fixture-secret-value|fixture-google-secret-value/,name);
  }
});

test('allowed IPs accept real IPv4/IPv6 addresses and CIDRs',t=>{
  for (const ips of ['10.0.0.1','10.0.0.0/8','192.168.1.0/24 172.16.0.0/12','10.0.0.1/32','fd00::/8','fd00:1234::/48','2400:cb00:2048:1::c629:d7a2/128','FE80::1','::1','1::','1:2:3:4:5:6:7::','::2:3:4:5:6:7:8','1:2:3:4:5:6:7:8','1:2:3:4:5:6:7:8/64','abcd:ef01::/128']) {
    const result=preflight(t,APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:ips});
    assert.equal(result.status,0,`${ips}: ${result.stdout}${result.stderr}`);
  }
});

test('allowed IPs reject malformed addresses, network-wide and zero-padded prefixes',t=>{
  for (const ips of [
    ':','::::/32',':::1','1:::2','1::2::3','1:2:3:4:5:6:7:8:9/64','1:2:3:4:5:6:7','1:2:3:4:5:6:7:8::','::1:2:3:4:5:6:7:8',':1::','1::2:','12345::1','g::1','::ffff:10.0.0.1',
    '::/0','::/00','fd00::/000','0.0.0.0/0','0.0.0.0/00','10.0.0.0/0','10.0.0.0/08','fd00::/08','fd00::/129','fd00::/','fd00::/1/2','::','0.0.0.0','0.0.0.0/1','::/1',
    '010.0.0.1','10.00.0.1','10.0.0.256','10.0.0','10.0.0.0.1','10.0.0.0/33','10.0.0.0/','/24','10.0.0.0/8/8','10.0.0.0/a','2001:db8::/32','2001:DB8:1::1','2001:0db8::1',
  ]) {
    const result=preflight(t,APP,{...CADDY,AGENT_GUILD_ALLOWED_IPS:`10.20.0.0/16 ${ips}`});
    assert.equal(result.status,1,ips);
  }
});

test('Google domains trim only outer whitespace, matching the runtime parser',t=>{
  for (const domains of [' fixture-corp.test','fixture-corp.test , second-corp.test','fixture-corp.test,\tsecond-corp.test  ']) {
    const result=preflight(t,{...APP,AGENT_GUILD_GOOGLE_DOMAINS:domains},CADDY);
    assert.equal(result.status,0,`${JSON.stringify(domains)}: ${result.stdout}`);
  }
  for (const domains of ['fixture- corp.test','fixture-corp .test','fixture-corp.test, ',' , fixture-corp.test','fixture-corp.test,second corp.test']) {
    const result=preflight(t,{...APP,AGENT_GUILD_GOOGLE_DOMAINS:domains},CADDY);
    assert.equal(result.status,1,JSON.stringify(domains));
  }
});

test('deploy shell scripts parse with bash -n',()=>{
  for (const script of ['preflight.sh','setup.sh','backup.sh']) {
    const result=spawnSync('bash',['-n',path.join(deploy,script)],{encoding:'utf8'});
    assert.equal(result.status,0,`${script}: ${result.stderr}`);
  }
});

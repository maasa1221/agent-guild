import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// setup.sh 本体は実行しない。判定関数のファイルだけを source し、偽の node で版を返す。
const root=path.resolve(import.meta.dirname,'..');
const lib=path.join(root,'deploy/node-version.sh');
const setup=path.join(root,'deploy/setup.sh');

function fakeNode(dir,name,body) {
  const file=path.join(dir,name);
  writeFileSync(file,`#!/bin/sh\n${body}\n`);
  chmodSync(file,0o755);
  return file;
}

function versionOk(bin) {
  const r=spawnSync('bash',['-c','set -euo pipefail; . "$1"; node_version_ok "$2"','_',lib,bin],{encoding:'utf8'});
  return r.status===0;
}

test('node_version_ok accepts only Node.js 22.18.0 or newer stable versions',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'agent-guild-node-version-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cases={
    'v22.9.0':false,'v22.17.1':false,'v21.99.0':false,'v20.19.5':false,
    'v22.18.0':true,'v22.20.0':true,'v24.0.0':true,'v24.11.1':true,'v100.0.0':true,
    '':false,'v22.18':false,'22.18.0':false,'v22.18.0-rc.1':false,'node v24.0.0':false,'vX.Y.Z':false,'v22.18.0\\nv0.0.0':false,
  };
  let i=0;
  for (const [out,expected] of Object.entries(cases)) {
    const bin=fakeNode(dir,`node${i++}`,`printf '${out}\\n'`);
    assert.equal(versionOk(bin),expected,JSON.stringify(out));
  }
  assert.equal(versionOk(fakeNode(dir,'failing','echo v24.0.0; exit 1')),false,'異常終了した node');
  assert.equal(versionOk(path.join(dir,'missing-node')),false,'未インストール');
});

test('setup.sh and the Node.js version helper pass bash syntax checks',()=>{
  for (const file of [setup,lib]) {
    const r=spawnSync('bash',['-n',file],{encoding:'utf8'});
    assert.equal(r.status,0,`${file}: ${r.stderr}`);
  }
});

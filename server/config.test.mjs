import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from './config.mjs';

const GITHUB={AGENT_GUILD_GITHUB_CLIENT_ID:'fixture-id',AGENT_GUILD_GITHUB_CLIENT_SECRET:'fixture-secret'};
const GOOGLE={AGENT_GUILD_GOOGLE_CLIENT_ID:'fixture-google-client',AGENT_GUILD_GOOGLE_CLIENT_SECRET:'fixture-google-secret',AGENT_GUILD_GOOGLE_DOMAINS:'fixture-corp.test'};
const INTERNAL={AGENT_GUILD_ORIGIN:'https://guild.fixture-corp.test',...GITHUB,AGENT_GUILD_GITHUB_ORG:'fixture-org',...GOOGLE};

test('local loopback development keeps anonymous browsing and optional providers',()=>{
  const bare=loadConfig({});
  assert.equal(bare.internal,false);
  assert.equal(bare.requireLogin,false);
  assert.equal(bare.origin,'http://127.0.0.1:46077');
  assert.equal(bare.google,null);
  assert.equal(loadConfig(GITHUB).requireLogin,false);
  assert.equal(loadConfig({...GITHUB,AGENT_GUILD_REQUIRE_LOGIN:'1'}).requireLogin,true);
  assert.equal(loadConfig({...GITHUB,AGENT_GUILD_GITHUB_ORG:'fixture-org'}).requireLogin,true);
  const google=loadConfig(GOOGLE);
  assert.equal(google.requireLogin,true,'a domain allowlist restricts the audience like an organization does');
  assert.deepEqual([...google.google.domains],['fixture-corp.test']);
});

test('an HTTPS origin or AGENT_GUILD_INTERNAL=1 requires both providers, the organization and the domains',()=>{
  const full=loadConfig(INTERNAL);
  assert.equal(full.internal,true);
  assert.equal(full.requireLogin,true);
  assert.equal(loadConfig({...INTERNAL,AGENT_GUILD_INTERNAL:'0'}).internal,true,'HTTPS cannot opt out');
  const missing=(env,pattern)=>assert.throws(()=>loadConfig(env),pattern,JSON.stringify(env));
  for (const key of Object.keys(INTERNAL)) {
    missing({...INTERNAL,AGENT_GUILD_INTERNAL:'1',[key]:''},new RegExp(key));
    // origin を消すとローカル既定値に戻るため、HTTPS だけを根拠にする検査は他の項目で行う。
    if (key!=='AGENT_GUILD_ORIGIN') missing({...INTERNAL,[key]:''},new RegExp(key));
  }
  missing({...INTERNAL,AGENT_GUILD_INTERNAL:'1',AGENT_GUILD_ORIGIN:'http://127.0.0.1:46077'},/AGENT_GUILD_ORIGIN/);
  missing({AGENT_GUILD_INTERNAL:'1'},/AGENT_GUILD_GITHUB_ORG/);
  missing({...INTERNAL,AGENT_GUILD_ORIGIN:'https://agent-guild.example.com'},/AGENT_GUILD_ORIGIN/);
  missing({...INTERNAL,AGENT_GUILD_GITHUB_ORG:'your-org'},/AGENT_GUILD_GITHUB_ORG/);
  missing({...INTERNAL,AGENT_GUILD_GOOGLE_DOMAINS:'example.com'},/AGENT_GUILD_GOOGLE_DOMAINS/);
  missing({...INTERNAL,AGENT_GUILD_GOOGLE_DOMAINS:'fixture-corp.test,*.other.test'},/AGENT_GUILD_GOOGLE_DOMAINS/);
  missing({...INTERNAL,AGENT_GUILD_INTERNAL:'true'},/AGENT_GUILD_INTERNAL/);
});

test('internal mode rejects placeholder OAuth client IDs and secrets by key name only',()=>{
  const placeholders={AGENT_GUILD_GITHUB_CLIENT_ID:'example-client',AGENT_GUILD_GITHUB_CLIENT_SECRET:'example-secret',AGENT_GUILD_GOOGLE_CLIENT_ID:'example-client.apps.googleusercontent.com',AGENT_GUILD_GOOGLE_CLIENT_SECRET:'example-secret'};
  // deploy/preflight.sh と同じく、区切りのない埋め込み（fooexamplebar）も例示値として拒否する。
  const embedded={AGENT_GUILD_GITHUB_CLIENT_ID:'fooexamplebar',AGENT_GUILD_GITHUB_CLIENT_SECRET:'secretexamplevalue',AGENT_GUILD_GOOGLE_CLIENT_ID:'123examplefoo.apps.googleusercontent.com',AGENT_GUILD_GOOGLE_CLIENT_SECRET:'GOCSPX-fooexamplebar'};
  // 従来の PLACEHOLDER で拒否していた your-org と大文字を含む Example も、引き続き拒否する。
  const existing=Object.keys(placeholders).flatMap(key=>[[key,'your-org'],[key,'Example-client'],[key,'fooEXAMPLEbar']]);
  for (const [key,value] of [...Object.entries(placeholders),...Object.entries(embedded),...existing]) {
    assert.throws(()=>loadConfig({...INTERNAL,[key]:value}),error=>{
      const listed=error.message.split(': ')[1]?.split(', ');
      return JSON.stringify(listed)===JSON.stringify([key]) && !error.message.includes(value) && !/fixture-(google-)?secret/.test(error.message);
    },`${key}=${value.length} chars`);
  }
  // ローカル開発では、例示に似た値でも任意設定として受け付ける。
  assert.equal(loadConfig({...GITHUB,AGENT_GUILD_GITHUB_CLIENT_ID:'example-client'}).internal,false);
  assert.equal(loadConfig({...GITHUB,...GOOGLE,AGENT_GUILD_GITHUB_CLIENT_SECRET:'fooexamplebar',AGENT_GUILD_GOOGLE_CLIENT_ID:'fooexamplebar'}).internal,false);
});

test('partial Google settings are rejected in every mode and errors never echo secrets',()=>{
  for (const omit of Object.keys(GOOGLE)) {
    const env={...GITHUB,...GOOGLE,[omit]:''};
    assert.throws(()=>loadConfig(env),error=>/AGENT_GUILD_GOOGLE/.test(error.message)&&!/fixture-(google-)?secret/.test(error.message),omit);
  }
  assert.throws(()=>loadConfig({...INTERNAL,AGENT_GUILD_GITHUB_CLIENT_ID:''}),error=>!error.message.includes('fixture-secret'));
});

const POSTING={
  AGENT_GUILD_POST_LIMIT:{fallback:5,name:'postLimit',accept:[['1',1],['100',100],['05',5],['+7',7],['007',7],[' 10\t',10]],reject:['0','101','-1','invalid','5.5','5.0','1e1','0x10','Infinity','NaN',' ','\t','+','++5','5 5','１０','9'.repeat(400)]},
  AGENT_GUILD_POST_WINDOW_MS:{fallback:60000,name:'postWindowMs',accept:[['1000',1000],['86400000',86400000],['060000',60000],['+1000',1000],[' 2000 ',2000]],reject:['0','999','86400001','-1000','invalid','1000.5','1e3','0x3e8','Infinity','NaN',' ','+','1 000','9'.repeat(400)]},
};

test('posting limits default when absent or empty and accept exact decimal integer bounds',()=>{
  const bare=loadConfig({});
  assert.equal(bare.postLimit,5);
  assert.equal(bare.postWindowMs,60000);
  for (const [key,{fallback,name,accept}] of Object.entries(POSTING)) {
    assert.equal(loadConfig({[key]:''})[name],fallback,`${key} empty`);
    for (const [text,value] of accept) assert.equal(loadConfig({[key]:text})[name],value,`${key}=${JSON.stringify(text)}`);
  }
  // 社内運用モードでも同じ規則で読む。
  const internal=loadConfig({...INTERNAL,AGENT_GUILD_POST_LIMIT:'100',AGENT_GUILD_POST_WINDOW_MS:'1000'});
  assert.deepEqual([internal.postLimit,internal.postWindowMs],[100,1000]);
});

test('invalid posting limits are rejected by key name only, without echoing values',()=>{
  for (const [key,{reject}] of Object.entries(POSTING)) {
    for (const text of reject) {
      // 固定文と項目名だけで、値や秘密値を含まない。
      assert.throws(()=>loadConfig({[key]:text,...GITHUB}),error=>error.message===`投稿制限の設定が正しくありません: ${key}`,`${key}=${JSON.stringify(text.slice(0,20))}`);
    }
  }
  assert.throws(()=>loadConfig({AGENT_GUILD_POST_LIMIT:'invalid',AGENT_GUILD_POST_WINDOW_MS:'0'}),{message:'投稿制限の設定が正しくありません: AGENT_GUILD_POST_LIMIT, AGENT_GUILD_POST_WINDOW_MS'});
});

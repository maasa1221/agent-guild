import {SignJWT,exportJWK,generateKeyPair} from 'jose';

// ownership.fixture.mjs の後に読み込み、Google の固定エンドポイントへの通信だけを合成応答に置き換える。
// 認可コードは `<利用者>.<nonce>` の形でテストが組み立て、nonce は認可 URL から取り出したものを使う。
const {publicKey,privateKey}=await generateKeyPair('RS256',{extractable:true});
const jwk={...await exportJWK(publicKey),kid:'fixture-google-key',alg:'RS256',use:'sig'};
const users={
  galice:{sub:'200000000000000000001',email:'alice@fixture-corp.test',hd:'fixture-corp.test'},
  gbob:{sub:'200000000000000000002',email:'bob@fixture-corp.test',hd:'fixture-corp.test'},
  gsame:{sub:'123',email:'alice@fixture-corp.test',hd:'fixture-corp.test'},
  goutside:{sub:'200000000000000000009',email:'eve@outside.test',hd:'outside.test'},
};
const previous=globalThis.fetch;
globalThis.fetch=async (input,options={})=>{
  const url=String(input);
  const respond=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  if (url==='https://www.googleapis.com/oauth2/v3/certs') return respond({keys:[jwk]});
  if (url==='https://oauth2.googleapis.com/token') {
    const body=new URLSearchParams(options.body);
    const [name,nonce]=String(body.get('code')).split('.');
    const user=users[name];
    if (!user || !nonce || body.get('client_id')!==process.env.AGENT_GUILD_GOOGLE_CLIENT_ID) return new Response('{}',{status:400});
    const idToken=await new SignJWT({...user,email_verified:true,nonce,azp:process.env.AGENT_GUILD_GOOGLE_CLIENT_ID}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer('https://accounts.google.com').setAudience(process.env.AGENT_GUILD_GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return respond({id_token:idToken,access_token:`fixture-google-${name}`,token_type:'Bearer',expires_in:300});
  }
  return previous(input,options);
};

import {readFileSync,writeFileSync} from 'node:fs';

globalThis.fetch=async (input,options={})=>{
  const url=String(input);
  const respond=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  const mode=process.env.AGENT_GUILD_FIXTURE_STATE?readFileSync(process.env.AGENT_GUILD_FIXTURE_STATE,'utf8').trim():'valid';
  if (url==='https://github.com/login/oauth/access_token') {
    const code=new URLSearchParams(options.body).get('code');
    if (!['alice','bob','charlie'].includes(code)) throw new Error('unexpected OAuth code');
    return respond({access_token:`fixture-${code}`});
  }
  if (url==='https://api.github.com/user') {
    const login=options.headers.Authorization?.replace('Bearer fixture-','');
    const id={alice:123,bob:456,charlie:789}[login];
    if (!id) throw new Error('unexpected user token');
    return respond({id,login});
  }
  if (/^https:\/\/api\.github\.com\/repos\/owner\/repo\/issues\/[134]$/.test(url)) {
    const number=Number(url.split('/').at(-1));
    return respond({html_url:`https://github.com/owner/repo/issues/${number}`,number,title:'Fixture issue',body:'Fixture',labels:[],state:mode==='source_changed'?'closed':'open',updated_at:mode==='source_changed'?'2026-10-13T00:00:00Z':'2026-10-12T00:00:00Z'});
  }
  if (url==='https://api.github.com/repos/owner/repo/issues/comments/99') {
    if (mode==='missing') return new Response('{}',{status:404});
    if (mode==='slow_valid') {
      writeFileSync(process.env.AGENT_GUILD_FIXTURE_STATE+'.started','1');
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    return respond({html_url:'https://github.com/owner/repo/issues/1#issuecomment-99',body:mode==='changed'?'Changed public comment':'Original public comment',updated_at:'2026-10-12T00:00:00Z'});
  }
  if (url==='https://api.github.com/repos/owner/repo') return respond({full_name:'owner/repo',language:'Go'});
  throw new Error(`unexpected outbound request: ${url}`);
};

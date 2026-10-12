globalThis.fetch=async (input,options={})=>{
  const url=String(input);
  const respond=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
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
    return respond({html_url:`https://github.com/owner/repo/issues/${number}`,number,title:'Fixture issue',body:'Fixture',labels:[],state:'open',updated_at:'2026-10-12T00:00:00Z'});
  }
  if (url==='https://api.github.com/repos/owner/repo') return respond({full_name:'owner/repo',language:'Go'});
  throw new Error(`unexpected outbound request: ${url}`);
};

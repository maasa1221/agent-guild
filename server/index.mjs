import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseIssueUrl,validateSubmission,applyPaymentTransition} from './core.mjs';
import {openStore} from './storage.mjs';
import {createAuthService} from './auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const store = openStore(path.join(root,'data'));
const PORT = Number(process.env.PORT || 46077);
const auth = createAuthService({clientId:process.env.AGENT_GUILD_GITHUB_CLIENT_ID,clientSecret:process.env.AGENT_GUILD_GITHUB_CLIENT_SECRET,origin:process.env.AGENT_GUILD_ORIGIN||`http://127.0.0.1:${PORT}`});
const demo = [{id:'demo-cli-14647',demo:true,sourceUrl:'https://github.com/cli/cli/issues/14647',repo:'cli/cli',number:14647,title:'gh skill update のヘルプ文を修正する',description:'画面確認用のサンプルクエストです。実際の募集ではありません。',body:'GitHub公開Issueへの参照例。内容と受入条件はこのデモの説明です。',language:'Go',labels:['documentation'],state:'open',acceptance:'ヘルプ文と実際の動作が一致することを確認する。',aiPolicy:'unconfirmed',aiEvidence:'デモのため、maintainerからAI利用許可は確認していません。',approvalEvidence:'',approvalStatus:'unconfirmed',reward:{amount:0,status:'none',history:[]},answers:[],working:false,acceptedAnswerId:null,createdAt:'2026-10-12T00:00:00.000Z'}];

class HttpError extends Error {
  constructor(status,message) { super(message); this.status = status; }
}

function json(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>30000) throw new Error('入力が大きすぎます。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON形式が正しくありません。'); }
}

async function githubIssue(parsed) {
  const headers={'Accept':'application/vnd.github+json','User-Agent':'issue-no-wa-local-demo'};
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),10000);
  try {
    const issueRes=await fetch(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues/${parsed.number}`,{headers,signal:controller.signal});
    if (!issueRes.ok) throw new Error(issueRes.status===404?'Issueが見つかりません。':`GitHub情報を取得できませんでした (${issueRes.status})。`);
    const issue=await issueRes.json();
    if (issue.pull_request) throw new Error('Pull Requestは掲載できません。Issue URLを指定してください。');
    const repoRes=await fetch(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,{headers,signal:controller.signal});
    if (!repoRes.ok) throw new Error('リポジトリ情報を取得できませんでした。');
    const repo=await repoRes.json();
    return {sourceUrl:issue.html_url,repo:repo.full_name,number:issue.number,title:issue.title,body:issue.body||'',language:repo.language||'不明',labels:issue.labels.map(x=>x.name),state:issue.state,githubUpdatedAt:issue.updated_at};
  } catch (e) {
    if (e.name==='AbortError') throw new Error('GitHubへの接続がタイムアウトしました。');
    throw e;
  } finally { clearTimeout(timeout); }
}

function all(state) { return [...state.listings,...demo]; }

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const p=url.pathname;
    if (await auth.handle(req,res,url)) return;
    const write=p.startsWith('/api/')&&req.method!=='GET';
    const session=write?auth.requireSession(req,res,{csrf:true}):null;
    if (write&&!session) return;
    if (req.method==='GET'&&p==='/api/listings') {
      const state=store.read();
      const userId=auth.current(req)?.user.id;
      return json(res,200,{listings:all(state),wallet:userId?state.wallets[userId]||'':''});
    }
    if (req.method==='GET'&&p.startsWith('/api/listings/')) {
      const item=all(store.read()).find(x=>x.id===p.split('/')[3]);
      return json(res,item?200:404,item||{error:'見つかりません。'});
    }
    if (req.method==='POST'&&p==='/api/preview') {
      const input=await body(req);
      return json(res,200,await githubIssue(parseIssueUrl(String(input.issueUrl||''))));
    }
    if (req.method==='POST'&&p==='/api/listings') {
      const input=validateSubmission(await body(req));
      if (all(store.read()).some(x=>x.sourceUrl.toLowerCase()===input.url.toLowerCase())) return json(res,409,{error:'このIssue URLは既に掲載されています。'});
      const gh=await githubIssue(input);
      const item=store.mutate(state=>{
        if (all(state).some(x=>x.sourceUrl.toLowerCase()===gh.sourceUrl.toLowerCase())) throw new HttpError(409,'このIssue URLは既に掲載されています。');
        const listing={id:crypto.randomUUID(),demo:false,posterId:session.user.id,...gh,description:input.description,acceptance:input.acceptance,aiPolicy:'poster_declared',aiEvidence:input.aiEvidence,approvalEvidence:input.approvalEvidence,approvalStatus:input.approvalEvidence?'poster_claimed':'unconfirmed',reward:{amount:input.amount,status:input.amount?'ready':'none',history:[]},answers:[],working:false,acceptedAnswerId:null,createdAt:new Date().toISOString()};
        state.listings.unshift(listing);
        return listing;
      });
      return json(res,201,item);
    }
    if (req.method==='POST'&&p==='/api/wallet') {
      const input=await body(req);
      const wallet=String(input.wallet||'').trim();
      if (wallet&&!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error('デモ用のEVMアドレスを0xから42文字で入力してください。');
      store.mutate(state=>{state.wallets[session.user.id]=wallet;});
      return json(res,200,{wallet});
    }
    const match=p.match(/^\/api\/listings\/([^/]+)\/(answers|payment|start)$/);
    if (req.method==='POST'&&match) {
      const input=await body(req);
      const action=String(input.action||'');
      const auditEntry=match[2]==='payment'?{actorId:session.user.id,targetId:match[1],operation:['accept','cancel'].includes(action)?action:'invalid'}:undefined;
      const item=store.mutate(state=>{
        const listing=state.listings.find(x=>x.id===match[1]);
        if (!listing) throw new HttpError(404,'デモ見本には投稿できません。');
        if (!listing.posterId) throw new HttpError(403,'旧デモ掲載は所有者不明のため操作できません。');
        if (match[2]==='start') {
          if (listing.posterId===session.user.id) throw new HttpError(403,'自分の依頼には回答できません。');
          if (listing.acceptedAnswerId||listing.reward.status==='cancelled') throw new Error('このクエストは開始できません。');
          listing.working=true;
          return listing;
        }
        if (match[2]==='answers') {
          if (listing.posterId===session.user.id) throw new HttpError(403,'自分の依頼には回答できません。');
          const text=String(input.text||'').trim();
          const evidence=String(input.evidence||'').trim();
          if (text.length<10||text.length>3000) throw new Error('納品内容は10〜3000文字で入力してください。');
          if (evidence&&(!/^https:\/\/(github\.com|gist\.github\.com)\//.test(evidence)||evidence.length>500)) throw new Error('成果物URLはGitHubのHTTPS URLにしてください。');
          if (listing.acceptedAnswerId||listing.reward.status==='cancelled') throw new Error('このクエストは回答を受け付けていません。');
          listing.working=true;
          listing.answers.push({id:crypto.randomUUID(),authorId:session.user.id,text,evidence,createdAt:new Date().toISOString()});
          return listing;
        }
        if (listing.posterId!==session.user.id) throw new HttpError(403,'掲載者本人だけが検収・取消できます。');
        const answerId=String(input.answerId||'');
        const selected=action==='accept'?listing.answers.find(answer=>answer.id===answerId):null;
        if (action==='accept'&&!selected?.authorId) throw new HttpError(400,'検収する回答の本人情報を確認できません。');
        const wallet=selected?state.wallets[selected.authorId]||'':'';
        applyPaymentTransition(listing,action,'requester',wallet,answerId);
        return listing;
      },auditEntry);
      return json(res,match[2]==='answers'?201:200,item);
    }
    if (p.startsWith('/api/')) return json(res,404,{error:'APIが見つかりません。'});
    const dist=path.join(root,'dist');
    let target=path.join(dist,p==='/'?'index.html':p);
    if (!target.startsWith(dist+path.sep)) return json(res,403,{error:'Forbidden'});
    let data;
    try {data=await fs.readFile(target);}
    catch {target=path.join(dist,'index.html');data=await fs.readFile(target);}
    const ext=path.extname(target);
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[ext]||'application/octet-stream'});
    res.end(data);
  } catch (e) {
    json(res,e.status||400,{error:e.message||'処理に失敗しました。'});
  }
});

server.listen(PORT,'127.0.0.1',()=>console.log(`Agent Guild: http://127.0.0.1:${PORT}`));

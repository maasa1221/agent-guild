import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseIssueUrl,validateSubmission,applyPaymentTransition} from './core.mjs';
import {openStore} from './storage.mjs';
import {createAuthService} from './auth.mjs';
import {inspectEvidence} from './evidence.mjs';
import {loadConfig} from './config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// 設定の検査は DB を開く前に行い、不足があれば何も変更せずに終了する。
const config = loadConfig(process.env);
const PORT = config.port;
const auth = createAuthService({...config.github,origin:config.origin,requiredOrg:config.requiredOrg,google:config.google});
const store = openStore(path.join(root,'data'));
// 無料版が既定。報奨金・ウォレットの模擬機能はデモ用に明示した場合だけ有効にする。
const rewardsEnabled=process.env.AGENT_GUILD_DEMO_REWARDS==='1';
const requireLogin=config.requireLogin;
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

// 管理者は GitHub の数値 ID だけで指定する。Google のメールや sub は管理者判定に使わない。
const adminIds=new Set((process.env.AGENT_GUILD_ADMIN_IDS||'').split(',').map(id=>id.trim()).filter(id=>/^[1-9][0-9]*$/.test(id)));
const postLimit=Number(process.env.AGENT_GUILD_POST_LIMIT||5);
const postWindowMs=Number(process.env.AGENT_GUILD_POST_WINDOW_MS||60000);
if (!Number.isSafeInteger(postLimit)||postLimit<1||postLimit>100||!Number.isSafeInteger(postWindowMs)||postWindowMs<1000||postWindowMs>86400000) throw new Error('投稿制限の設定が正しくありません。');
function all(state) { return [...state.listings,...demo]; }
function visible(state) {return all(state).filter(item=>!state.moderation[item.id]?.hidden);}
function requireAdmin(session) {if (!adminIds.has(session.user.id)) throw new HttpError(403,'管理者だけが操作できます。');}
function checkPostLimit(state,userId) {
  const since=Date.now()-postWindowMs;
  const count=state.listings.reduce((n,item)=>n+(item.posterId===userId&&Date.parse(item.createdAt)>=since?1:0)+item.answers.filter(answer=>answer.authorId===userId&&Date.parse(answer.createdAt)>=since).length,0);
  if (count>=postLimit) throw new HttpError(429,'投稿が短時間に集中しています。しばらく待ってください。');
}

const sourceStatusCache=new Map();
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const p=url.pathname;
    if (await auth.handle(req,res,url)) return;
    if (requireLogin&&!auth.current(req)) {
      if (p.startsWith('/api/')) return json(res,401,{error:'ログインしてください。'});
      if (!auth.configured) return json(res,503,{error:'ログインが未設定のため利用できません。'});
      // 特定の provider に自動で送らず、設定済みの provider を選ぶ画面に案内する。
      res.writeHead(302,{'Location':'/api/auth/signin','Cache-Control':'no-store'});
      return res.end();
    }
    const write=p.startsWith('/api/')&&req.method!=='GET';
    const session=write?auth.requireSession(req,res,{csrf:true}):null;
    if (write&&!session) return;
    if (req.method==='GET'&&p==='/api/listings') {
      const state=store.read();
      const userId=auth.current(req)?.user.id;
      return json(res,200,{listings:visible(state),wallet:rewardsEnabled&&userId?state.wallets[userId]||'':'',rewards:rewardsEnabled});
    }
    const sourceMatch=p.match(/^\/api\/listings\/([^/]+)\/source-status$/);
    if (req.method==='GET'&&sourceMatch) {
      const state=store.read();
      const item=all(state).find(x=>x.id===sourceMatch[1]);
      if (!item || (state.moderation[item.id]?.hidden && !adminIds.has(auth.current(req)?.user.id))) return json(res,404,{error:'見つかりません。'});
      const cached=sourceStatusCache.get(item.sourceUrl);
      const now=Date.now();
      const currentRequest=cached&&cached.expires>now?cached.request:githubIssue(parseIssueUrl(item.sourceUrl));
      if (!cached||cached.expires<=now) sourceStatusCache.set(item.sourceUrl,{request:currentRequest,expires:now+60000});
      const current=await currentRequest;
      return json(res,200,{snapshot:{title:item.title,state:item.state,updatedAt:item.githubUpdatedAt||null},current:{title:current.title,state:current.state,updatedAt:current.githubUpdatedAt},sourceUrl:item.sourceUrl});
    }
    if (req.method==='GET'&&p.startsWith('/api/listings/')) {
      const state=store.read();
      const item=all(state).find(x=>x.id===p.split('/')[3]);
      const admin=adminIds.has(auth.current(req)?.user.id);
      return json(res,item&&(!state.moderation[item.id]?.hidden||admin)?200:404,item&&(!state.moderation[item.id]?.hidden||admin)?item:{error:'見つかりません。'});
    }
    const evidenceMatch=p.match(/^\/api\/listings\/([^/]+)\/evidence-check$/);
    if (req.method==='POST'&&evidenceMatch) {
      const before=store.read().listings.find(x=>x.id===evidenceMatch[1]);
      if (!before) return json(res,404,{error:'見つかりません。'});
      if (!before.posterId || before.posterId!==session.user.id || store.read().moderation[before.id]?.hidden) return json(res,403,{error:'この掲載の証跡を確認できません。'});
      const checked=await inspectEvidence(before);
      const item=store.mutate(state=>{
        const listing=state.listings.find(x=>x.id===evidenceMatch[1]);
        if (!listing || state.moderation[listing.id]?.hidden || listing.posterId!==session.user.id || (listing.approvalEvidence!==before.approvalEvidence || listing.approvalStatus!==before.approvalStatus || listing.evidenceRevision!==before.evidenceRevision || listing.evidenceCheckedAt!==before.evidenceCheckedAt)) throw new HttpError(409,'掲載状態が変わりました。');
        listing.approvalStatus=checked.status;
        listing.evidenceCheckedBy=session.user.id;
        listing.evidenceCheckedAt=new Date().toISOString();
        listing.evidenceCheckReason=checked.reason||'';
        if (checked.revision) listing.evidenceRevision=checked.revision;
        return listing;
      });
      return json(res,200,item);
    }
    if (req.method==='POST'&&p==='/api/preview') {
      const input=await body(req);
      return json(res,200,await githubIssue(parseIssueUrl(String(input.issueUrl||''))));
    }
    if (req.method==='POST'&&p==='/api/listings') {
      const input=validateSubmission(await body(req));
      if (!rewardsEnabled&&input.amount) throw new HttpError(400,'無料版では報奨金を設定できません。');
      const before=store.read();
      checkPostLimit(before,session.user.id);
      if (all(before).some(x=>x.sourceUrl.toLowerCase()===input.url.toLowerCase())) return json(res,409,{error:'このIssue URLは既に掲載されています。'});
      const gh=await githubIssue(input);
      const item=store.mutate(state=>{
        checkPostLimit(state,session.user.id);
        if (all(state).some(x=>x.sourceUrl.toLowerCase()===gh.sourceUrl.toLowerCase())) throw new HttpError(409,'このIssue URLは既に掲載されています。');
        const listing={id:crypto.randomUUID(),demo:false,posterId:session.user.id,...gh,description:input.description,acceptance:input.acceptance,aiPolicy:'poster_declared',aiEvidence:input.aiEvidence,approvalEvidence:input.approvalEvidence,approvalStatus:input.approvalEvidence?'poster_claimed':'unconfirmed',reward:{amount:input.amount,status:input.amount?'ready':'none',history:[]},answers:[],working:false,acceptedAnswerId:null,createdAt:new Date().toISOString()};
        state.listings.unshift(listing);
        return listing;
      });
      return json(res,201,item);
    }
    if (req.method==='POST'&&p==='/api/wallet') {
      if (!rewardsEnabled) return json(res,404,{error:'無料版ではウォレットを登録できません。'});
      // デモ用ウォレットは GitHub の数値 ID だけに対応する。
      if (!/^[1-9][0-9]*$/.test(session.user.id)) return json(res,403,{error:'デモ用ウォレットは GitHub ログインだけで登録できます。'});
      const input=await body(req);
      const wallet=String(input.wallet||'').trim();
      if (wallet&&!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error('デモ用のEVMアドレスを0xから42文字で入力してください。');
      store.mutate(state=>{state.wallets[session.user.id]=wallet;});
      return json(res,200,{wallet});
    }
    if (req.method==='POST'&&p==='/api/reports') {
      const input=await body(req);
      const listingId=String(input.listingId||'');
      const answerId=String(input.answerId||'');
      const reason=String(input.reason||'').trim();
      if (reason.length<10||reason.length>500) throw new HttpError(400,'通報理由は10〜500文字で入力してください。');
      const report=store.mutate(state=>{
        const listing=state.listings.find(item=>item.id===listingId);
        if (!listing || (answerId&&!listing.answers.some(answer=>answer.id===answerId))) throw new HttpError(404,'通報対象が見つかりません。');
        if (state.reports.some(report=>report.reporterId===session.user.id&&report.listingId===listingId&&report.answerId===(answerId||null))) throw new HttpError(409,'この対象は通報済みです。');
        if (state.reports.filter(report=>report.reporterId===session.user.id&&Date.parse(report.at)>=Date.now()-postWindowMs).length>=postLimit) throw new HttpError(429,'通報が短時間に集中しています。');
        const entry={id:crypto.randomUUID(),reporterId:session.user.id,listingId,answerId:answerId||null,reason,at:new Date().toISOString()};
        state.reports.push(entry);
        return {id:entry.id};
      });
      return json(res,201,report);
    }
    if (req.method==='GET'&&p==='/api/moderation') {
      const viewer=auth.current(req);
      if (!viewer) return json(res,401,{error:'ログインしてください。'});
      requireAdmin(viewer);
      const state=store.read();
      return json(res,200,{reports:state.reports,moderation:state.moderation,history:state.moderationHistory});
    }
    const moderationMatch=p.match(/^\/api\/moderation\/([^/]+)$/);
    if (req.method==='POST'&&moderationMatch) {
      requireAdmin(session);
      const input=await body(req);
      const action=String(input.action||'');
      const reason=String(input.reason||'').trim();
      if (!['hide','restore'].includes(action)||reason.length<10||reason.length>500) throw new HttpError(400,'操作と理由を確認してください。');
      const result=store.mutate(state=>{
        const item=state.listings.find(x=>x.id===moderationMatch[1]);
        if (!item) throw new HttpError(404,'掲載が見つかりません。');
        const hidden=Boolean(state.moderation[item.id]?.hidden);
        if (hidden===(action==='hide')) throw new HttpError(409,'既にその状態です。');
        const at=new Date().toISOString();
        state.moderation[item.id]={hidden:action==='hide',updatedAt:at,updatedBy:session.user.id};
        state.moderationHistory.push({actorId:session.user.id,targetId:item.id,action,at,reason});
        return state.moderation[item.id];
      });
      return json(res,200,result);
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
        if (state.moderation[listing.id]?.hidden) throw new HttpError(403,'非表示の掲載は操作できません。');
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
          checkPostLimit(state,session.user.id);
          listing.working=true;
          listing.answers.push({id:crypto.randomUUID(),authorId:session.user.id,text,evidence,createdAt:new Date().toISOString()});
          return listing;
        }
        if (listing.posterId!==session.user.id) throw new HttpError(403,'掲載者本人だけが検収・取消できます。');
        if (!rewardsEnabled&&listing.reward.amount) throw new HttpError(409,'無料版では報奨金付きの旧掲載を検収・取消できません。');
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

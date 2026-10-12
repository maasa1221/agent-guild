import {createHash} from 'node:crypto';
import {parseIssueUrl} from './core.mjs';

export function parseCommentEvidence(value,sourceUrl) {
  const issue=parseIssueUrl(sourceUrl);
  const url=new URL(value);
  const match=url.hash.match(/^#issuecomment-([1-9][0-9]*)$/);
  if (url.protocol!=='https:' || url.hostname!=='github.com' || url.port || url.username || url.password || url.search || url.pathname!==`/${issue.owner}/${issue.repo}/issues/${issue.number}` || !match) throw new Error('同じIssueの公開コメントURLを指定してください。');
  return {url:url.toString(),apiUrl:`https://api.github.com/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/comments/${match[1]}`};
}

export async function inspectEvidence(listing,{fetcher=fetch}={}) {
  let parsed;
  try {parsed=parseCommentEvidence(listing.approvalEvidence,listing.sourceUrl);} catch {return {status:'verification_unavailable',reason:'URL形式を確認できません。'};}
  try {
    const response=await fetcher(parsed.apiUrl,{headers:{Accept:'application/vnd.github+json','User-Agent':'agent-guild-local'},signal:AbortSignal.timeout(10000)});
    if (!response.ok) return {status:'verification_unavailable',reason:'公開コメントを取得できません。'};
    const comment=await response.json();
    if (comment.html_url!==parsed.url || typeof comment.body!=='string' || !comment.updated_at) return {status:'verification_unavailable',reason:'公開コメントを確認できません。'};
    const revision=createHash('sha256').update(comment.body).digest('hex');
    if (listing.evidenceRevision && listing.evidenceRevision!==revision) return {status:'verification_unavailable',reason:'公開コメントが確認時から変更されました。'};
    return {status:'evidence_checked',revision,url:parsed.url,updatedAt:comment.updated_at};
  } catch {return {status:'verification_unavailable',reason:'公開コメントを取得できません。'};}
}

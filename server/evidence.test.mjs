import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectEvidence,parseCommentEvidence} from './evidence.mjs';

const sourceUrl='https://github.com/owner/repo/issues/1';
const approvalEvidence=sourceUrl+'#issuecomment-99';

test('evidence check accepts only a public comment on the same issue',async()=>{
  assert.equal(parseCommentEvidence(approvalEvidence,sourceUrl).apiUrl,'https://api.github.com/repos/owner/repo/issues/comments/99');
  assert.equal(parseCommentEvidence('https://github.com/OWNER/REPO/issues/1#issuecomment-99',sourceUrl).apiUrl,'https://api.github.com/repos/owner/repo/issues/comments/99');
  for (const bad of ['https://evil.test/owner/repo/issues/1#issuecomment-99','https://github.com/owner/repo/issues/2#issuecomment-99','https://github.com/owner/repo/issues/1#other','javascript:alert(1)']) assert.throws(()=>parseCommentEvidence(bad,sourceUrl));
  const listing={sourceUrl,approvalEvidence};
  const comment={html_url:approvalEvidence,body:'Public comment',updated_at:'2026-10-12T00:00:00Z'};
  const fetcher=async()=>new Response(JSON.stringify(comment),{status:200});
  const checked=await inspectEvidence(listing,{fetcher});
  assert.equal(checked.status,'evidence_checked');
  assert.equal(checked.revision.length,64);
  assert.equal((await inspectEvidence({...listing,approvalEvidence:'https://github.com/OWNER/REPO/issues/1#issuecomment-99'},{fetcher})).status,'evidence_checked');
  assert.equal((await inspectEvidence({...listing,evidenceRevision:checked.revision},{fetcher})).status,'evidence_checked');
  assert.equal((await inspectEvidence({...listing,evidenceRevision:'f'.repeat(64)},{fetcher})).status,'verification_unavailable');
  assert.equal((await inspectEvidence(listing,{fetcher:async()=>new Response('{}',{status:404})})).status,'verification_unavailable');
});

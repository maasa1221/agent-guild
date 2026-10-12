export function parseIssueUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('GitHub Issue URLを入力してください。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('https://github.com のIssue URLだけを指定してください。');
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') throw new Error('URLは github.com/owner/repo/issues/番号 の形式にしてください。');
  return { owner: match[1], repo: match[2], number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` };
}
export function validateSubmission(body) {
  const issue = parseIssueUrl(String(body.issueUrl || ''));
  const acceptance = String(body.acceptance || '').trim();
  const aiEvidence = String(body.aiEvidence || '').trim();
  const description = String(body.description || '').trim();
  const amount = Number(body.amount || 0);
  if (acceptance.length < 10 || acceptance.length > 2000) throw new Error('受入条件は10〜2000文字で入力してください。');
  if (body.aiPolicy !== 'poster_declared') throw new Error('AI利用方針を掲載者として明示してください。');
  if (aiEvidence.length < 8 || aiEvidence.length > 1000) throw new Error('AI利用方針の根拠を8〜1000文字で入力してください。');
  if (description.length > 2000) throw new Error('補足は2000文字以内にしてください。');
  if (!Number.isInteger(amount) || amount < 0 || amount > 100000) throw new Error('報奨金は0〜100000 USDCの整数で入力してください。');
  const approvalEvidence = String(body.approvalEvidence || '').trim();
  if (approvalEvidence.length > 1000) throw new Error('maintainer承認の根拠は1000文字以内にしてください。');
  return { ...issue, acceptance, aiEvidence, description, amount, approvalEvidence };
}
export function applyPaymentTransition(listing, action, actor, wallet) {
  if (actor !== 'requester') throw new Error('このデモでは依頼者のみ操作できます。');
  const reward = listing.reward;
  if (action === 'cancel') {
    if (reward.amount === 0) throw new Error('このIssueに報奨金はありません。');
    if (reward.status !== 'ready' && reward.status !== 'failed') throw new Error('取消できない状態です。');
    reward.status = 'cancelled'; reward.history.push({event:'cancelled',at:new Date().toISOString()}); return;
  }
  if (action !== 'accept') throw new Error('不明な操作です。');
  if (reward.status === 'paid' || reward.status === 'cancelled') throw new Error('支払済みまたは取消済みです。二重払いはできません。');
  if (listing.acceptedAnswerId && reward.status !== 'failed') throw new Error('この回答は検収済みです。');
  if (!listing.answers.length) throw new Error('検収する回答がありません。');
  const answer = listing.answers.find(a => a.id === listing.acceptedAnswerId) || listing.answers[0];
  listing.acceptedAnswerId = answer.id;
  if (reward.amount === 0) { reward.history.push({event:'accepted_no_reward',at:new Date().toISOString()}); return; }
  if (!wallet) { reward.status = 'failed'; reward.history.push({event:'failed_missing_wallet',at:new Date().toISOString()}); return; }
  reward.status = 'paid'; reward.paidTo = wallet; reward.history.push({event:'simulated_payment',at:new Date().toISOString(),to:wallet});
}

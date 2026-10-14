import {DatabaseSync} from 'node:sqlite';
import {existsSync,readdirSync} from 'node:fs';
import path from 'node:path';

// data/ に残り得る保存項目の台帳。kind は削除・開示方針を決めるための区分で、法的な分類ではない。
// refs は利用者や掲載を辿る値: user=GitHub 数値 ID、wallet=公開 EVM アドレス、listing/answer=内部 ID。
const entry=(store,field,kind,refs=[],note='')=>({store,field,kind,refs,note});
const payload=(table,fields)=>fields.map(([field,kind,refs,note])=>entry(table,`${table}.payload.${field}`,kind,refs,note));

export const DATA_INVENTORY=Object.freeze([
  entry('file','listings.sqlite','database',[],'正本の SQLite DB。'),
  {...entry('file','listings.sqlite-wal','database',[],'WAL。未チェックポイントの更新を含み得る。'),optional:true},
  {...entry('file','listings.sqlite-shm','database',[],'WAL の共有メモリ索引。'),optional:true},
  {...entry('file','listings.json','legacy_copy',['user','wallet','listing','answer'],'旧 JSON 原本。移行前の全項目を含み得るため中身は走査しない。'),optional:true},
  {...entry('file','listings.json.backup-{digest}','legacy_copy',['user','wallet','listing','answer'],'移行時に作る旧 JSON の複製。'),optional:true},
  entry('listings','listings.id','system',['listing']),
  ...payload('listings',[
    ['id','system',['listing']],['demo','system'],['posterId','user_id',['user']],
    ['sourceUrl','github_copy'],['repo','github_copy'],['number','github_copy'],['title','github_copy'],['body','github_copy',[],'Issue 本文の複製。個人情報が混入し得る。'],
    ['language','github_copy'],['labels[]','github_copy'],['state','github_copy'],['githubUpdatedAt','github_copy'],
    ['description','user_text'],['acceptance','user_text'],['aiPolicy','system'],['aiEvidence','user_text'],['approvalEvidence','user_text'],['approvalStatus','system'],
    ['evidenceCheckedBy','user_id',['user']],['evidenceCheckedAt','system'],['evidenceCheckReason','system'],['evidenceRevision','system',[],'公開コメント本文の SHA-256。'],
    ['working','system'],['acceptedAnswerId','system',['answer']],['createdAt','system'],
  ]),
  entry('answers','answers.id','system',['answer']),entry('answers','answers.listing_id','system',['listing']),entry('answers','answers.position','system'),
  ...payload('answers',[['id','system',['answer']],['authorId','user_id',['user']],['text','user_text'],['evidence','user_text'],['createdAt','system']]),
  entry('rewards','rewards.listing_id','system',['listing']),
  ...payload('rewards',[
    ['amount','system'],['status','system'],['paidTo','wallet',['wallet'],'模擬支払時点のアドレス。登録変更後も残る。'],
    ['history[].event','system'],['history[].at','system'],['history[].to','wallet',['wallet']],
  ]),
  entry('settings','settings[responder_wallet]','wallet',['wallet'],'旧デモ用の単一アドレス。'),
  entry('settings','settings[wallet:{userId}]','wallet',['user','wallet'],'キーに利用者 ID、値に公開アドレス。空でもキーは残る。'),
  entry('settings','settings[moderation].{listingId}.hidden','moderation'),
  entry('settings','settings[moderation].{listingId}.updatedAt','moderation'),
  entry('settings','settings[moderation].{listingId}.updatedBy','user_id',['user']),
  ...[['id','system'],['reporterId','user_id',['user']],['listingId','system',['listing']],['answerId','system',['answer']],['reason','user_text'],['at','system']]
    .map(([field,kind,refs])=>entry('settings',`settings[reports][].${field}`,kind,refs)),
  ...[['actorId','user_id',['user']],['targetId','system',['listing']],['action','moderation'],['at','system'],['reason','user_text']]
    .map(([field,kind,refs])=>entry('settings',`settings[moderation_history][].${field}`,kind,refs)),
  entry('audit','audit.id','system'),entry('audit','audit.actor_id','user_id',['user']),entry('audit','audit.target_id','system',['listing']),
  entry('audit','audit.operation','system'),entry('audit','audit.at','system'),entry('audit','audit.result','system'),
]);

const TABLES={listings:['id'],answers:['id','listing_id','position'],rewards:['listing_id'],settings:['key','value'],audit:['id','actor_id','target_id','operation','at','result']};
const FILES=[[/^listings\.sqlite$/,'listings.sqlite'],[/^listings\.sqlite-wal$/,'listings.sqlite-wal'],[/^listings\.sqlite-shm$/,'listings.sqlite-shm'],[/^listings\.json$/,'listings.json'],[/^listings\.json\.backup-[0-9a-f]{16}$/,'listings.json.backup-{digest}']];
const known=new Set(DATA_INVENTORY.map(item=>item.field));
// 空の配列・オブジェクト（value が undefined）だけは、既知の項目を持つ入れ物として扱う。単一の値が入れ物の位置にあれば未登録。
const covered=(field,value)=>known.has(field)||(value===undefined&&DATA_INVENTORY.some(item=>item.field.startsWith(field+'.')||item.field.startsWith(field+'[')));

function walk(value,prefix,visit,dynamic) {
  if (Array.isArray(value)) {
    if (!value.length) visit(`${prefix}[]`,undefined);
    for (const item of value) walk(item,`${prefix}[]`,visit,dynamic);
  } else if (value&&typeof value==='object') {
    if (!Object.keys(value).length) visit(prefix,undefined);
    for (const [key,item] of Object.entries(value)) walk(item,`${prefix}.${dynamic[prefix]||key}`,visit,dynamic);
  } else visit(prefix,value);
}

// 保存項目を値と一緒に列挙する。読み取り専用で開き、data/ を変更しない。
function visitStored(dataDir,visit) {
  const files=[];
  for (const name of readdirSync(dataDir)) {
    const match=FILES.find(([pattern])=>pattern.test(name));
    files.push({name,field:match?.[1]||null});
  }
  const dbPath=path.join(dataDir,'listings.sqlite');
  const tables=[];
  if (!existsSync(dbPath)) return {files,tables};
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try {
    for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
      tables.push(name);
      if (!TABLES[name]) continue;
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
        const id=row.id??row.listing_id??row.key;
        if (name==='settings') {
          const field=row.key.startsWith('wallet:')?'settings[wallet:{userId}]':`settings[${row.key}]`;
          if (field==='settings[wallet:{userId}]') visit(field,row.value,{id,user:row.key.slice(7)});
          else if (field==='settings[responder_wallet]') visit(field,row.value,{id});
          else {
            let value;
            try { value=JSON.parse(row.value); } catch { value=row.value; }
            walk(value,field,(f,v)=>visit(f,v,{id}),{'settings[moderation]':'{listingId}'});
          }
          for (const column of Object.keys(row)) if (!TABLES.settings.includes(column)) visit(`settings.${column}`,row[column],{id});
          continue;
        }
        for (const [column,value] of Object.entries(row)) {
          if (column==='payload') walk(JSON.parse(value),`${name}.payload`,(f,v)=>visit(f,v,{id}),{});
          else visit(`${name}.${column}`,value,{id});
        }
      }
    }
  } finally { db.close(); }
  return {files,tables};
}

export function scanStoredData(dataDir) {
  const observed=new Set(),unknown=new Set();
  const {files,tables}=visitStored(dataDir,(field,value)=>{observed.add(field);if (!covered(field,value)) unknown.add(field);});
  for (const file of files) if (file.field) observed.add(file.field);
  return {
    observed:[...observed].sort(),
    unknownFields:[...unknown].sort(),
    unknownTables:tables.filter(name=>!TABLES[name]),
    unknownFiles:files.filter(file=>!file.field).map(file=>file.name).sort(),
    missingRequired:DATA_INVENTORY.filter(item=>!item.optional&&!observed.has(item.field)).map(item=>item.field),
  };
}

// 利用者 ID または公開アドレスが残る場所を列挙する。自由記述欄と data/ 外のバックアップは対象外。
// 旧 JSON とその複製は中身を走査しないため、存在すれば unscanned として必ず返す。
export function findReferences(dataDir,{userId,wallet}={}) {
  userId=userId==null?'':String(userId);
  wallet=wallet==null?'':String(wallet);
  const refs=new Map(DATA_INVENTORY.map(item=>[item.field,item.refs]));
  const hits=[];
  if (userId||wallet) for (const name of readdirSync(dataDir)) {
    const field=FILES.find(([pattern])=>pattern.test(name))?.[1];
    if (DATA_INVENTORY.find(item=>item.field===field)?.kind==='legacy_copy') hits.push({field,row:name,unscanned:true});
  }
  visitStored(dataDir,(field,value,{id,user})=>{
    const kinds=refs.get(field)||[];
    const byUser=userId&&kinds.includes('user')&&(field==='settings[wallet:{userId}]'?user===userId:String(value)===userId);
    const byWallet=wallet&&kinds.includes('wallet')&&typeof value==='string'&&value.toLowerCase()===wallet.toLowerCase();
    if (byUser||byWallet) hits.push({field,row:String(id)});
  });
  return hits;
}

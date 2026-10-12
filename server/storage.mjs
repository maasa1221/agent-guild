import {DatabaseSync} from 'node:sqlite';
import {existsSync,linkSync,mkdirSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const VERSION = 1;
const emptyState = () => ({listings:[],users:{responder:{wallet:''}}});

function configure(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

function createSchema(db) {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE listings (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE answers (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE, position INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(listing_id, position));
    CREATE TABLE rewards (listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = ${VERSION};
    COMMIT;`);
}

function readRows(db) {
  const state = emptyState();
  const answers = new Map();
  for (const row of db.prepare('SELECT listing_id, payload FROM answers ORDER BY listing_id, position').all()) {
    if (!answers.has(row.listing_id)) answers.set(row.listing_id, []);
    answers.get(row.listing_id).push(JSON.parse(row.payload));
  }
  const rewards = new Map(db.prepare('SELECT listing_id, payload FROM rewards').all().map(row => [row.listing_id, JSON.parse(row.payload)]));
  for (const row of db.prepare('SELECT id, payload FROM listings ORDER BY rowid').all()) {
    const listing = JSON.parse(row.payload);
    listing.answers = answers.get(row.id) || [];
    listing.reward = rewards.get(row.id);
    if (!listing.reward) throw new Error(`報奨金データがありません: ${row.id}`);
    state.listings.push(listing);
  }
  state.users.responder.wallet = db.prepare("SELECT value FROM settings WHERE key = 'responder_wallet'").get()?.value || '';
  return state;
}

function writeRows(db, state) {
  if (!Array.isArray(state?.listings) || typeof state?.users?.responder?.wallet !== 'string') throw new Error('保存データの形式が正しくありません。');
  db.prepare('DELETE FROM listings').run();
  const listingInsert = db.prepare('INSERT INTO listings (id, payload) VALUES (?, ?)');
  const answerInsert = db.prepare('INSERT INTO answers (id, listing_id, position, payload) VALUES (?, ?, ?, ?)');
  const rewardInsert = db.prepare('INSERT INTO rewards (listing_id, payload) VALUES (?, ?)');
  for (const listing of state.listings) {
    if (typeof listing?.id !== 'string' || !listing.id || !Array.isArray(listing.answers) || !listing.reward || typeof listing.reward !== 'object') throw new Error('掲載データの形式が正しくありません。');
    const {answers,reward,...fields} = listing;
    listingInsert.run(listing.id, JSON.stringify(fields));
    answers.forEach((answer, position) => {
      if (typeof answer?.id !== 'string' || !answer.id) throw new Error('回答データの形式が正しくありません。');
      answerInsert.run(answer.id, listing.id, position, JSON.stringify(answer));
    });
    rewardInsert.run(listing.id, JSON.stringify(reward));
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('responder_wallet', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(state.users.responder.wallet);
}

function transact(db, change) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = readRows(db);
    const result = change(state);
    if (result && typeof result.then === 'function') throw new Error('保存トランザクション内で非同期処理はできません。');
    writeRows(db, state);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function read(db) {
  db.exec('BEGIN');
  try {
    const state = readRows(db);
    db.exec('COMMIT');
    return state;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function preserveLegacy(jsonPath, original) {
  const digest=createHash('sha256').update(original).digest('hex').slice(0,16);
  const backupPath=`${jsonPath}.backup-${digest}`;
  if (existsSync(backupPath)) {
    if (!readFileSync(backupPath).equals(original)) throw new Error('既存の JSON バックアップが原本と一致しません。');
    return backupPath;
  }
  const tempBackup=`${backupPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempBackup,original,{flag:'wx'});
    try { linkSync(tempBackup,backupPath); }
    catch (error) { if (error.code!=='EEXIST') throw error; }
    if (!readFileSync(backupPath).equals(original)) throw new Error('JSON バックアップが原本と一致しません。');
    return backupPath;
  } finally {
    if (existsSync(tempBackup)) unlinkSync(tempBackup);
  }
}

export function openStore(dataDir) {
  mkdirSync(dataDir, {recursive:true});
  const dbPath = path.join(dataDir, 'listings.sqlite');
  const jsonPath = path.join(dataDir, 'listings.json');
  let backupPath = null;
  if (!existsSync(dbPath)) {
    const tempPath = `${dbPath}.migrating-${randomUUID()}`;
    let temp;
    try {
      const hasLegacy = existsSync(jsonPath);
      let legacy = null;
      let original = null;
      if (hasLegacy) {
        original = readFileSync(jsonPath);
        legacy = JSON.parse(original.toString('utf8'));
        if (!Array.isArray(legacy?.listings) || typeof legacy?.users?.responder?.wallet !== 'string') throw new Error('保存データの形式が正しくありません。');
      }
      temp = new DatabaseSync(tempPath);
      configure(temp);
      createSchema(temp);
      if (hasLegacy) transact(temp, state => {
        state.listings = legacy.listings;
        state.users = legacy.users;
      });
      temp.close();
      temp = null;
      if (hasLegacy) backupPath = preserveLegacy(jsonPath, original);
      try { linkSync(tempPath,dbPath); }
      catch (error) { if (error.code!=='EEXIST') throw error; }
      unlinkSync(tempPath);
    } catch (error) {
      if (temp) temp.close();
      if (existsSync(tempPath)) unlinkSync(tempPath);
      throw error;
    }
  }
  const db = new DatabaseSync(dbPath);
  configure(db);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== VERSION) {
    db.close();
    throw new Error(`未対応の保存形式です (schema ${version})。JSON 原本とバックアップは変更していません。`);
  }
  db.exec('PRAGMA journal_mode = WAL');
  return {dbPath,backupPath,read:()=>read(db),mutate:change=>transact(db,change),close:()=>db.close()};
}

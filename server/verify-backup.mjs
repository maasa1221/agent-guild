// 停止時バックアップと隔離した復元先の data/ を、アプリが読める状態か読み取り専用で検査する。
//   node server/verify-backup.mjs <復元先ディレクトリ>
// DB を作成・移行せず（openStore は呼ばない）、出力は件数と失敗した段階だけにする。
// SQLite や JSON のエラー文は保存内容を含み得るため表示しない。
import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRows} from './storage.mjs';

export const SUPPORTED_SCHEMA = 2;
const TABLES = {
  listings:['id','payload'],
  answers:['id','listing_id','position','payload'],
  rewards:['listing_id','payload'],
  settings:['key','value'],
  audit:['id','actor_id','target_id','operation','at','result'],
};

export class BackupVerificationError extends Error {
  constructor(phase) {
    super(`backup verification failed: ${phase}`);
    this.phase = phase;
  }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// 失敗時の詳細は捨て、段階名だけを返す。
function step(phase, fn) {
  try {
    const ok = fn();
    if (ok === false) throw new BackupVerificationError(phase);
    return ok;
  } catch (error) {
    if (error instanceof BackupVerificationError) throw error;
    throw new BackupVerificationError(phase);
  }
}

function lstatOrNull(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function openReadOnly(dbPath) {
  // 停止後に正常終了した DB には -wal が残らない。その場合は immutable で開き、検査先に -shm/-wal を作らない。
  // 中身のある -wal が残るコピーは、アプリと同じく WAL を含めて読む（-shm だけ作られ得る）。
  const wal = lstatOrNull(`${dbPath}-wal`);
  if (wal && !wal.isFile()) return false;
  const url = pathToFileURL(dbPath);
  if (!wal || wal.size === 0) url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, {readOnly:true});
}

function checkTables(db) {
  for (const [table, columns] of Object.entries(TABLES)) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (!columns.every(column => present.has(column))) return false;
  }
  return true;
}

function checkState(state) {
  if (!Array.isArray(state.listings) || typeof state.users?.responder?.wallet !== 'string') return false;
  if (!isObject(state.wallets) || !Object.values(state.wallets).every(wallet => typeof wallet === 'string')) return false;
  if (!isObject(state.moderation) || !Array.isArray(state.reports) || !Array.isArray(state.moderationHistory)) return false;
  return state.listings.every(listing => isObject(listing) && typeof listing.id === 'string' && listing.id
    && isObject(listing.reward) && Array.isArray(listing.answers)
    && listing.answers.every(answer => isObject(answer) && typeof answer.id === 'string' && answer.id));
}

function checkAudit(rows) {
  return rows.every(row => ['actorId','targetId','operation','at','result'].every(key => typeof row[key] === 'string'));
}

export function verifyBackup(dir) {
  const dbPath = path.join(step('arguments', () => typeof dir === 'string' && dir !== '' && path.resolve(dir)), 'listings.sqlite');
  step('directory', () => lstatOrNull(path.dirname(dbPath))?.isDirectory() === true);
  // シンボリックリンクや欠落を拒否する。欠落時に空 DB を作らないよう、開く前に確認する。
  step('database-file', () => lstatOrNull(dbPath)?.isFile() === true);
  const db = step('open', () => openReadOnly(dbPath));
  try {
    step('integrity', () => {
      const rows = db.prepare('PRAGMA integrity_check').all();
      return rows.length === 1 && rows[0].integrity_check === 'ok';
    });
    step('schema', () => db.prepare('PRAGMA user_version').get().user_version === SUPPORTED_SCHEMA);
    step('tables', () => checkTables(db));
    step('foreign-keys', () => db.prepare('PRAGMA foreign_key_check').all().length === 0);
    const state = step('data', () => {
      db.exec('BEGIN');
      try { return readRows(db); } finally { db.exec('COMMIT'); }
    });
    step('data', () => checkState(state));
    const audit = step('audit', () => db.prepare('SELECT actor_id AS actorId, target_id AS targetId, operation, at, result FROM audit ORDER BY id').all());
    step('audit', () => checkAudit(audit));
    return {
      schema:SUPPORTED_SCHEMA,
      listings:state.listings.length,
      answers:state.listings.reduce((sum, listing) => sum + listing.answers.length, 0),
      audit:audit.length,
    };
  } finally {
    db.close();
  }
}

export function formatSummary(summary) {
  return `verify-backup: ok schema=${summary.schema} listings=${summary.listings} answers=${summary.answers} audit=${summary.audit}`;
}

function main(args) {
  if (args.length !== 1) {
    console.error('usage: node server/verify-backup.mjs <restore-dir>');
    return 2;
  }
  try {
    console.log(formatSummary(verifyBackup(args[0])));
    return 0;
  } catch (error) {
    console.error(`verify-backup: failed phase=${error instanceof BackupVerificationError ? error.phase : 'unexpected'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

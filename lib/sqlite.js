'use strict';

/**
 * One shared SQLite database for the bot's state (node:sqlite, built into
 * Node 22). Replaces the old "rewrite a whole JSON file + .bak copy on every
 * change" approach and the many little WhatsApp login files.
 *
 *   database/bot.sqlite
 *     kv    — small state documents (whitelist, settings, counters, …)
 *     auth  — WhatsApp login keys, one row per key, per account folder
 *
 * WAL journaling + synchronous=NORMAL means a crash or power loss mid-save
 * can lose at most the last instant of writes, but never corrupts the file.
 * The download workers open the same file; busy_timeout lets the two
 * processes take turns instead of failing with "database is locked".
 */

const fs = require('fs');
const path = require('path');

const BOT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(BOT_ROOT, 'database', 'bot.sqlite');

let db = null;
let dbFile = null;

function quietExperimentalWarning() {
  // Node 22 prints a one-time "SQLite is an experimental feature" warning.
  // It is noise for panel users; every other warning still goes through.
  if (process.__zfSqliteWarningFilter) return;
  process.__zfSqliteWarningFilter = true;
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/sqlite/i.test(String(text || '')) && /experimental/i.test(String(text || '') + String(rest[0] || '') + String(rest[0]?.type || ''))) return undefined;
    return original.call(this, warning, ...rest);
  };
}

function filePath() {
  return path.resolve(String(process.env.BOT_DB || DEFAULT_FILE));
}

function open() {
  const file = filePath();
  if (db && dbFile === file) return db;
  if (db) { try { db.close(); } catch { /* replaced */ } db = null; }
  quietExperimentalWarning();
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA busy_timeout = 8000');
  try { handle.exec('PRAGMA journal_mode = WAL'); } catch { /* some network filesystems refuse WAL; rollback journal still protects writes */ }
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth (
      dir   TEXT NOT NULL,
      name  TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (dir, name)
    ) WITHOUT ROWID;
  `);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on panels */ }
  db = handle;
  dbFile = file;
  return db;
}

/** Run `fn` inside one transaction (all-or-nothing). Nested calls join the outer one. */
let depth = 0;
function transaction(fn) {
  const handle = open();
  if (depth > 0) return fn(handle);
  depth++;
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    depth--;
  }
}

function close() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
  dbFile = null;
}

module.exports = { open, close, transaction, filePath, BOT_ROOT, DEFAULT_FILE };

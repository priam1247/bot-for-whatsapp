'use strict';

/**
 * WhatsApp login keys in SQLite.
 *
 * Baileys' `useMultiFileAuthState` keeps one small JSON file per key (often
 * thousands per account) and its own docs say it is not meant for long-term
 * production use. This module stores exactly the same entries as rows of the
 * `auth` table in database/bot.sqlite — one row per (account folder, name) —
 * so every save is a single transactional row write.
 *
 * Names are kept identical to the old files (`creds.json`,
 * `pre-key-1.json`, `lid-mapping-123.json`, …). That keeps the encrypted
 * session backup format unchanged and lets old files be imported as-is: the
 * first time an account folder is opened, its existing *.json files are
 * copied into the database in one transaction and moved into a
 * `.migrated-to-sqlite` sub-folder (never deleted).
 *
 * Folders stay the identity of an account (`session/`, `session/linked/<n>/<id>`),
 * keyed by their path relative to the bot folder so moving the bot keeps logins.
 */

const fs = require('fs');
const path = require('path');
const sqlite = require('./sqlite');

const NAME_RE = /^[A-Za-z0-9_@.+=-]{1,200}\.json$/;
const MIGRATED_DIR = '.migrated-to-sqlite';

const enabled = () => String(process.env.AUTH_STORE || '').toLowerCase() !== 'files';

function dirKey(dir) {
  const resolved = path.resolve(String(dir || ''));
  const rel = path.relative(sqlite.BOT_ROOT, resolved);
  // Folders outside the bot (tests, custom SESSION paths) keep their absolute path.
  return (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? resolved : rel.split(path.sep).join('/');
}

const fixName = (file) => String(file || '').replace(/\//g, '__').replace(/:/g, '-');

function rowsFor(dir) {
  return sqlite.open().prepare('SELECT name, value FROM auth WHERE dir = ?').all(dirKey(dir));
}

function hasRows(dir) {
  return Boolean(sqlite.open().prepare('SELECT 1 AS x FROM auth WHERE dir = ? LIMIT 1').get(dirKey(dir)));
}

/** Legacy *.json files still lying in the folder (not yet imported). */
function diskFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && !item.isSymbolicLink() && NAME_RE.test(item.name))
      .map((item) => item.name);
  } catch { return []; }
}

/**
 * Import a folder's old login files once. Returns how many were imported.
 * Unreadable/invalid files are left in place and skipped.
 */
function migrateDir(dir) {
  if (!enabled()) return 0;
  const names = diskFiles(dir);
  if (!names.length) return 0;
  const key = dirKey(dir);
  const entries = [];
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      JSON.parse(text);
      entries.push([name, text]);
    } catch { /* damaged key file: Baileys would ignore it too */ }
  }
  if (!entries.length) return 0;
  sqlite.transaction((db) => {
    // Never overwrite a newer database copy with an old file.
    const insert = db.prepare('INSERT OR IGNORE INTO auth (dir, name, value) VALUES (?, ?, ?)');
    for (const [name, text] of entries) insert.run(key, name, text);
  });
  const archive = path.join(dir, MIGRATED_DIR);
  try { fs.mkdirSync(archive, { recursive: true, mode: 0o700 }); } catch { /* read-only folder */ }
  for (const [name] of entries) {
    try { fs.renameSync(path.join(dir, name), path.join(archive, name)); } catch { /* left in place; database copy wins */ }
  }
  return entries.length;
}

/** Text of one entry (DB first, then a not-yet-imported file). */
function readText(dir, name) {
  if (enabled()) {
    try {
      const row = sqlite.open().prepare('SELECT value FROM auth WHERE dir = ? AND name = ?').get(dirKey(dir), name);
      if (row) return row.value;
    } catch { /* fall through to the file */ }
  }
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; }
}

function readJson(dir, name) {
  const text = readText(dir, name);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** All entries of a folder as { name: text } (DB rows + not-yet-imported files). */
function listFiles(dir) {
  const files = {};
  for (const name of diskFiles(dir)) {
    try { files[name] = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { /* skip */ }
  }
  if (enabled()) for (const row of rowsFor(dir)) files[row.name] = row.value;
  return files;
}

function hasFiles(dir) {
  if (enabled() && hasRows(dir)) return true;
  return diskFiles(dir).length > 0;
}

/**
 * Install a full set of entries for a folder (session recovery). Refuses to
 * replace existing entries, like the old `{ flag: 'wx' }` file writes.
 */
function installFiles(dir, files, { createDir = true } = {}) {
  if (!enabled()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), value, { flag: 'wx', mode: 0o600 });
    return;
  }
  if (createDir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (hasFiles(dir)) throw Object.assign(new Error('Session folder already has credentials.'), { code: 'EEXIST' });
  const key = dirKey(dir);
  sqlite.transaction((db) => {
    const insert = db.prepare('INSERT INTO auth (dir, name, value) VALUES (?, ?, ?)');
    for (const [name, value] of Object.entries(files)) {
      if (!NAME_RE.test(name)) throw new Error('Session entry name is invalid.');
      insert.run(key, name, String(value));
    }
  });
}

/** Forget every entry of a folder (used when an install must be rolled back). */
function removeDir(dir) {
  if (!enabled()) return;
  sqlite.open().prepare('DELETE FROM auth WHERE dir = ?').run(dirKey(dir));
}

/**
 * Baileys-compatible auth state backed by SQLite (drop-in replacement for
 * useMultiFileAuthState). Writes are synchronous single statements, so no
 * per-file mutexes are needed; key batches are one transaction.
 */
async function useSqliteAuthState(dir, { requireExisting = false } = {}) {
  const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
  if (!enabled()) {
    const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
    return useMultiFileAuthState(dir);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  migrateDir(dir);
  const key = dirKey(dir);
  const db = sqlite.open();
  const select = db.prepare('SELECT value FROM auth WHERE dir = ? AND name = ?');
  const upsert = db.prepare('INSERT INTO auth (dir, name, value) VALUES (?, ?, ?) ON CONFLICT(dir, name) DO UPDATE SET value = excluded.value');
  const remove = db.prepare('DELETE FROM auth WHERE dir = ? AND name = ?');

  const read = (name) => {
    const row = select.get(key, fixName(name));
    if (!row) return null;
    try { return JSON.parse(row.value, BufferJSON.reviver); } catch { return null; }
  };
  // A login that was already linked must never be replaced by a blank one: the
  // next save would overwrite the real login. Say what is wrong instead.
  const credsRow = select.get(key, fixName('creds.json'));
  if (requireExisting) {
    if (!credsRow) throw Object.assign(new Error('Saved WhatsApp login is missing.'), { code: 'AUTH_MISSING' });
    if (!read('creds.json')) throw Object.assign(new Error('Saved WhatsApp login is damaged.'), { code: 'AUTH_CORRUPT' });
  }
  const write = (name, value) => upsert.run(key, fixName(name), JSON.stringify(value, BufferJSON.replacer));

  const creds = read('creds.json') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = read(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          sqlite.transaction(() => {
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const name = `${category}-${id}.json`;
                if (value) write(name, value);
                else remove.run(key, fixName(name));
              }
            }
          });
        },
      },
    },
    saveCreds: async () => { write('creds.json', creds); },
  };
}

module.exports = {
  useSqliteAuthState,
  migrateDir,
  readText,
  readJson,
  listFiles,
  hasFiles,
  installFiles,
  removeDir,
  dirKey,
  enabled,
  MIGRATED_DIR,
};

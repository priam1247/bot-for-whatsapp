/**
 * ZaFar Bot — state persistence
 *
 * The bot's state documents (everything under database/*.json: whitelist,
 * settings, counters, …) now live in ONE SQLite database
 * (database/bot.sqlite, see lib/sqlite.js). Saving a change updates one row
 * inside a transaction instead of rewriting a whole file plus a `.bak` copy,
 * and a crash mid-save can no longer leave a half-written file.
 *
 * The API is unchanged, so callers did not have to change:
 *   writeJsonAtomic(file, data)  → upsert row `database/<name>.json`
 *   readJsonSafe(file, opts)     → read that row
 *
 * Migration is automatic: the first read of a document that is not in the
 * database yet imports the old JSON file (or its `.bak` if the file is
 * damaged), then renames the old files to `*.migrated` so they are never
 * read again. Nothing is deleted.
 *
 * Paths outside database/ (tests, temp files) and STATE_STORE=json keep the
 * previous atomic-file behaviour.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite = require('./sqlite');

const DB_DIR = path.join(sqlite.BOT_ROOT, 'database');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function writeRawAtomic(targetPath, payload) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* some virtual filesystems reject fsync */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** True when `filePath` is a state document that belongs in the database. */
function isDbDocument(filePath) {
  if (String(process.env.STATE_STORE || '').toLowerCase() === 'json') return false;
  const resolved = path.resolve(String(filePath || ''));
  const rel = path.relative(DB_DIR, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (!rel.endsWith('.json')) return false;
  if (rel.split(path.sep)[0] === 'backups') return false;
  return true;
}

const keyOf = (filePath) => `database/${path.relative(DB_DIR, path.resolve(filePath)).split(path.sep).join('/')}`;

// ── file mode (legacy behaviour) ─────────────────────────────────────────────

function writeJsonFile(filePath, payload, keepBackup) {
  const bakPath = `${filePath}.bak`;
  if (keepBackup && fs.existsSync(filePath) && !fs.existsSync(bakPath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      JSON.parse(existing);
      writeRawAtomic(bakPath, existing);
    } catch { /* existing file wasn't valid; new payload will become .bak */ }
  }
  writeRawAtomic(filePath, payload);
  if (keepBackup) {
    try { writeRawAtomic(bakPath, payload); }
    catch (e) { console.warn(`[jsonStore] wrote ${path.basename(filePath)} but could not update .bak: ${e.message}`); }
  }
}

function tryParseFile(filePath, validate) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) throw new Error('file is empty');
  // Modern JSON.parse errors can quote the beginning of the invalid content,
  // including tokens. Return a generic parse error to logs and all callers.
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' }); }
  if (typeof validate === 'function' && !validate(parsed)) {
    throw new Error('JSON structure failed validation');
  }
  return parsed;
}

function readJsonFile(filePath, { defaultValue = {}, validate = null, rewrite = true } = {}) {
  const bakPath = `${filePath}.bak`;
  const hasMain = fs.existsSync(filePath);
  const hasBak = fs.existsSync(bakPath);

  if (!hasMain && !hasBak) {
    return { ok: true, exists: false, recovered: false, corrupt: false, data: clone(defaultValue) };
  }

  let mainErr = null;
  if (hasMain) {
    try {
      return { ok: true, exists: true, recovered: false, corrupt: false, data: tryParseFile(filePath, validate) };
    } catch (err) {
      mainErr = err;
    }
  }

  if (hasBak) {
    try {
      const data = tryParseFile(bakPath, validate);
      console.warn(`[jsonStore] ${path.basename(filePath)} was ${hasMain ? `corrupt (${mainErr.message})` : 'missing'} — restored from ${path.basename(bakPath)}`);
      if (hasMain) { try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ } }
      if (rewrite) {
        try { writeRawAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`); }
        catch (restoreErr) { console.warn(`[jsonStore] could not rewrite restored ${path.basename(filePath)}: ${restoreErr.message}`); }
      }
      return { ok: true, exists: true, recovered: true, corrupt: false, data };
    } catch (bakErr) {
      mainErr = mainErr || bakErr;
    }
  }

  if (hasMain) { try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch { /* ignore */ } }
  return {
    ok: false, exists: true, recovered: false, corrupt: true, data: null,
    error: mainErr || new Error(`corrupt JSON in ${path.basename(filePath)}`),
  };
}

// ── database mode ────────────────────────────────────────────────────────────

function dbGet(key) {
  const row = sqlite.open().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function dbPut(key, payload) {
  sqlite.open()
    .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, payload, Date.now());
}

function retireLegacyFiles(filePath) {
  for (const file of [filePath, `${filePath}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try { fs.renameSync(file, `${file}.migrated`); } catch { /* read-only: the database copy wins anyway */ }
  }
}

/**
 * Serialize `data` and save it. Database documents are one row update inside
 * SQLite's journal; other paths are written atomically with a `.bak` copy.
 */
function writeJsonAtomic(filePath, data, { spaces = 2, keepBackup = true } = {}) {
  if (isDbDocument(filePath)) {
    const payload = JSON.stringify(data);
    JSON.parse(payload); // sanity-check serialization before touching storage
    dbPut(keyOf(filePath), payload);
    return true;
  }
  const payload = `${JSON.stringify(data, null, spaces)}\n`;
  JSON.parse(payload);
  writeJsonFile(filePath, payload, keepBackup);
  return true;
}

/**
 * Read a state document.
 * @returns {{ok:boolean, exists:boolean, recovered:boolean, corrupt:boolean, data:any, error?:Error}}
 * `defaultValue` is returned ONLY when the document does not exist anywhere.
 */
function readJsonSafe(filePath, { defaultValue = {}, validate = null } = {}) {
  if (!isDbDocument(filePath)) return readJsonFile(filePath, { defaultValue, validate });

  const key = keyOf(filePath);
  let raw;
  try { raw = dbGet(key); }
  catch (err) {
    return { ok: false, exists: true, recovered: false, corrupt: true, data: null, error: Object.assign(new Error('State database is unavailable'), { cause: err }) };
  }

  if (raw !== undefined) {
    let data;
    try { data = JSON.parse(raw); }
    catch { return { ok: false, exists: true, recovered: false, corrupt: true, data: null, error: Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' }) }; }
    if (typeof validate === 'function' && !validate(data)) {
      return { ok: false, exists: true, recovered: false, corrupt: true, data: null, error: new Error('JSON structure failed validation') };
    }
    return { ok: true, exists: true, recovered: false, corrupt: false, data };
  }

  // Not in the database yet: import the old JSON file once.
  const legacy = readJsonFile(filePath, { defaultValue, validate, rewrite: false });
  if (legacy.ok && legacy.exists) {
    try {
      dbPut(key, JSON.stringify(legacy.data));
      retireLegacyFiles(filePath);
    } catch (err) {
      console.warn(`[jsonStore] could not import ${path.basename(filePath)} into the database: ${err.message}`);
    }
  }
  return legacy;
}

/** Remove a document (database row or file). */
function removeJson(filePath) {
  if (isDbDocument(filePath)) {
    sqlite.open().prepare('DELETE FROM kv WHERE key = ?').run(keyOf(filePath));
    return true;
  }
  for (const file of [filePath, `${filePath}.bak`]) { try { fs.unlinkSync(file); } catch { /* absent */ } }
  return true;
}

/** True when the document exists (database row, or file / .bak). Imports legacy files. */
function documentExists(filePath) {
  if (!isDbDocument(filePath)) return fs.existsSync(filePath) || fs.existsSync(`${filePath}.bak`);
  try {
    if (dbGet(keyOf(filePath)) !== undefined) return true;
  } catch { return true; /* unknown: never treat as missing (callers would write defaults) */ }
  return readJsonSafe(filePath, { defaultValue: null }).exists;
}

/** Save pre-serialized JSON text (large documents such as the paper vault snapshot). */
function writeJsonText(filePath, text) {
  JSON.parse(text);
  if (isDbDocument(filePath)) { dbPut(keyOf(filePath), text); return true; }
  writeRawAtomic(filePath, text);
  try { writeRawAtomic(`${filePath}.bak`, text); } catch { /* non-fatal */ }
  return true;
}

module.exports = {
  documentExists,
  writeJsonText,
  writeRawAtomic,
  writeJsonAtomic,
  readJsonSafe,
  removeJson,
  isDbDocument,
};

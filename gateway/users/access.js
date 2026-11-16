/**
 * ZaFar Bot — Allowed users (the `.allow` list)
 *
 * Shared by gateway/guards.js and commands/users.
 *
 * - allowed.json holds the numbers a session allowed with `.allow`. Only the
 *   WhatsApp commands write it.
 * - Atomic writes (one transaction) with a last-good copy kept in memory.
 * - A corrupt allowed.json recovers from .bak or the in-memory last-good state
 *   and NEVER silently degrades to "no users" (which would wipe the list on
 *   the next allow/disallow write).
 */

const fs = require('fs');
const path = require('path');
const { jidVariants } = require('../../lib/jid');
const accountSockets = require('../../lib/accountSockets');
const { writeJsonAtomic, readJsonSafe, documentExists } = require('../../lib/jsonStore');

const DB_PATH = path.join(__dirname, '../../database');
const ALLOWED_DB = path.join(DB_PATH, 'allowed.json');
// Older versions kept `.allow` entries inside whitelist.json. They are copied
// once into allowed.json if that file does not exist yet; whitelist.json is
// never written again.
const LEGACY_DB = path.join(DB_PATH, 'whitelist.json');

const isValidList = (d) => Boolean(d && typeof d === 'object' && Array.isArray(d.users));

if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

// ─── Cache (10s TTL) + last-good memory copy ──────────────────────────────────

let _cache = null;
let _lastGood = null;
let _corrupt = false;
let _time = 0;
const CACHE_TTL = 10_000;

const clone = (v) => JSON.parse(JSON.stringify(v));

// One-time move of old `.allow` entries. Copies only.
function seedAllowedFromLegacy() {
  let legacy = [];
  try {
    const res = readJsonSafe(LEGACY_DB, { defaultValue: { users: [] }, validate: isValidList });
    if (!res.ok) return false; // retry once it is readable
    legacy = res.data.users;
  } catch { return false; }
  const users = legacy
    .filter((u) => u && (u.allowedVia || u.addedBy === 'whatsapp'))
    .map((u) => ({
      number: u.number,
      ...(Array.isArray(u.alt) && u.alt.length ? { alt: u.alt } : {}),
      ...(u.label ? { label: u.label } : {}),
      addedBy: 'whatsapp',
      ...(u.allowedVia ? { allowedVia: u.allowedVia } : {}),
      enabled: u.enabled !== false,
      addedAt: Number(u.addedAt) || Date.now(),
    }));
  writeJsonAtomic(ALLOWED_DB, { users });
  return true;
}

// Collapse entries that are the same person (any shared PN/LID) into the OLDEST one,
// keeping its Parent (allowedVia) and merging every known ID into `alt`.
function dedupeUsers(users) {
  const ids = users.map((u) => {
    const set = jidVariants([u.number, ...(u.alt || [])].filter(Boolean).map(String));
    [u.number, ...(u.alt || [])].filter(Boolean).forEach((x) => set.add(String(x)));
    return set;
  });
  const used = new Set();
  const out = [];
  let changed = false;
  for (let i = 0; i < users.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    const all = new Set(ids[i]);
    used.add(i);
    for (let grew = true; grew;) {
      grew = false;
      for (let j = 0; j < users.length; j++) {
        if (used.has(j) || ![...ids[j]].some((x) => all.has(x))) continue;
        used.add(j); group.push(j); ids[j].forEach((x) => all.add(x)); grew = true;
      }
    }
    if (group.length === 1) { out.push(users[i]); continue; }
    changed = true;
    const members = group.map((k) => users[k]);
    const base = members.reduce((a, b) => (Number(b.addedAt) || Infinity) < (Number(a.addedAt) || Infinity) ? b : a);
    const alt = [...all].filter((x) => x !== String(base.number));
    out.push({ ...base, ...(alt.length ? { alt } : {}) });
  }
  return { users: out, changed };
}

const readAllowed = ({ force = false, filePath = ALLOWED_DB } = {}) => {
  const isDefaultFile = filePath === ALLOWED_DB;
  if (isDefaultFile && !force && !_corrupt && _cache && Date.now() - _time < CACHE_TTL) return _cache;
  if (isDefaultFile && !documentExists(ALLOWED_DB) && !seedAllowedFromLegacy()) return { users: [] };

  const res = readJsonSafe(filePath, { defaultValue: { users: [] }, validate: isValidList });
  if (res.ok) {
    if (!res.exists) {
      try { writeJsonAtomic(filePath, res.data); } catch { /* ignore */ }
    }
    if (isDefaultFile && Array.isArray(res.data.users)) {
      const d = dedupeUsers(res.data.users);
      if (d.changed) {
        res.data = { ...res.data, users: d.users };
        try { writeJsonAtomic(filePath, res.data); } catch { /* ignore */ }
      }
    }
    if (isDefaultFile) {
      _cache = res.data;
      _lastGood = clone(res.data);
      _corrupt = false;
      _time = Date.now();
    }
    return res.data;
  }

  // Corrupt on disk AND no valid .bak — try the in-memory last-good copy first
  if (isDefaultFile && _lastGood && isValidList(_lastGood)) {
    console.error('[accessControl] allowed.json corrupted on disk — restoring from in-memory last-good copy');
    try { writeJsonAtomic(filePath, _lastGood); } catch { /* ignore */ }
    _cache = clone(_lastGood);
    _corrupt = false;
    _time = Date.now();
    return _cache;
  }

  if (isDefaultFile) {
    _corrupt = true;
    _cache = null;
  }
  const err = new Error(
    `${path.basename(filePath)} is corrupt and has no valid .bak backup — refusing to treat it as an empty user list`
  );
  err.code = 'ALLOWED_CORRUPT';
  console.error(`[accessControl] ${err.message}`);
  throw err;
};

const writeAllowed = (data, { filePath = ALLOWED_DB, forceRecovery = false } = {}) => {
  if (!isValidList(data)) {
    throw new Error('Refusing to write invalid allowed-users payload (expected { users: [...] })');
  }
  const isDefaultFile = filePath === ALLOWED_DB;
  if (isDefaultFile && _corrupt && !forceRecovery) {
    const err = new Error('Refusing to overwrite corrupt allowed.json before manual/backup recovery');
    err.code = 'ALLOWED_CORRUPT';
    throw err;
  }

  writeJsonAtomic(filePath, data);
  if (isDefaultFile) {
    _cache = data;
    _lastGood = clone(data);
    _corrupt = false;
    _time = Date.now();
  }
  return true;
};

const _resetCacheForTests = () => {
  _cache = null;
  _lastGood = null;
  _corrupt = false;
  _time = 0;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const cleanNumber = (raw) => {
  if (!raw) return null;
  const n = raw.replace(/@.*/, '').replace(/[^0-9]/g, '').trim();
  return n.length >= 7 ? n : null;
};

// Index of the allowed entry that matches any known form (PN or LID) of these JIDs
const findUserIndex = (users, ids, sessionDir = null) => {
  const v = jidVariants(ids, sessionDir);
  if (!v.size) return -1;
  return users.findIndex(u => v.has(u.number) || (u.alt || []).some(a => v.has(a)));
};

// An entry with `enabled: false` is paused and does not count.
const isApprovedUser = (user) => Boolean(user && user.enabled !== false);

const findAllowedUserIndex = (users, ids, sessionDir = null) => {
  const idx = findUserIndex(users, ids, sessionDir);
  if (idx === -1) return -1;
  return isApprovedUser(users[idx]) ? idx : -1;
};

/**
 * The Parent of an allowed user: the linked number (session) that allowed them.
 * Entries with no recorded parent belong to the Owner's own session, never to
 * "whoever answers first".
 */
const parentOf = (user) => String(user?.allowedVia || accountSockets.PRIMARY_SESSION);
const isParentSession = (user, sock) => parentOf(user) === accountSockets.sessionKey(sock);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ALLOWED_DB,
  readAllowed,
  writeAllowed,
  cleanNumber,
  findUserIndex,
  findAllowedUserIndex,
  isApprovedUser,
  parentOf,
  isParentSession,
  _resetCacheForTests,
};

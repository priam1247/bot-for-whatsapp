#!/usr/bin/env node
'use strict';

// SQLite storage: state documents (database/*.json → database/bot.sqlite)
// and WhatsApp login keys (session files → auth table). Runs in a fixture
// copy so the real database is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-storage-'));
const ROOT = createBotFixture(TMP);
process.chdir(ROOT);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DB_DIR = path.join(ROOT, 'database');
fs.mkdirSync(DB_DIR, { recursive: true });
const store = require(path.join(ROOT, 'lib/jsonStore'));
const sqlite = require(path.join(ROOT, 'lib/sqlite'));
const authStore = require(path.join(ROOT, 'lib/authStore'));

test('state documents are saved in database/bot.sqlite, not as JSON files', () => {
  const file = path.join(DB_DIR, 'botstate.json');
  store.writeJsonAtomic(file, { on: false });
  assert.equal(fs.existsSync(file), false, 'no JSON file written');
  assert.equal(fs.existsSync(`${file}.bak`), false, 'no .bak copy written');
  assert.ok(fs.existsSync(path.join(DB_DIR, 'bot.sqlite')));
  assert.deepEqual(store.readJsonSafe(file).data, { on: false });
  assert.equal(store.documentExists(file), true);
  assert.equal(store.documentExists(path.join(DB_DIR, 'nothing.json')), false);
});

test('an existing JSON file (or its .bak when damaged) is imported once and kept as *.migrated', () => {
  const file = path.join(DB_DIR, 'whitelist.json');
  fs.writeFileSync(file, '{ broken');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ users: [{ number: '265991111111' }] }));
  const first = store.readJsonSafe(file, { validate: (d) => Array.isArray(d?.users) });
  assert.equal(first.ok, true);
  assert.equal(first.data.users[0].number, '265991111111');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.migrated`), true, 'old file kept, never deleted');
  // Later reads come from the database even if an old file reappears.
  fs.writeFileSync(file, JSON.stringify({ users: [] }));
  assert.equal(store.readJsonSafe(file).data.users.length, 1);
});

test('database.js keeps migrated state instead of writing defaults over it', () => {
  fs.writeFileSync(path.join(DB_DIR, 'paper_log.json'), JSON.stringify({ chat: { 1: Date.now() } }));
  const result = spawnSync(process.execPath, ['-e', `
    const db = require(${JSON.stringify(path.join(ROOT, 'lib/database'))});
    console.log(JSON.stringify({ on: db.getBotState() }));
    const s = require(${JSON.stringify(path.join(ROOT, 'lib/jsonStore'))});
    console.log(JSON.stringify(s.readJsonSafe(${JSON.stringify(path.join(DB_DIR, 'paper_log.json'))}).data));
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [state, log] = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(state, { on: false }, 'saved bot state survives a restart');
  assert.ok(log.chat, 'imported paper log is not replaced by defaults');
});

test('paths outside database/ keep the atomic JSON file behaviour', () => {
  const file = path.join(TMP, 'outside.json');
  store.writeJsonAtomic(file, { a: 1 });
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.bak`));
  assert.deepEqual(store.readJsonSafe(file).data, { a: 1 });
});

test('main process and a worker can write at the same time without "database is locked"', async () => {
  const file = path.join(DB_DIR, 'concurrency.json');
  const script = (tag) => `
    const s = require(${JSON.stringify(path.join(ROOT, 'lib/jsonStore'))});
    for (let i = 0; i < 300; i++) s.writeJsonAtomic(${JSON.stringify(file)}.replace('.json', '-${tag}.json'), { i });
  `;
  const run = (tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script(tag)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  const results = await Promise.all([run('a'), run('b'), run('c')]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  for (const tag of ['a', 'b', 'c']) assert.deepEqual(store.readJsonSafe(file.replace('.json', `-${tag}.json`)).data, { i: 299 });
});

test('a process killed mid-save never corrupts the database', async () => {
  const child = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(ROOT, 'lib/jsonStore'))});
    let i = 0; for (;;) s.writeJsonAtomic(${JSON.stringify(path.join(DB_DIR, 'killed.json'))}, { i: i++, pad: 'x'.repeat(5000) });
  `], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  const check = sqlite.open().prepare('PRAGMA integrity_check').get();
  assert.equal(Object.values(check)[0], 'ok');
  const saved = store.readJsonSafe(path.join(DB_DIR, 'killed.json'));
  assert.equal(saved.ok, true);
  assert.ok(saved.data.i > 0);
});

test('WhatsApp login: old session files are imported once into SQLite and archived', async () => {
  const dir = path.join(ROOT, 'session');
  fs.mkdirSync(dir, { recursive: true });
  const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
  const creds = initAuthCreds();
  creds.registered = true;
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
  fs.writeFileSync(path.join(dir, 'pre-key-1.json'), JSON.stringify({ public: Buffer.from('pub'), private: Buffer.from('priv') }, BufferJSON.replacer));
  fs.writeFileSync(path.join(dir, 'lid-mapping-111_reverse.json'), JSON.stringify('265990000001'));

  const auth = await authStore.useSqliteAuthState(dir);
  assert.equal(auth.state.creds.registered, true);
  assert.equal(auth.state.creds.registrationId, creds.registrationId);
  const keys = await auth.state.keys.get('pre-key', ['1']);
  assert.equal(Buffer.from(keys['1'].private).toString(), 'priv');
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false, 'files moved out of the way');
  assert.equal(fs.existsSync(path.join(dir, authStore.MIGRATED_DIR, 'creds.json')), true, 'originals archived, not deleted');
  assert.equal(require(path.join(ROOT, 'lib/jid')).normalizeJidWithLid('111@lid', dir), '265990000001@s.whatsapp.net');
});

test('WhatsApp login: keys and creds round-trip through SQLite like the file store', async () => {
  const dir = path.join(ROOT, 'session', 'linked', '265990000002', 'a'.repeat(24));
  const auth = await authStore.useSqliteAuthState(dir);
  auth.state.creds.me = { id: '265990000002:1@s.whatsapp.net' };
  await auth.saveCreds();
  await auth.state.keys.set({ session: { 'abc:1': { record: Buffer.from('r1') } }, 'pre-key': { 5: { public: Buffer.from('p') } } });
  await auth.state.keys.set({ 'pre-key': { 5: null } });
  const again = await authStore.useSqliteAuthState(dir);
  assert.equal(again.state.creds.me.id, '265990000002:1@s.whatsapp.net');
  const got = await again.state.keys.get('session', ['abc:1']);
  assert.equal(Buffer.from(got['abc:1'].record).toString(), 'r1');
  assert.deepEqual(await again.state.keys.get('pre-key', ['5']), { 5: null });
  // Same names as the old files.
  assert.deepEqual(Object.keys(authStore.listFiles(dir)).sort(), ['creds.json', 'session-abc-1.json']);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0, 'no loose key files');
});

test('WhatsApp login: recovery install refuses to overwrite existing credentials', () => {
  const dir = path.join(ROOT, 'session', 'linked', '265990000003', 'b'.repeat(24));
  authStore.installFiles(dir, { 'creds.json': JSON.stringify({ registered: true }) });
  assert.throws(() => authStore.installFiles(dir, { 'creds.json': '{}' }), { code: 'EEXIST' });
  authStore.removeDir(dir);
  assert.equal(authStore.hasFiles(dir), false);
});

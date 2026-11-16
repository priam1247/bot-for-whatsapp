'use strict';

// Regression tests for bugs found while exercising every command end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const bot = (p) => require(path.join(ROOT, p));

test('.menu media shows only the media section', async () => {
  const menu = bot('commands/menu/index.js');
  let text = '';
  await menu.execute({ sendMessage: async (_j, c) => { text = c.text; } }, {}, ['media'], { from: 'x', isOwner: false, reply: async () => {} });
  assert.match(text, /\*MEDIA\*/);
  assert.doesNotMatch(text, /\*PAPERS\*/);
});

test('.menu lists Papers first, then Media, and every working command', () => {
  const menu = bot('commands/menu/index.js');
  const card = menu._buildCard(menu._buildGroups('.', { isOwner: true }));
  assert.ok(card.indexOf('*PAPERS*') < card.indexOf('*MEDIA*'), 'Papers must come before Media');
  for (const name of ['paper', 'countpapers', 'movie', 'series', 'kk', 'dramabox', 'song', 'video', 'mfind', 'embed',
    'tiktok', 'instagram', 'sticker', 'viewonce', 'providers', 'info', 'restart', 'status', 'ping', 'menu']) {
    assert.ok(card.includes(`.${name}`), `.${name} is missing from the menu`);
  }
  for (const gone of ['ytdl', 'cookies', 'ytlogin', 'mdiag', 'debrid']) assert.ok(!card.includes(`.${gone}`), `.${gone} was removed`);
});

test('.paper sends the newest papers when a query is capped', async () => {
  const [paper] = bot('commands/paper/index.js');
  const files = [];
  for (let y = 2008; y <= 2025; y++) files.push({ id: y, hash: `h${y}`, name: `MAT 1101 Exam ${y}.pdf`, size: 1000 + y, created_at: '2026-01-01' });
  paper._setVaultFilesForTests(files);
  const sent = [];
  const sock = { sendMessage: async (_j, c) => { if (c.document) sent.push(c.fileName); return { key: { id: 'k' } }; } };
  paper._setDownloaderForTests(async () => ({ tmp: '/nonexistent', releaseHold() {} }));
  const extra = { from: 'g@g.us', sessionId: 'primary', isOwner: true, reply: async () => {}, status: async () => ({ update: async () => {} }) };
  await paper.execute(sock, { key: { remoteJid: 'g@g.us', id: 'm' } }, ['mat', '1101', '--force'], extra);
  paper._setDownloaderForTests(null);
  paper._setVaultFilesForTests(null);
  assert.equal(sent.length, 10);
  assert.equal(sent[0], 'MAT 1101 Exam 2025.pdf');
  assert.ok(!sent.includes('MAT 1101 Exam 2008.pdf'));
});

test('.paper keeps two different papers that happen to share a byte size', () => {
  const [paper] = bot('commands/paper/index.js');
  assert.equal(typeof paper._deduplicateFiles, 'function');
  const files = [
    { id: 1, name: 'CHEM 2201 Organic May 2023.pdf', size: 61000 },
    { id: 2, name: 'CHEM 2201 Organic Deferred 2023.pdf', size: 61000 },
  ];
  assert.equal(paper._deduplicateFiles(files, 'CHEM', '2201').length, 2);
});

test('.info shows "148 min" once when the source already includes the unit', () => {
  const info = bot('commands/info/index.js');
  const text = info._render({ type: 'movie', title: 'Inception', runtime: '148 min' });
  assert.match(text, /⏱ 148 min$/m);
  assert.match(info._render({ type: 'movie', title: 'X', runtime: 60 }), /⏱ 60 min$/m);
});

test('.series with only an episode code asks for a title', async () => {
  const series = bot('commands/series/index.js');
  let reply = '';
  await series.execute({}, {}, ['s01e01'], { from: 'x', reply: async (t) => { reply = t; } });
  assert.match(reply, /^Usage:/);
});

test('DramaBox flags a removed or failing service as an outage', async () => {
  const dramabox = bot('commands/dramabox/source.js');
  const gone = dramabox.createDramaBox({
    http: { async get() { return { status: 404, data: { message: 'Application not found' } }; } },
  });
  await assert.rejects(gone.getDramaBoxStream('41000105764'), (e) => e.serviceDown === true && e.code === 'HTTP_404');
  const down = dramabox.createDramaBox({ http: { async get() { throw new Error('ECONNRESET'); } } });
  await assert.rejects(down.getDramaBoxStream('41000105764'), (e) => e.serviceDown === true);
});

test('.series refuses a season past the show\'s last season', async () => {
  const series = bot('commands/series/index.js');
  let reply = '';
  const extra = { from: 'x', reply: async (t) => { reply = t; } };
  await series._askQuality({ sendMessage: async () => ({}) }, { key: { id: 'k' } }, extra,
    { title: 'Breaking Bad', seasons: 5 }, { season: 99, from: 1, to: 1, explicitQuality: true });
  assert.equal(reply, '❌ *Breaking Bad* has 5 seasons; there is no season 99.');
});

test('libsignal "Closing session" dumps (console.info) never reach the logs', () => {
  const { installConsoleFilter } = bot('lib/safeLog.js');
  const SessionRecord = require(path.join(ROOT, 'node_modules/libsignal/src/session_record.js'));
  const printed = [];
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  for (const m of Object.keys(saved)) console[m] = (...a) => printed.push(a.map(String).join(' '));
  try {
    installConsoleFilter(['closing session', 'opening session', 'sessionentry']);
    const record = new SessionRecord();
    const session = { indexInfo: { closed: -1, baseKey: Buffer.from('k') } };
    record.closeSession(session);
    record.openSession(session);
    console.info('Bot is ready');
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(printed, ['Bot is ready']);
});

// ── Hardening: owner fallbacks, KissKh retry ─────────
{
  // Owner fallbacks removed, KissKh 429 retry.
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  
  const ROOT = path.resolve(__dirname, '..');
  const cleanEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', ...extra });
  
  test('config has no built-in owner or admin numbers', () => {
    const r = spawnSync(process.execPath, ['-e',
      "const c=require('./config');console.log(JSON.stringify([c.ownerNumber,c.adminNumbers]))"],
    { cwd: ROOT, env: cleanEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), [[], []]);
  });
  
  test('config reads owner and admins only from the environment', () => {
    const r = spawnSync(process.execPath, ['-e',
      "const c=require('./config');console.log(JSON.stringify([c.ownerNumber,c.adminNumbers]))"],
    { cwd: ROOT, env: cleanEnv({ OWNER_NUMBER: '111', ADMIN_NUMBERS: '222, 333' }), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout.trim()), [['111'], ['222', '333']]);
  });
  
  test('the bot refuses to start without OWNER_NUMBER', () => {
    const r = spawnSync(process.execPath, ['index.js'], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /OWNER_NUMBER is not set/);
  });
  
  test('KissKh retries 429/5xx like UDB, but not a Cloudflare 403', async () => {
    const kisskh = require('../lib/kisskh');
    const realFetch = global.fetch;
    const reply = (status, body) => ({
      ok: status === 200, status,
      headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.01' : null) },
      json: async () => body, text: async () => JSON.stringify(body),
    });
    const drama = { id: 5, title: 'T', releaseDate: '2024-01-01', type: 'TVSeries', episodes: [{ id: 1, number: 1, sub: 0 }] };
    try {
      let calls = 0;
      global.fetch = async () => { calls += 1; return calls < 3 ? reply(429) : reply(200, drama); };
      assert.equal((await kisskh.details(5)).title, 'T');
      assert.equal(calls, 3);
  
      calls = 0;
      global.fetch = async () => { calls += 1; return reply(403); };
      await assert.rejects(kisskh.details(5), { code: 'KISSKH_HTTP' });
      assert.equal(calls, 1);
  
      calls = 0;
      global.fetch = async () => { calls += 1; return reply(429); };
      await assert.rejects(kisskh.details(5), { code: 'KISSKH_HTTP' });
      assert.equal(calls, 4);
    } finally { global.fetch = realFetch; }
  });
}

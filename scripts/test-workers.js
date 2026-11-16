#!/usr/bin/env node
'use strict';

// Receptionist / worker split (lib/workers): heavy commands run in a separate
// process that starts on demand and exits when done; a crash there never
// takes down the main process. Real child processes are used; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-workers-'));
const ROOT = createBotFixture(TMP);
process.chdir(ROOT);
process.env.PREFIX = '.';
process.env.WORKER_MAX = '2';
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const pool = require(path.join(ROOT, 'lib/workers/pool'));
const selections = require(path.join(ROOT, 'lib/selections'));
const tempManager = require(path.join(ROOT, 'lib/tempManager'));
tempManager.initializeTempSystem();

// Test commands live in their own files, exactly like command folders.
const CMD_DIR = path.join(ROOT, 'worker-test-commands');
const LIB = (name) => JSON.stringify(path.join(ROOT, 'lib', name));
fs.mkdirSync(CMD_DIR, { recursive: true });
function defineCommand(name, body) {
  const file = path.join(CMD_DIR, `${name}.js`);
  fs.writeFileSync(file, `'use strict';\nmodule.exports = { name: '${name}', worker: true, async execute(sock, msg, args, extra) {\n${body}\n} };\n`);
  return require(file);
}

const from = '265990000001@s.whatsapp.net';
const ctx = { from, sender: from, senderIds: [from], commandName: 't' };
const msg = { key: { remoteJid: from, id: 'm1', fromMe: false }, message: { conversation: '.t' } };
function fakeSock() {
  const sent = [];
  let n = 0;
  return {
    sent,
    user: { id: '265990000009@s.whatsapp.net' },
    async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `P${++n}`, remoteJid: jid, fromMe: true }, message: { conversation: 'x' } }; },
  };
}
const waitFor = async (check, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return check();
};

test('runs in a separate process, replies through the main socket, and exits afterwards', async () => {
  const cmd = defineCommand('pid', `
    await extra.reply('pid ' + process.pid + ' child ' + process.env.ZF_WORKER_CHILD);
    await sock.sendMessage(extra.from, { image: Buffer.from([1, 2, 3]), caption: 'buf' });
  `);
  assert.equal(pool.shouldIsolate(cmd), true);
  const sock = fakeSock();
  await pool.runCommand({ command: cmd, sock, msg, args: [], ctx });
  const text = sock.sent[0].content.text;
  assert.match(text, /^pid \d+ child 1$/);
  assert.notEqual(Number(text.split(' ')[1]), process.pid, 'command ran in another process');
  assert.equal(Buffer.isBuffer(sock.sent[1].content.image), true, 'small buffers arrive as real Buffers');
  assert.ok(await waitFor(() => pool.stats().running === 0), 'worker exited and freed its slot');
});

test('a crashing download fails only that request; the main process keeps working', async () => {
  const crash = defineCommand('crash', 'process.exit(3);');
  const ok = defineCommand('ok', "await extra.reply('still fine');");
  const sock = fakeSock();
  await assert.rejects(pool.runCommand({ command: crash, sock, msg, args: [], ctx }), (err) => {
    assert.equal(err.code, 'WORKER_CRASHED');
    assert.match(err.userMessage, /bot is still online/);
    return true;
  });
  await pool.runCommand({ command: ok, sock, msg, args: [], ctx });
  assert.equal(sock.sent.at(-1).content.text, 'still fine');
});

test('a worker that runs out of memory dies alone', { timeout: 60000 }, async () => {
  process.env.WORKER_MAX_HEAP_MB = '128';
  try {
    const hog = defineCommand('hog', 'const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));');
    await assert.rejects(pool.runCommand({ command: hog, sock: fakeSock(), msg, args: [], ctx }), { code: 'WORKER_CRASHED' });
  } finally { delete process.env.WORKER_MAX_HEAP_MB; }
  assert.ok(process.memoryUsage().heapUsed < 200 * 1024 * 1024, 'main process memory untouched');
});

test('errors keep their code and safe user message', async () => {
  const bad = defineCommand('bad', "throw Object.assign(new Error('raw /tmp/secret detail'), { code: 'NO_STREAM', userMessage: 'Nothing to play.' });");
  await assert.rejects(pool.runCommand({ command: bad, sock: fakeSock(), msg, args: [], ctx }), (err) => err.code === 'NO_STREAM' && err.userMessage === 'Nothing to play.');
});

test('numbered choices offered in a worker are answered in the main process and run back in the same worker', async () => {
  const cmd = defineCommand('pick', `
    const selections = require(${LIB('selections')});
    const items = [{ name: 'alpha', pid: process.pid }, { name: 'beta', pid: process.pid }];
    await selections.sendTextPrompt(sock, msg, extra, {
      text: '1. alpha\\n2. beta', items,
      run: async (s, m, x, item) => { await x.reply('picked ' + item.name + ' in ' + (item.pid === process.pid ? 'same worker' : 'other')); },
    });
  `);
  const sock = fakeSock();
  await pool.runCommand({ command: cmd, sock, msg, args: [], ctx });
  assert.equal(pool.stats().workers.length, 1, 'worker stays alive while its list is open');
  const picked = selections.match(from, [from], '2', { scope: 'primary' });
  assert.ok(picked, 'the choice is visible to the main process');
  await picked.entry.run(sock, { key: { remoteJid: from, id: 'm2' }, message: { conversation: '.2' } }, { from, sender: from, senderIds: [from], commandName: 'pick' }, picked.item);
  assert.equal(sock.sent.at(-1).content.text, 'picked beta in same worker');
  assert.ok(await waitFor(() => pool.stats().running === 0), 'worker exited after the choice ran');
});

test('cancelling a list lets its worker exit', async () => {
  const cmd = defineCommand('cancel', `
    const selections = require(${LIB('selections')});
    await selections.sendTextPrompt(sock, msg, extra, { text: 'x', items: [1, 2], run: async () => {} });
  `);
  await pool.runCommand({ command: cmd, sock: fakeSock(), msg, args: [], ctx });
  assert.equal(pool.stats().running, 1);
  assert.equal(selections.clear(from, [from], { scope: 'primary' }), true);
  assert.ok(await waitFor(() => pool.stats().running === 0), 'worker exited once its list was cancelled');
});

test('files a worker is still writing are protected from the main process cleanup', async () => {
  const marker = path.join(ROOT, 'temp', 'held-flag');
  const cmd = defineCommand('hold', `
    const fs = require('fs');
    const release = require(${LIB('tempManager')}).holdTemp('movie_job_123');
    fs.writeFileSync(${JSON.stringify(marker)}, 'held');
    while (fs.existsSync(${JSON.stringify(marker)})) await new Promise((r) => setTimeout(r, 20));
    release();
  `);
  const running = pool.runCommand({ command: cmd, sock: fakeSock(), msg, args: [], ctx });
  assert.ok(await waitFor(() => fs.existsSync(marker)));
  assert.ok(await waitFor(() => tempManager.isHeld('movie_job_123.mp4')), 'hold mirrored into the main process');
  fs.unlinkSync(marker);
  await running;
  assert.ok(await waitFor(() => !tempManager.isHeld('movie_job_123.mp4')), 'hold released when the job ended');
});

test('a timed-out command can be cancelled (its worker is killed)', async () => {
  const cmd = defineCommand('slow', 'await new Promise(() => {});');
  const running = pool.runCommand({ command: cmd, sock: fakeSock(), msg, args: [], ctx });
  assert.ok(await waitFor(() => pool.stats().workers.length === 1));
  running.cancel();
  await assert.rejects(running, { code: 'WORKER_CRASHED' });
  assert.ok(await waitFor(() => pool.stats().running === 0));
});

test('extra requests wait for a free slot instead of starting unlimited processes', async () => {
  const cmd = defineCommand('gate', `
    const fs = require('fs');
    const flag = ${JSON.stringify(path.join(ROOT, 'temp', 'gate-'))} + args[0];
    fs.writeFileSync(flag, '1');
    while (fs.existsSync(flag)) await new Promise((r) => setTimeout(r, 20));
  `);
  const flags = ['a', 'b', 'c'].map((n) => path.join(ROOT, 'temp', `gate-${n}`));
  const runs = ['a', 'b', 'c'].map((n) => pool.runCommand({ command: cmd, sock: fakeSock(), msg, args: [n], ctx }));
  assert.ok(await waitFor(() => fs.existsSync(flags[0]) && fs.existsSync(flags[1])));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(flags[2]), false, 'third request waits');
  assert.equal(pool.stats().waiting, 1);
  fs.unlinkSync(flags[0]);
  assert.ok(await waitFor(() => fs.existsSync(flags[2])), 'third request starts when a slot frees');
  fs.unlinkSync(flags[1]); fs.unlinkSync(flags[2]);
  await Promise.all(runs);
});

test('WORKERS=off runs commands in-process (debug mode)', () => {
  process.env.WORKERS = 'off';
  try { assert.equal(pool.shouldIsolate({ worker: true }), false); }
  finally { delete process.env.WORKERS; }
  assert.equal(pool.shouldIsolate({ worker: false }), false);
});

test('heavy media commands are marked to run in workers', () => {
  const commands = require(path.join(ROOT, 'gateway/registry')).loadCommands();
  for (const name of ['movie', 'series', 'kk', 'tiktok', 'song', 'video', 'dramabox', 'mfind', 'embed']) {
    assert.equal(commands.get(name)?.worker, true, `.${name} should run in a worker`);
  }
  for (const name of ['menu', 'ping', 'allow']) {
    assert.notEqual(commands.get(name)?.worker, true, `.${name} stays in the receptionist`);
  }
});

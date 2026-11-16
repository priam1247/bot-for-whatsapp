'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSessionServices, stopSessionServices, createServiceLifecycle } = require('../gateway/sessions/startup');

test('failed session startup cleans up before retry', async () => {
  const events = [];
  const failing = { start: async () => { events.push('start'); throw new Error('failed'); }, stop: async () => events.push('stop') };
  await assert.rejects(startSessionServices(failing, async () => events.push('cleanup')), /failed/);
  assert.deepEqual(events, ['start', 'stop', 'cleanup']);
  const next = { start: async () => events.push('retry'), stop: async () => events.push('stop-retry') };
  await startSessionServices(next);
  assert.deepEqual(events, ['start', 'stop', 'cleanup', 'retry']);
});

test('shutdown waits for sessions to finish closing', async () => {
  const events = []; let release;
  const waitForWrites = new Promise((resolve) => { release = resolve; });
  const resource = { sessions: { stop: async () => { events.push('sessions-start'); await waitForWrites; events.push('sessions-done'); } } };
  const stopping = stopSessionServices(resource);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['sessions-start']);
  release(); await stopping;
  assert.deepEqual(events, ['sessions-start', 'sessions-done']);
});

test('a stop during startup closes the resulting service once and suppresses retries', async () => {
  const events = []; let release;
  const startup = new Promise((resolve) => { release = resolve; });
  const lifecycle = createServiceLifecycle({
    start: async () => { events.push('starting'); await startup; return { id: 'service' }; },
    stop: async (service) => { events.push(`stopped:${service.id}`); },
    onError: () => events.push('error'), retryDelayMs: 5,
  });
  lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const first = lifecycle.shutdown(); const second = lifecycle.shutdown();
  release();
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['starting', 'stopped:service']);
});

test('a failed startup can retry, but a later stop cancels pending retries', async () => {
  let attempts = 0;
  const lifecycle = createServiceLifecycle({
    start: async () => { attempts += 1; throw new Error('offline'); },
    onError: () => {}, retryDelayMs: 10,
  });
  lifecycle.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(attempts >= 2);
  await lifecycle.shutdown();
  const atShutdown = attempts;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(attempts, atShutdown);
});

test('importing cleanup does not take over process signal handling', () => {
  const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
  const id = require.resolve('../lib/cleanup');
  delete require.cache[id];
  require(id);
  assert.equal(process.listenerCount('SIGTERM'), before.term);
  assert.equal(process.listenerCount('SIGINT'), before.int);
});

for (const [signal, failBackup] of [['SIGTERM', false], ['SIGINT', false], ['SIGTERM', 'sensitive'], ['SIGTERM', 'private'], ['SIGTERM', 'binary'], ['SIGTERM', 'benign']]) {
  test(`the bot entry point handles ${signal}${failBackup ? ` while reporting a ${failBackup} failure` : ''}`, async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const root = path.resolve(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-entry-stop-'));
    const marker = path.join(dir, 'events');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.mkdirSync(path.join(dir, 'gateway', 'sessions'), { recursive: true });
    fs.copyFileSync(path.join(root, 'gateway', 'sessions', 'startup.js'), path.join(dir, 'gateway', 'sessions', 'startup.js'));
    fs.copyFileSync(path.join(root, 'lib', 'safeLog.js'), path.join(dir, 'lib', 'safeLog.js'));
    fs.copyFileSync(path.join(root, 'index.js'), path.join(dir, 'index.js'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(dir, 'preload.cjs'), `
      const Module = require('node:module');
      const fs = require('node:fs');
      const mark = (name) => fs.appendFileSync(process.env.TEST_MARKER, name + '\\n');
      const ffmpeg = () => 'ffmpeg'; ffmpeg.works = () => false;
      const logger = () => ({info(){},warn(){},error(){},debug(){}}); logger.banner = () => {};
      const fake = {
        './lib/tempManager': { initializeTempSystem() {} },
        './lib/cleanup': { startCleanup() {}, stopCleanup() { mark('cleanup'); }, cleanupOldFiles() {} },
        './lib/diskGuard': { startDiskGuard() {}, stopDiskGuard() { mark('disk'); } },
        'pino': () => ({ info() {} }),
        '@whiskeysockets/baileys': { default() {}, useMultiFileAuthState() {}, DisconnectReason: { loggedOut: 401 }, Browsers: { ubuntu() {} }, fetchLatestWaWebVersion: async () => ({}) },
        'qrcode-terminal': { generate() {} },
        './config': { ownerNumber: ['265990000099'], adminNumbers: [], sessionName: 'session', prefix: '.', botName: 'Test' },
        './gateway/handler': { handleMessage() {} },
        './lib/hotReload': { onReload() {} },
        './lib/jid': { isSystemJid() { return false; } },
        './lib/accountSockets': { setHealthSource() {}, setHealer() {}, setLinker() {}, getOnline() { return null; } },
        './gateway/sessions/manager': { createSessionManager: () => ({
          start: async () => { mark('sessions-start'); setImmediate(() => { process.emit('unhandledRejection', undefined); process.stdout.write('SERVICE_READY\\n'); }); },
          stop: async () => {
            mark('sessions-stop-start'); await new Promise((r) => setTimeout(r, 20)); mark('sessions-stop-done');
            if (process.env.TEST_FAIL_BACKUP) throw new Error(({ sensitive: 'closing session token=secret-filter-fixture registrationId=12345 chainKey=private-session-fixture', private: 'closing session privateKey=secret-private-key-fixture', binary: 'closing session: Buffer barebinarysecretfixturebarebinarysecretfixture12345678', benign: 'closing session: socket offline token=secret-filter-fixture' })[process.env.TEST_FAIL_BACKUP]);
          },
          status: () => ({}),
        }) },
        './lib/logger': logger,
        './lib/ffmpeg': ffmpeg,
        './lib/nm3u8dl': { ensureInstalled: async () => null },
        './lib/telemetry': { flushNow() { mark('telemetry'); } },
      };
      const original = Module._load;
      Module._load = function (request, parent, isMain) {
        if (parent?.filename.endsWith('/index.js') && Object.hasOwn(fake, request)) return fake[request];
        return original.apply(this, arguments);
      };
    `);
    const child = spawn(process.execPath, ['--require', path.join(dir, 'preload.cjs'), path.join(dir, 'index.js')], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', TEST_MARKER: marker, ...(failBackup ? { TEST_FAIL_BACKUP: failBackup } : {}) },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    let output = ''; let signalled = false; let signalTimer;
    child.stdout.on('data', (data) => {
      output += data;
      // All fake sockets are deliberately idle: the
      // real entry point must remain available even with no external handles.
      if (!signalTimer && output.includes('SERVICE_READY')) {
        signalTimer = setTimeout(() => { signalled = child.kill(signal); }, 100);
      }
    });
    child.stderr.on('data', (data) => { output += data; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('isolated bot did not stop in time')); }, 5000);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, exitSignal) => { clearTimeout(timer); resolve({ code, exitSignal }); });
    });
    clearTimeout(signalTimer);
    assert.equal(signalled, true, `service exited before ${signal} could be sent: ${output}`);
    assert.deepEqual(result, { code: 0, exitSignal: null });
    assert.doesNotMatch(output, /Cannot read properties of undefined/);
    if (failBackup) {
      assert.match(output, /WhatsApp shutdown was incomplete/i);
      assert.match(output, /WhatsApp sessions shutdown failed/i);
      assert.match(output, /closing session/i);
      if (failBackup === 'benign') assert.match(output, /socket offline/i);
      else assert.match(output, /sensitive session details omitted/i);
      assert.doesNotMatch(output, /secret-shutdown-fixture|secret-filter-fixture|private-session-fixture|secret-private-key-fixture|barebinarysecretfixture|registrationId=12345/);
    }
    const events = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.deepEqual(events, ['sessions-start', 'cleanup', 'disk', 'sessions-stop-start', 'sessions-stop-done', 'telemetry']);
  });
}

test('a shutdown error names the failing component and preserves its cause', async () => {
  const { safeText } = require('../lib/safeLog');
  const result = await stopSessionServices({
    sessions: { stop: async () => { throw new Error('WhatsApp socket close token=secret-sync-fixture'); } },
  }).then(() => null, (error) => error);
  assert.ok(result instanceof AggregateError);
  assert.deepEqual(result.errors.map((error) => error.message), ['WhatsApp sessions shutdown failed']);
  for (const error of result.errors) assert.ok(error.cause instanceof Error);
  const output = safeText(result);
  assert.ok(output.includes('WhatsApp socket close'));
  assert.doesNotMatch(output, /secret-sync-fixture/);
});

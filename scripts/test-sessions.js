'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSessionManager } = require('../gateway/sessions/manager');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms = 500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('timed out waiting for test condition');
}

function fixture(root, options = {}) {
  const created = [];
  const messages = [];
  const events = [];
  const removed = [];
  const loadAuthState = async (dir, o) => {
    fs.mkdirSync(dir, { recursive: true });
    let creds;
    try { creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')); }
    catch {
      if (o?.requireExisting) throw Object.assign(new Error('Saved WhatsApp login is missing.'), { code: 'AUTH_MISSING' });
      creds = { registered: false };
    }
    return {
      state: { creds },
      saveCreds: async () => fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds)),
    };
  };
  const manager = createSessionManager({
    sessionDir: root,
    loadAuthState,
    getVersion: async () => [2, 0, 0],
    makeSocket: ({ auth }) => {
      const sock = {
        ev: new EventEmitter(),
        auth,
        user: auth.creds.me,
        ended: false,
        requestPairingCode: async (number) => `CODE-${number.slice(-4)}`,
        end: async () => { sock.ended = true; sock.ev.emit('connection.update', { connection: 'close' }); },
        logout: async () => { sock.loggedOut = true; sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }); },
        sendMessage: async () => ({}),
      };
      created.push(sock);
      return sock;
    },
    onMessage: async (sock, msg) => messages.push([sock.__sessionId, msg.key.id]),
    onEvent: (event) => events.push(event),
    removeCredentials: (number) => { removed.push(number); fs.rmSync(path.join(root, 'linked', number), { recursive: true, force: true }); },
    loggedOutCode: 401,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    pairTimeoutMs: 150,
    codeLifetimeMs: 50,
    pendingLifetimeMs: 80,
    log: { warn() {}, error() {}, log() {} },
    ...options,
  });
  return { manager, created, messages, events, removed };
}

function open(sock, number) {
  sock.auth.creds.registered = true;
  sock.auth.creds.me = { id: `${number}:1@s.whatsapp.net` };
  sock.user = sock.auth.creds.me;
  sock.ev.emit('creds.update', sock.auth.creds);
  sock.ev.emit('connection.update', { connection: 'open' });
}

async function request(fx, number) {
  const before = fx.created.length;
  const promise = fx.manager.requestPair(number);
  await waitFor(() => fx.created.slice(before).some((s) => s.__sessionId === `linked:${number}`));
  const sock = fx.created.slice(before).find((s) => s.__sessionId === `linked:${number}`);
  sock.ev.emit('connection.update', { qr: 'ready' });
  return { result: await promise, sock };
}

function message(id, from = '265991111111@s.whatsapp.net') {
  return { key: { id, remoteJid: from }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '.ping' } };
}

const stateOf = (fx, number) => fx.manager.status().accounts.find((x) => x.number === number)?.state;

test('expired codes can be retried without deleting previous session data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const first = await request(fx, '265991111111');
  const originalFolder = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts['265991111111'].attempt;
  await delay(90);
  assert.equal(fx.manager.status().accounts.find((a) => a.number === '265991111111').state, 'expired');
  assert.equal(first.sock.ended, true);
  const second = await request(fx, '265991111111');
  const nextFolder = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts['265991111111'].attempt;
  assert.notEqual(originalFolder, nextFolder);
  assert.ok(fs.existsSync(path.join(root, 'linked', '265991111111', originalFolder)), 'previous credentials were deleted');
  assert.ok(!second.sock.ended);
});

test('a transient disconnect reconnects only the affected account and logout permits a fresh link', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await waitFor(() => fx.created.length === 3);
  assert.equal(primary.ended, false);
  const reconnected = fx.created[2];
  open(reconnected, '265991111111');
  reconnected.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(fx.manager.status().accounts.find((a) => a.number === '265991111111').state, 'logged_out');
  const fresh = await request(fx, '265991111111');
  assert.equal(fresh.result.code, 'CODE-1111');
  assert.equal(primary.ended, false);
});

test('a logged-out primary is not silently reconnected by a runtime reload', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-logout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  primary.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await fx.manager.reconnectAll();
  assert.equal(fx.created.length, 1);
  assert.equal(fx.manager.status().accounts[0].state, 'logged_out');
});

test('a retry cannot replace a socket whose registration just completed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-registration-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { codeLifetimeMs: 20, pendingLifetimeMs: 1000 });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  // Simulate companion_finish before the asynchronous save/manifest update.
  sock.auth.creds.registered = true;
  await delay(30);
  await assert.rejects(fx.manager.requestPair('265991111111'), /already linked/i);
  assert.equal(sock.ended, false);
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
});

test('a missing socket user still recognizes the saved primary identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-primary-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' } }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0]; open(primary, '265990000000');
  primary.user = null;
  assert.equal(fx.manager.status().accounts[0].number, '265990000000');
  await assert.rejects(fx.manager.requestPair('265990000000'), /owner number/i);
});

test('stopping a session waits for credential writes already accepted by the socket', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stop-creds-'));
  let release;
  const writeReady = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  let didWrite = false;
  const fx = fixture(root, {
    loadAuthState: async () => ({
      state: { creds: { registered: true, me: { id: '265990000000:1@s.whatsapp.net' } } },
      saveCreds: async () => { await writeReady; didWrite = true; },
    }),
  });
  await fx.manager.start();
  fx.created[0].ev.emit('creds.update');
  let stopped = false;
  const stopping = fx.manager.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'the process must not finish shutdown before the accepted credentials are saved');
  release();
  await stopping;
  assert.equal(didWrite, true);
});

test('a socket end that hangs does not indefinitely block shutdown of other sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-end-stop-timeout-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  const fx = fixture(root, { retirementShutdownTimeoutMs: 20 });
  await fx.manager.start();
  const primary = fx.created[0];
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.end = async () => { await gate; };
  const { stopSessionServices } = require('../gateway/sessions/startup');
  const stopping = stopSessionServices({ sessions: fx.manager }).then(() => ({ error: null }), (error) => ({ error }));
  let timeout;
  const result = await Promise.race([stopping, new Promise((resolve) => { timeout = setTimeout(() => resolve('timeout'), 1500); })]);
  clearTimeout(timeout);
  if (result === 'timeout') { release(); await stopping; }
  assert.notEqual(result, 'timeout', 'a blocked socket close must not block shutdown');
  assert.ok(result.error, 'the incomplete socket close must be reported');
  assert.equal(primary.ended, true);
  release();
});

test('a post-pair disconnect keeps Node alive until the WhatsApp reconnect runs', (t) => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-liveness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `
    const { EventEmitter } = require('node:events');
    const { createSessionManager } = require(${JSON.stringify(require.resolve('../gateway/sessions/manager'))});
    let sockets = 0;
    const manager = createSessionManager({
      sessionDir: process.argv[1],
      pairNumber: '12345678901',
      loadAuthState: async () => ({ state: { creds: { registered: false } }, saveCreds: async () => {} }),
      getVersion: async () => [2, 0, 0],
      makeSocket: () => {
        const sock = { ev: new EventEmitter(), requestPairingCode: async () => 'fixture-code', end: async () => {} };
        if (++sockets === 1) setImmediate(() => {
          sock.ev.emit('connection.update', { qr: 'fixture-ready' });
          setImmediate(() => sock.ev.emit('connection.update', {
            connection: 'close', lastDisconnect: { error: { message: 'private-disconnect-fixture', output: { statusCode: 515 } } },
          }));
        });
        else setImmediate(async () => { console.log('reconnected'); await manager.stop(); });
        return sock;
      },
      onConsoleCode: () => console.log('pairing-code-issued'),
      reconnectBaseMs: 30, reconnectMaxMs: 30, loggedOutCode: 401,
      // 515 after pairing is routine, so its notice is now debug level (hidden by default).
      log: { warn: (msg) => console.log(msg), debug: (msg) => console.log(msg), error: (msg) => console.error(msg) },
    });
    manager.start().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', source, root], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 3000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /pairing-code-issued/);
  assert.match(child.stdout, /status 515.*retrying/i);
  assert.doesNotMatch(child.stdout + child.stderr, /private-disconnect-fixture|fixture-code/);
  assert.match(child.stdout, /reconnected/, 'Node exited cleanly before the scheduled retry ran');
});

test('stopping a pending reconnect releases its process handle', (t) => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `
    const { createReconnector } = require(${JSON.stringify(require.resolve('../gateway/sessions/reconnect'))});
    const reconnect = createReconnector({ start: () => console.log('unexpected retry'), baseMs: 60000 });
    reconnect.schedule();
    reconnect.stop();
    console.log('stopped');
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 2000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /stopped/);
  assert.doesNotMatch(child.stdout, /unexpected retry/);
});

test('disconnect diagnostics omit raw errors and coalesce duplicate retry notices', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-disconnect-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings = [];
  const fx = fixture(root, {
    reconnectBaseMs: 500, reconnectMaxMs: 500,
    log: { warn: (message) => warnings.push(message), error() {}, log() {} },
  });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const socket = fx.created[0];
  const update = { connection: 'close', lastDisconnect: { error: {
    message: 'private-disconnect-fixture', output: { statusCode: 'private-status-fixture' },
  } } };
  socket.ev.emit('connection.update', update);
  socket.ev.emit('connection.update', update);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /status unknown.*retrying in 500ms/i);
  assert.doesNotMatch(warnings[0], /private-disconnect-fixture|private-status-fixture/);
});

test('routine reconnects (408/428/515) stay quiet; only repeated drops warn that the connection is unstable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-transient-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings = []; const debugs = [];
  const fx = fixture(root, {
    reconnectBaseMs: 1, reconnectMaxMs: 1,
    log: { warn: (m) => warnings.push(m), debug: (m) => debugs.push(m), error() {}, log() {} },
  });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const drop = async (code) => {
    const current = fx.created.at(-1);
    current.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  await drop(428);
  await drop(408);
  await drop(515);
  assert.equal(warnings.length, 0, 'three routine drops must not print warnings');
  assert.ok(debugs.some((m) => /status 428/.test(m)), 'they are still available at debug level');
  await drop(428);
  await drop(428);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unstable.*5 drops in 10 min/i);
});

test('a socket that is open but dead is recycled; an idle healthy one is left alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let alive = true; let probes = 0;
  const fx = fixture(root, { staleMs: 30, probeTimeoutMs: 100, probe: async () => { probes += 1; if (!alive) throw new Error('no pong'); } });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock: a } = await request(fx, '265991111111');
  open(a, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((x) => x.number === '265991111111' && x.state === 'connected'));

  await fx.manager._checkStale();
  assert.equal(probes, 0, 'a recently opened socket is not probed');
  await delay(45);
  await fx.manager._checkStale();
  assert.equal(probes, 1);
  assert.equal(a.ended, false, 'an idle but healthy socket must be left alone');
  await fx.manager._checkStale();
  assert.equal(probes, 1, 'a passed probe is not repeated until the account has been quiet again');

  alive = false;
  await delay(45);
  const before = fx.created.length;
  await fx.manager._checkStale();
  assert.equal(a.ended, true, 'the dead socket is closed');
  await waitFor(() => fx.created.length > before, 1500);
  const fresh = fx.created[fx.created.length - 1];
  assert.equal(fresh.__sessionId, 'linked:265991111111');
  alive = true;
  open(fresh, '265991111111');
  await waitFor(() => fx.manager.health().find((h) => h.number === '265991111111')?.state === 'answering');
  assert.ok(fx.manager.health().find((h) => h.number === '265991111111').reconnects >= 1);
});

test('upkeep: an old connection is refreshed only while the bot is idle, one account per run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let busy = true;
  const fx = fixture(root, { recycleMs: 30, isBusy: () => busy });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock: a } = await request(fx, '265991111111');
  open(a, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((x) => x.number === '265991111111' && x.state === 'connected'));
  await delay(45);
  const before = fx.created.length;
  await fx.manager._maintain();
  assert.equal(fx.created.length, before, 'never reconnects while a job is running');
  assert.equal(a.ended, false);
  busy = false;
  await fx.manager._maintain();
  assert.equal(a.ended, true, 'the old connection is closed');
  await waitFor(() => fx.created.length === before + 1, 1500);
  const fresh = fx.created[fx.created.length - 1];
  assert.equal(fresh.__sessionId, 'linked:265991111111');
  open(fresh, '265991111111');
  await waitFor(() => fx.manager.health().find((h) => h.number === '265991111111')?.state === 'answering');
  await fx.manager._maintain();
  assert.equal(fx.created.length, before + 1, 'a connection that was just refreshed is left alone');
});

test('heal: reconnects accounts that are down or do not answer, leaves healthy ones and the caller alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' } }));
  const dead = new Set();
  const fx = fixture(root, { recycleMs: 0, probe: async (sock) => { if (dead.has(sock.__sessionId)) throw new Error('no pong'); } });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const { sock: a } = await request(fx, '265991111111'); open(a, '265991111111');
  const { sock: b } = await request(fx, '265992222222'); open(b, '265992222222');
  await waitFor(() => fx.manager.status().accounts.filter((x) => x.state === 'connected').length === 3);

  dead.add('linked:265992222222');
  const before = fx.created.length;
  const rows = await fx.manager.heal({ skip: 'primary' });
  const by = Object.fromEntries(rows.map((r) => [r.number, r.result]));
  assert.match(by['265990000000'], /skipped/);
  assert.equal(by['265991111111'], 'ok');
  assert.match(by['265992222222'], /did not answer WhatsApp/);
  assert.equal(b.ended, true);
  await waitFor(() => fx.created.length === before + 1, 1500);
  assert.equal(fx.created[fx.created.length - 1].__sessionId, 'linked:265992222222');
  assert.equal(a.ended, false);

  const all = await fx.manager.heal({ all: true, skip: 'primary' });
  assert.equal(all.find((r) => r.number === '265991111111').result, 'reconnected');
});


test('.pair links several numbers independently, they answer at once, and all come back after a restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' }, marker: 'keep-me' }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const one = fx.manager.requestPair('265991111111');
  assert.strictEqual(fx.manager.requestPair('265991111111'), one, 'same-number requests must share one flight');
  const two = fx.manager.requestPair('265992222222');
  await waitFor(() => fx.created.length === 3);
  const a = fx.created.find((s) => s.__sessionId === 'linked:265991111111');
  const b = fx.created.find((s) => s.__sessionId === 'linked:265992222222');
  a.ev.emit('connection.update', { qr: 'ready' });
  b.ev.emit('connection.update', { qr: 'ready' });
  assert.equal((await one).code, 'CODE-1111');
  assert.equal((await two).code, 'CODE-2222');
  assert.equal(primary.ended, false, 'linking another account replaced the primary');
  assert.equal(a.__canRespond(), false, 'a number that has not entered its code yet cannot answer');
  open(a, '265991111111');
  open(b, '265992222222');
  await waitFor(() => fx.manager.status().accounts.filter((x) => x.state === 'connected').length === 3);
  assert.deepEqual(fx.events.map((e) => e.type), ['linked', 'linked'], 'the owner is told when each number finishes linking');

  for (const sock of [primary, a, b]) sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('same-id'), message('same-id')] });
  await waitFor(() => fx.messages.length === 3);
  assert.deepEqual(new Set(fx.messages.map((m) => m[0])), new Set(['primary', 'linked:265991111111', 'linked:265992222222']));
  await a.sendMessage('chat', { text: 'a linked number can reply with no approval step' });

  await assert.rejects(fx.manager.requestPair('265991111111'), /already linked/i);
  await assert.rejects(fx.manager.requestPair('265990000000'), /owner number/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'creds.json'))).marker, 'keep-me');
  await fx.manager.stop();

  const restarted = fixture(root);
  t.after(() => restarted.manager.stop());
  await restarted.manager.start();
  assert.deepEqual(new Set(restarted.created.map((s) => s.__sessionId)), new Set(['primary', 'linked:265991111111', 'linked:265992222222']));
  await assert.rejects(restarted.manager.requestPair('265991111111'), /already linked/i);
});

test('a code that is not used in time tells the owner and can be requested again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-code-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  await request(fx, '265991111111');
  await waitFor(() => stateOf(fx, '265991111111') === 'expired', 400);
  assert.deepEqual(fx.events, [{ type: 'expired', number: '265991111111' }]);
  const again = await request(fx, '265991111111');
  assert.equal(again.result.code, 'CODE-1111');
});

test('a damaged account index is left alone and refuses new links', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'linked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'linked', 'accounts.json'), '{broken');
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  await assert.rejects(fx.manager.requestPair('265991111111'), /index is unavailable/i);
  assert.equal(fs.readFileSync(path.join(root, 'linked', 'accounts.json'), 'utf8'), '{broken');
});

test('a linked number never gives up: drops of any kind reconnect, with no approval needed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  open(fx.created[0], '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  let current = sock;
  for (const code of [428, 440, 500, 515, 503, 408, undefined]) {
    const before = fx.created.length;
    current.ev.emit('connection.update', { connection: 'close', lastDisconnect: code ? { error: { output: { statusCode: code } } } : undefined });
    await waitFor(() => fx.created.length === before + 1, 1500);
    current = fx.created[fx.created.length - 1];
    open(current, '265991111111');
    await waitFor(() => stateOf(fx, '265991111111') === 'connected');
    assert.equal(current.__canRespond(), true);
  }
  assert.equal(fx.events.filter((e) => e.type !== 'linked').length, 0, 'ordinary drops must not alarm the owner');
});

test('upkeep revives a number that is offline with no reconnect pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-watchdog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { recycleMs: 0 });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  open(fx.created[0], '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  // A close that WhatsApp reports as logged-out-free but whose retry was lost:
  // reproduce it by closing the socket after its listeners were detached.
  sock.ev.removeAllListeners('connection.update');
  sock.end = async () => {};
  const before = fx.created.length;
  fx.manager.health(); // still shows connected: nothing to revive yet
  await fx.manager._maintain();
  assert.equal(fx.created.length, before, 'a connected number is left alone');
});

test('WhatsApp logging a number out tells the owner once, and .pair links it again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wa-logout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(stateOf(fx, '265991111111'), 'logged_out');
  assert.deepEqual(fx.events.filter((e) => e.type === 'logged_out').map((e) => e.number), ['265991111111']);
  await delay(30);
  assert.equal(fx.created.length, 2, 'a logged-out device is not retried in a loop');
  const fresh = await request(fx, '265991111111');
  assert.equal(fresh.result.code, 'CODE-1111');
  assert.equal(primary.ended, false);
});

test('restart: unfinished links expire, finished ones always come back, and a missing login stops loudly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = '265991111111';   // pending in the index but registered on disk
  const lost = '265992222222';   // active in the index but its login is gone
  const half = '265993333333';   // pending, never registered
  const live = '265994444444';   // active and healthy
  const ids = { [good]: 'a'.repeat(24), [lost]: 'b'.repeat(24), [half]: 'c'.repeat(24), [live]: 'd'.repeat(24) };
  for (const [number, attempt] of Object.entries(ids)) fs.mkdirSync(path.join(root, 'linked', number, attempt), { recursive: true });
  const creds = (n) => JSON.stringify({ registered: true, me: { id: `${n}:1@s.whatsapp.net` } });
  fs.writeFileSync(path.join(root, 'linked', good, ids[good], 'creds.json'), creds(good));
  fs.writeFileSync(path.join(root, 'linked', live, ids[live], 'creds.json'), creds(live));
  fs.writeFileSync(path.join(root, 'linked', 'accounts.json'), JSON.stringify({ version: 1, accounts: {
    [good]: { attempt: ids[good], state: 'pending' }, [lost]: { attempt: ids[lost], state: 'active' },
    [half]: { attempt: ids[half], state: 'pending' }, [live]: { attempt: ids[live], state: 'active' },
  } }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const started = fx.created.map((s) => s.__sessionId).sort();
  assert.deepEqual(started, ['primary', `linked:${good}`, `linked:${live}`].sort());
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts;
  assert.equal(saved[good].state, 'active');
  assert.equal(saved[half].state, 'expired');
  assert.equal(saved[lost].state, 'logged_out', 'a missing login is reported, not retried forever or replaced with a blank one');
  assert.deepEqual(fx.events.filter((e) => e.type === 'logged_out').map((e) => e.number), [lost]);
  assert.ok(fs.existsSync(path.join(root, 'linked', lost, ids[lost])), 'stored data of a failed number is never deleted by a restart');
});

test('.remove logs the number out, forgets it completely and leaves everyone else alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' }, marker: 'primary-safe' }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const { sock: a } = await request(fx, '265991111111'); open(a, '265991111111');
  const { sock: b } = await request(fx, '265992222222'); open(b, '265992222222');
  await waitFor(() => fx.manager.status().accounts.filter((x) => x.state === 'connected').length === 3);
  fx.events.length = 0;

  const result = await fx.manager.removeAccount('265991111111');
  assert.deepEqual(result, { number: '265991111111', loggedOut: true });
  assert.equal(a.loggedOut, true);
  assert.deepEqual(fx.removed, ['265991111111']);
  assert.equal(fx.events.length, 0, 'removing a number on purpose is not reported as a WhatsApp logout');
  assert.equal(fx.manager.status().accounts.some((x) => x.number === '265991111111'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts['265991111111'], undefined);
  assert.equal(b.ended, false);
  assert.equal(primary.ended, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'creds.json'))).marker, 'primary-safe');
  await delay(40);
  assert.equal(fx.created.length, 3, 'a removed number is not reconnected');

  await assert.rejects(fx.manager.removeAccount('265991111111'), (err) => err.statusCode === 404);
  await assert.rejects(fx.manager.removeAccount('265990000000'), (err) => err.statusCode === 404, 'the owner cannot be removed');
  await assert.rejects(fx.manager.removeAccount('12'), (err) => err.statusCode === 400);

  const again = await request(fx, '265991111111');
  assert.equal(again.result.code, 'CODE-1111', 'a removed number can be linked again');
});

test('.remove works when WhatsApp cannot be reached, and a number that never answers WhatsApp is still removed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-remove-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { logoutTimeoutMs: 30 });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  open(fx.created[0], '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.logout = () => new Promise(() => {}); // WhatsApp never answers
  const result = await fx.manager.removeAccount('265991111111');
  assert.deepEqual(result, { number: '265991111111', loggedOut: false });
  assert.deepEqual(fx.removed, ['265991111111']);
  assert.equal(stateOf(fx, '265991111111'), undefined);

  const { sock: down } = await request(fx, '265992222222');
  open(down, '265992222222');
  down.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  const offline = await fx.manager.removeAccount('265992222222');
  assert.equal(offline.loggedOut, false);
  assert.deepEqual(fx.removed, ['265991111111', '265992222222']);
});

test('removing a logged-out number just forgets it, and duplicate removes share one operation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-remove-dup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  open(fx.created[0], '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  let logouts = 0;
  sock.logout = async () => { logouts += 1; await delay(10); };
  const first = fx.manager.removeAccount('265991111111');
  assert.strictEqual(fx.manager.removeAccount('265991111111'), first);
  await first;
  assert.equal(logouts, 1);

  const { sock: gone } = await request(fx, '265992222222');
  open(gone, '265992222222');
  gone.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(stateOf(fx, '265992222222'), 'logged_out');
  assert.deepEqual(await fx.manager.removeAccount('265992222222'), { number: '265992222222', loggedOut: false });
});

test('shutdown waits for a removal already accepted, and a removed number is not restored by a restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-remove-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  await fx.manager.start();
  open(fx.created[0], '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  const { sock: keep } = await request(fx, '265992222222');
  open(keep, '265992222222');
  await fx.manager.removeAccount('265991111111');
  await fx.manager.stop();
  const restarted = fixture(root);
  t.after(() => restarted.manager.stop());
  await restarted.manager.start();
  assert.deepEqual(new Set(restarted.created.map((s) => s.__sessionId)), new Set(['primary', 'linked:265992222222']));
});

test('status() and health() describe linked numbers and the last WhatsApp close code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  open(fx.created[0], '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  assert.equal(fx.manager.health().find((r) => r.number === '265991111111').state, 'answering');
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  const row = fx.manager.health().find((r) => r.number === '265991111111');
  assert.equal(row.state, 'reconnecting');
  assert.equal(row.lastClose.code, 428);
});

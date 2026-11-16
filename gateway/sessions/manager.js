'use strict';

// Manages the owner's session and the numbers the owner links with `.pair`.
// A linked number is permanent: it reconnects forever and only goes away when
// the owner sends `.remove <number>` (or WhatsApp itself logs the device out,
// in which case the owner is told and can `.pair` it again).
// Dependencies are injected so the complete lifecycle can be tested offline.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createReconnector } = require('./reconnect');
const { readJsonSafe, writeJsonAtomic } = require('../../lib/jsonStore');
const sockets = require('../../lib/accountSockets');
const authStore = require('../../lib/authStore');

// Disconnects WhatsApp or the network cause routinely; the session stays linked.
const TRANSIENT_CLOSE_CODES = new Set([408, 428, 500, 503, 504, 515]);
const NUMBER_RE = /^\d{7,15}$/;
const ATTEMPT_RE = /^[a-f0-9]{24}$/;
const STORED_STATES = new Set(['pending', 'active', 'expired', 'logged_out']);
// Credentials that are missing or unreadable can never connect: stop and say so.
const AUTH_FATAL = new Set(['AUTH_MISSING', 'AUTH_CORRUPT']);

function credentialsOnDisk(dir) {
  try {
    const creds = authStore.readJson(dir, 'creds.json');
    return creds && typeof creds === 'object' ? creds : null;
  } catch { return null; }
}

function numberFromCreds(creds) {
  const n = String(creds?.me?.id || '').split(':')[0].split('@')[0];
  return NUMBER_RE.test(n) ? n : null;
}

function defaultRemoveCredentials(root, number) {
  const base = path.join(root, number);
  let attempts = [];
  try { attempts = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* nothing on disk */ }
  for (const attempt of attempts) {
    try { authStore.removeDir(path.join(base, attempt)); } catch { /* rows may not exist */ }
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
}

function createSessionManager(opts) {
  const primaryDir = path.resolve(opts.sessionDir || 'session');
  const linkedRoot = path.join(primaryDir, 'linked');
  const manifestFile = path.join(linkedRoot, 'accounts.json');
  const maxAccounts = Math.max(1, Math.min(100, Number(opts.maxAccounts) || 20));
  const pairTimeoutMs = Math.max(1, Number(opts.pairTimeoutMs) || 40_000);
  const codeLifetimeMs = Math.max(1, Number(opts.codeLifetimeMs) || 60_000);
  const pendingLifetimeMs = Math.max(codeLifetimeMs, Number(opts.pendingLifetimeMs) || 120_000);
  // Keep removal waits short so the 20-second process shutdown budget is not used up.
  const logoutTimeoutMs = Math.max(1, Math.min(8000, Number(opts.logoutTimeoutMs ?? opts.unlinkShutdownTimeoutMs) || 5000));
  const retirementShutdownTimeoutMs = Math.max(1, Math.min(8000, Number(opts.retirementShutdownTimeoutMs) || 2000));
  const log = opts.log || require('../../lib/logger')('sessions');
  const removeCredentials = opts.removeCredentials || ((number) => defaultRemoveCredentials(linkedRoot, number));
  const notify = () => { try { opts.onStatusChange?.(); } catch { /* non-fatal */ } };
  const emit = (event) => { try { opts.onEvent?.(event); } catch { /* the owner notice is best effort */ } };
  const staleMs = Math.max(10, Number(opts.staleMs) || 30 * 60_000);
  const staleCheckMs = Math.max(500, Math.min(5 * 60_000, Math.floor(staleMs / 2)));
  const probeTimeoutMs = Math.max(100, Number(opts.probeTimeoutMs) || 15_000);
  let staleTimer = null;
  let maintainTimer = null;
  // Refresh each connection now and then while the bot is idle. Long-lived
  // WhatsApp sockets can go deaf in ways nothing reports; a fresh one cannot.
  const recycleMs = opts.recycleMs === undefined ? 8 * 3_600_000 : Math.max(0, Number(opts.recycleMs) || 0);
  const maintainMs = Math.max(500, Number(opts.maintainMs) || 60_000);
  const validManifest = (data) => Boolean(
    data && data.version === 1 && data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts) &&
    Object.entries(data.accounts).every(([number, record]) =>
      NUMBER_RE.test(number) && record && ATTEMPT_RE.test(String(record.attempt || '')) && STORED_STATES.has(record.state)),
  );
  const stored = readJsonSafe(manifestFile, { defaultValue: { version: 1, accounts: {} }, validate: validManifest });
  // Refuse to replace a corrupt index: credentials may still be recoverable.
  const manifestError = !stored.ok;
  const manifest = stored.ok ? stored.data : { version: 1, accounts: {} };
  if (manifestError) log.error('Linked-account index is unreadable; preserved session files. Fix or remove accounts.json before adding accounts.');

  // Why a connected linked number would not answer ('' = it answers).
  function pauseReason(entry) {
    if (!entry.number) return '';
    if (!entry.connected) return 'disconnected';
    if (entry.status !== 'active') return `session-${entry.status}`;
    if (manifest.accounts[entry.number]?.attempt !== entry.attempt) return 'replaced-by-newer-link';
    return '';
  }

  // Log when a connected number starts or stops being paused, and at most every
  // 10 minutes while messages keep being dropped for the same reason.
  function trackPause(entry, { dropped = false } = {}) {
    if (!entry.number || entry.stopped) return;
    const reason = entry.connected ? pauseReason(entry) : '';
    const now = Date.now();
    if (reason !== entry.pauseReason) {
      const was = entry.pauseReason;
      entry.pauseReason = reason;
      entry.pauseNoticeAt = now;
      entry.pauseSince = reason ? now : 0;
      if (reason) log.warn(`Linked +${entry.number} is connected but NOT answering: ${reason}.`);
      else if (was) log.info?.(`Linked +${entry.number} is answering again.`);
    } else if (reason && dropped && now - entry.pauseNoticeAt >= 10 * 60_000) {
      entry.pauseNoticeAt = now;
      log.warn(`Linked +${entry.number} is still connected but NOT answering: ${reason}.`);
    }
  }

  async function defaultProbe(sock) {
    if (typeof sock.query !== 'function') return true;
    await sock.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }, probeTimeoutMs);
    return true;
  }

  function probeSocket(sock) {
    let t;
    return Promise.race([
      Promise.resolve((opts.probe || defaultProbe)(sock)),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error('probe timed out')), probeTimeoutMs + 1000); t.unref?.(); }),
    ]).finally(() => clearTimeout(t));
  }

  async function forceReconnect(entry) {
    entry.reconnects += 1;
    entry.reconnector.reset();
    await startEntry(entry);
  }

  // An account that should be connected: the owner (unless WhatsApp logged it
  // out) and every linked number that finished linking.
  const isLive = (entry) => !entry.stopped && (entry === primary ? entry.status !== 'logged_out' : entry.status === 'active');

  // Periodic upkeep: (1) any account that is down with no reconnect pending is
  // restarted (nothing may stay offline silently); (2) one idle connection per
  // run is refreshed when it is older than recycleMs.
  async function maintain() {
    if (stopped) return;
    const now = Date.now();
    for (const entry of entries.values()) {
      if (!entry.number || !entry.connected || entry.stopped) continue;
      trackPause(entry);
    }
    for (const entry of entries.values()) {
      if (!isLive(entry) || entry.connected || entry.starting || entry.reconnector.scheduled) continue;
      if (now - (entry.lastCloseAt || 0) < 5000) continue;
      log.warn(`${entry.number ? `Linked +${entry.number}` : 'Owner account'} was offline with no reconnect pending; reconnecting.`);
      entry.reconnector.reset();
      entry.reconnector.schedule(1000);
    }
    if (!recycleMs) return;
    let busy = false; try { busy = Boolean(opts.isBusy?.()); } catch { /* treat as idle */ }
    if (busy) return;
    const due = [...entries.values()]
      .filter((e) => !e.stopped && e.connected && e.sock && e.status === 'active' && !e.probing && now - e.openedAt >= recycleMs * e.jitter)
      .sort((a, b) => a.openedAt - b.openedAt)[0];
    if (!due || stopped) return;
    log.info?.(`Refreshing the ${due.number ? `+${due.number}` : 'owner'} connection (up ${((now - due.openedAt) / 3_600_000).toFixed(1)} h).`);
    await forceReconnect(due);
  }

  // Owner's `.heal`: reconnect every account that is down or does not answer
  // WhatsApp. `all` reconnects every account; `skip` leaves one session alone
  // (the one that is sending the reply).
  async function heal({ all = false, skip = '' } = {}) {
    const results = [];
    for (const entry of entries.values()) {
      if (entry.stopped || (entry === primary ? entry.status === 'logged_out' : entry.status !== 'active')) continue;
      const number = entry.number || primaryNumber();
      if (!number) continue;
      const role = entry.number ? 'linked' : 'owner';
      if (skip && entry.id === skip) { results.push({ number, role, result: 'skipped (this is the connection sending the reply; use .restart)' }); continue; }
      try {
        if (!entry.connected) { await forceReconnect(entry); results.push({ number, role, result: 'was offline, reconnecting' }); continue; }
        if (all) { await forceReconnect(entry); results.push({ number, role, result: 'reconnected' }); continue; }
        try { await probeSocket(entry.sock); entry.lastProbeOkAt = Date.now(); }
        catch { entry.connected = false; sockets.setOffline(entry.id, entry.sock); await forceReconnect(entry); results.push({ number, role, result: 'did not answer WhatsApp, reconnecting' }); continue; }
        const why = pauseReason(entry);
        results.push({ number, role, result: why ? `connected but paused: ${why}` : 'ok' });
      } catch (err) { results.push({ number, role, result: `could not fix: ${err?.message || err}` }); }
    }
    notify();
    return results;
  }

  // A socket that is "open" but has heard nothing for a long time gets one real
  // round trip to WhatsApp. An idle-but-healthy account passes and is left alone;
  // a dead one is recycled instead of staying silent until someone restarts the bot.
  async function checkStale() {
    const now = Date.now();
    for (const entry of entries.values()) {
      const sock = entry.sock;
      if (stopped || entry.stopped || !entry.connected || !sock || entry.probing) continue;
      if (now - Math.max(entry.lastInboundAt, entry.lastProbeOkAt, entry.openedAt) < staleMs) continue;
      entry.probing = true;
      try {
        await probeSocket(sock);
        entry.lastProbeOkAt = Date.now();
      } catch (err) {
        if (stopped || entry.stopped || entry.sock !== sock) continue;
        log.warn(`${entry.number ? `Linked +${entry.number}` : 'Primary account'} looked connected but did not answer WhatsApp (${err?.message || err}); reconnecting.`);
        entry.connected = false;
        sockets.setOffline(entry.id, sock);
        entry.reconnects += 1;
        entry.reconnector.schedule(1000);
        try { sock.end?.(new Error('stale-connection')); } catch { /* already closed */ }
        notify();
      } finally { entry.probing = false; }
    }
  }

  function health() {
    const now = Date.now();
    const out = [];
    for (const entry of entries.values()) {
      const number = entry.number || primaryNumber();
      if (!number) continue;
      out.push({
        number, role: entry.number ? 'linked' : 'owner',
        state: entry.connected ? (pauseReason(entry) ? 'paused' : 'answering') : entry.status === 'active' ? 'reconnecting' : entry.status,
        reason: pauseReason(entry),
        connectedFor: entry.connected && entry.openedAt ? now - entry.openedAt : 0,
        lastInboundAgo: entry.lastInboundAt ? now - entry.lastInboundAt : null,
        reconnects: entry.reconnects,
        lastClose: entry.lastCloseCode ? { code: entry.lastCloseCode, ago: now - entry.lastCloseAt } : null,
      });
    }
    return out;
  }

  const entries = new Map();
  const flights = new Map();
  const removals = new Map();
  let stopped = false;
  let stopPromise = null;
  let started = false;

  function writeRecord(number, record) {
    if (manifestError) throw Object.assign(new Error('Linked-account index is unavailable. Fix or remove accounts.json first.'), { statusCode: 503 });
    const previous = manifest.accounts[number];
    manifest.accounts[number] = record;
    try { writeJsonAtomic(manifestFile, manifest); }
    catch (err) {
      if (previous) manifest.accounts[number] = previous;
      else delete manifest.accounts[number];
      throw err;
    }
  }

  function dropRecord(number) {
    if (manifestError) throw Object.assign(new Error('Linked-account index is unavailable. Fix or remove accounts.json first.'), { statusCode: 503 });
    const previous = manifest.accounts[number];
    delete manifest.accounts[number];
    try { writeJsonAtomic(manifestFile, manifest); }
    catch (err) { if (previous) manifest.accounts[number] = previous; throw err; }
  }

  function mark(entry, state) {
    entry.status = state;
    if (!entry.number || manifest.accounts[entry.number]?.attempt !== entry.attempt) return;
    const previous = manifest.accounts[entry.number];
    if (previous.state === state) return;
    const linkedAt = previous.linkedAt || (state === 'active' && previous.state === 'pending' ? Date.now() : undefined);
    try { writeRecord(entry.number, { attempt: entry.attempt, state, ...(linkedAt ? { linkedAt } : {}) }); }
    catch (err) { log.error(`Could not save linked-account state: ${err.message}`); return; }
    // Tell the owner about the moments that need attention, once per change.
    if (state === 'active' && previous.state === 'pending') emit({ type: 'linked', number: entry.number });
    else if (state === 'logged_out') emit({ type: 'logged_out', number: entry.number, reason: entry.fatalReason || '' });
  }

  function newEntry({ id, number = null, attempt = null, state = 'pending', pairNumber = '' }) {
    const entry = {
      id, number, attempt,
      dir: number ? path.join(linkedRoot, number, attempt) : primaryDir,
      status: state, pairNumber, sock: null, auth: null, connected: false,
      stopped: false, starting: null, requestStarted: false, pairResult: null,
      waiters: [], expiryTimer: null, seen: new Map(), credentialWrites: new Set(), retryNoticeAt: 0,
      openedAt: 0, lastInboundAt: 0, lastProbeOkAt: 0, probing: false, reconnects: 0, pauseReason: '', pauseNoticeAt: 0, pauseSince: 0,
      lastCloseCode: 0, lastCloseAt: 0, fatalReason: '',
      jitter: 0.9 + Math.random() * 0.2,
    };
    entry.reconnector = createReconnector({
      baseMs: opts.reconnectBaseMs || 3000,
      maxMs: opts.reconnectMaxMs || 60_000,
      start: () => connect(entry),
      onError: (err) => log.warn(`Connection retry failed: ${err?.message || err}`),
    });
    return entry;
  }

  const primary = newEntry({ id: sockets.PRIMARY_SESSION, state: 'active', pairNumber: String(opts.pairNumber || '').replace(/\D/g, '') });
  entries.set(primary.id, primary);
  for (const [number, record] of Object.entries(manifest.accounts)) {
    const entry = newEntry({ id: `linked:${number}`, number, attempt: record.attempt, state: record.state });
    entries.set(entry.id, entry);
  }

  function settlePair(entry, err, result) {
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (err) waiter.reject(err); else waiter.resolve(result);
    }
  }

  function waitForCode(entry) {
    if (entry.pairResult && Date.now() < entry.pairResult.issuedAt + codeLifetimeMs) return Promise.resolve(entry.pairResult);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = entry.waiters.indexOf(waiter);
        if (i !== -1) entry.waiters.splice(i, 1);
        reject(Object.assign(new Error('WhatsApp did not issue a linking code in time. Please try again.'), { statusCode: 504 }));
      }, pairTimeoutMs);
      waiter.timer.unref?.();
      entry.waiters.push(waiter);
    });
  }

  async function retire(entry, reason = 'Session replaced') {
    entry.stopped = true;
    entry.reconnector.stop();
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    settlePair(entry, Object.assign(new Error(reason), { statusCode: 409 }));
    const old = entry.sock;
    entry.sock = null;
    entry.connected = false;
    if (old) {
      old.__superseded = true;
      sockets.setOffline(entry.id, old);
      try { await old.end(new Error(reason)); } catch { /* already closed */ }
    }
    // A creds.update may have been accepted just before this socket stopped.
    // Finish those writes before shutdown or replacing the session directory.
    await Promise.allSettled([...entry.credentialWrites]);
    notify();
  }

  function scheduleExpiry(entry) {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = setTimeout(() => {
      if (entry.connected || entry.auth?.creds?.registered || entry.stopped) return;
      mark(entry, 'expired');
      emit({ type: 'expired', number: entry.number });
      void retire(entry, 'Linking code expired');
    }, pendingLifetimeMs);
    entry.expiryTimer.unref?.();
  }

  async function issueCode(entry, sock) {
    if (!entry.pairNumber || entry.requestStarted || entry.stopped || entry.sock !== sock || entry.auth?.creds?.registered) return;
    entry.requestStarted = true;
    try {
      const code = await sock.requestPairingCode(entry.pairNumber);
      if (entry.stopped || entry.sock !== sock) return;
      if (!code) throw new Error('No code was returned');
      const result = { code: String(code), issuedAt: Date.now(), expiresInSeconds: Math.floor(codeLifetimeMs / 1000) || 1 };
      entry.pairResult = result;
      if (!entry.number) opts.onConsoleCode?.(result.code);
      settlePair(entry, null, result);
      if (entry.number) scheduleExpiry(entry);
      notify();
    } catch (err) {
      if (entry.stopped || entry.sock !== sock) return;
      log.warn(`Could not request a linking code: ${err?.message || err}`);
      settlePair(entry, Object.assign(new Error('WhatsApp could not issue a linking code. Please try again.'), { statusCode: 502 }));
      if (entry.number) {
        mark(entry, 'expired');
        void retire(entry, 'Linking request failed');
      }
    }
  }

  async function connect(entry) {
    if (stopped || entry.stopped) return null;
    if (entry.starting) return entry.starting;
    entry.starting = (async () => {
      if (entry.sock) {
        const old = entry.sock;
        entry.sock = null;
        entry.connected = false;
        old.__superseded = true;
        sockets.setOffline(entry.id, old);
        try { await old.end(new Error('reconnecting')); } catch { /* already closed */ }
      }
      entry.requestStarted = false;
      let auth;
      try {
        // A number that finished linking must load its saved login. A missing
        // or damaged login is never replaced with a blank one.
        auth = await opts.loadAuthState(entry.dir, { requireExisting: Boolean(entry.number) && entry.status === 'active' });
      } catch (err) {
        if (!AUTH_FATAL.has(err?.code) || !entry.number) throw err;
        entry.fatalReason = err.code === 'AUTH_MISSING' ? 'its saved login is missing' : 'its saved login is damaged';
        entry.reconnector.stop();
        log.error(`Linked +${entry.number} cannot start: ${entry.fatalReason}. Its stored data was left untouched.`);
        mark(entry, 'logged_out');
        notify();
        return null;
      }
      if (stopped || entry.stopped) return null;
      entry.auth = auth.state;
      const version = await opts.getVersion();
      if (stopped || entry.stopped) return null;
      const sock = opts.makeSocket({ auth: auth.state, version });
      sock.__sessionId = entry.id;
      sock.__sessionDir = entry.dir;
      sock.__accountNumber = entry.number;
      sock.__canRespond = () => !stopped && (!entry.number || (
        entry.connected && entry.status === 'active' &&
        manifest.accounts[entry.number]?.attempt === entry.attempt
      ));
      entry.sock = sock;
      // A long-running command can finish after its socket was replaced or the
      // number was removed. Recheck at send time as well as at dispatch.
      if (typeof sock.sendMessage === 'function') {
        const sendMessage = sock.sendMessage;
        sock.sendMessage = function (...args) {
          if (entry.stopped || entry.sock !== sock || !sock.__canRespond()) {
            return Promise.reject(new Error('This WhatsApp account is offline or paused.'));
          }
          return sendMessage.apply(sock, args);
        };
      }

      sock.ev.on('creds.update', () => {
        if (entry.stopped || sock.__superseded || entry.sock !== sock) return;
        const write = Promise.resolve().then(() => auth.saveCreds()).then(() => {
          if (entry.number && entry.auth?.creds?.registered && !entry.stopped && entry.status !== 'logged_out') {
            mark(entry, 'active');
            if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
            entry.expiryTimer = null;
          }
        }).catch((err) => log.error(`Could not save WhatsApp credentials: ${err?.message || err}`));
        entry.credentialWrites.add(write);
        void write.then(() => entry.credentialWrites.delete(write), () => entry.credentialWrites.delete(write));
      });

      sock.ev.on('connection.update', (update) => {
        if (entry.stopped || sock.__superseded || entry.sock !== sock) return;
        if (update.qr) {
          if (entry.pairNumber) void issueCode(entry, sock);
          else if (!entry.number) opts.onQr?.(update.qr);
        }
        if (update.connection === 'open') {
          entry.connected = true;
          entry.pairNumber = '';
          entry.pairResult = null;
          if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
          entry.expiryTimer = null;
          if (entry.number) mark(entry, 'active');
          else entry.status = 'active';
          entry.reconnector.reset();
          entry.retryNoticeAt = 0;
          entry.openedAt = Date.now();
          entry.lastInboundAt = entry.openedAt;
          sockets.setOnline(entry.id, sock);
          trackPause(entry);
          try { opts.onOpen?.(sock); } catch (err) { log.warn(`Connection handler failed: ${err.message}`); }
          notify();
        } else if (update.connection === 'close') {
          entry.connected = false;
          entry.reconnects += 1;
          sockets.setOffline(entry.id, sock);
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          entry.lastCloseCode = Number.isInteger(statusCode) ? statusCode : -1;
          entry.lastCloseAt = Date.now();
          if (statusCode === opts.loggedOutCode) {
            entry.reconnector.stop();
            entry.fatalReason = 'WhatsApp logged the device out';
            if (entry.number) mark(entry, 'logged_out');
            else entry.status = 'logged_out';
            settlePair(entry, Object.assign(new Error('WhatsApp logged out. Request a new linking code.'), { statusCode: 409 }));
            log.warn(`${entry.number ? `Linked +${entry.number}` : 'The owner account'} was logged out by WhatsApp. Its credentials were preserved.`);
          } else {
            const delay = entry.reconnector.schedule();
            if (delay !== false) {
              const code = Number.isInteger(statusCode) ? statusCode : 'unknown';
              // Do not log the raw disconnect object: it can contain session details.
              const now = Date.now();
              const message = `WhatsApp connection closed (status ${code}); retrying in ${delay}ms.`;
              entry.drops = (entry.drops || []).filter((at) => now - at < 10 * 60_000);
              entry.drops.push(now);
              const quietFor5Min = !entry.retryNoticeAt || now - entry.retryNoticeAt >= 5 * 60_000;
              if (TRANSIENT_CLOSE_CODES.has(statusCode)) {
                // Network blips and WhatsApp-requested restarts (408, 428, 515, ...)
                // reconnect by themselves: keep them out of the console unless
                // they pile up, which means the host's network is unstable.
                if (entry.drops.length >= 5 && quietFor5Min) {
                  entry.retryNoticeAt = now;
                  log.warn(`WhatsApp connection is unstable: ${entry.drops.length} drops in 10 min (last status ${code}). Check the host's network.`);
                } else log.debug?.(message);
              } else if (quietFor5Min) {
                entry.retryNoticeAt = now;
                log.warn(`${entry.number ? `Linked +${entry.number}: ` : ''}${message}`);
              } else log.debug?.(message);
            }
          }
          notify();
        }
      });

      sock.ev.on('messages.upsert', ({ messages = [], type }) => {
        if (entry.stopped || entry.sock !== sock) return;
        entry.lastInboundAt = Date.now();
        if (type !== 'notify' || !entry.connected) return;
        if (!sock.__canRespond()) { trackPause(entry, { dropped: true }); return; }
        const now = Date.now();
        for (const [key, at] of entry.seen) if (now - at > 5 * 60_000) entry.seen.delete(key);
        for (const msg of messages) {
          const from = msg?.key?.remoteJid;
          const id = msg?.key?.id;
          if (!msg?.message || !id || !from || opts.isSystemJid?.(from)) continue;
          const key = `${from}:${id}`;
          if (entry.seen.has(key)) continue;
          const sentAt = Number(msg.messageTimestamp) * 1000;
          if (sentAt && now - sentAt > 5 * 60_000) continue;
          entry.seen.set(key, now);
          Promise.resolve().then(() => {
            // The socket can change before this microtask runs.
            if (entry.stopped || entry.sock !== sock || !entry.connected || !sock.__canRespond()) return;
            return opts.onMessage(sock, msg);
          }).catch((err) => {
            if (!/rate-overlimit|not-authorized/.test(err?.message || '')) log.error(`Message handling failed: ${err?.message || err}`);
          });
        }
      });
      sock.ev.on('error', (err) => {
        const code = err?.output?.statusCode;
        if (![515, 503, 408].includes(code)) log.error(`WhatsApp socket error: ${err?.message || err}`);
      });
      return sock;
    })();
    try { return await entry.starting; }
    finally { entry.starting = null; }
  }

  async function startEntry(entry) {
    if (entry.stopped) return;
    try { await connect(entry); }
    catch (err) {
      log.warn(`Could not start a WhatsApp session: ${err?.message || err}`);
      entry.reconnector.schedule();
    }
  }

  async function start() {
    if (started) return;
    started = true;
    staleTimer = setInterval(() => { void checkStale(); }, staleCheckMs);
    staleTimer.unref?.();
    maintainTimer = setInterval(() => { void maintain().catch((err) => log.warn(`Connection upkeep failed: ${err?.message || err}`)); }, maintainMs);
    maintainTimer.unref?.();
    const tasks = [startEntry(primary)];
    for (const entry of entries.values()) {
      if (!entry.number || entry.status === 'logged_out' || entry.status === 'expired') continue;
      if (entry.status === 'pending') {
        // An interrupted registration, including a crash just after the open
        // event but before credentials were saved, must be linked again.
        if (!credentialsOnDisk(entry.dir)?.registered) { mark(entry, 'expired'); continue; }
        mark(entry, 'active');
      }
      // Linked numbers always come back after a restart.
      tasks.push(startEntry(entry));
    }
    await Promise.all(tasks);
  }

  function primaryNumber() {
    return numberFromCreds({ me: primary.sock?.user }) || numberFromCreds(primary.auth?.creds) || numberFromCreds(credentialsOnDisk(primaryDir));
  }

  async function doRequestPair(number) {
    if (stopped) throw Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 });
    if (manifestError) throw Object.assign(new Error('Linked-account index is unavailable. Fix or remove accounts.json first.'), { statusCode: 503 });
    if (primary.status !== 'logged_out' && primaryNumber() === number) {
      throw Object.assign(new Error('That is the owner number, which is already the main connection.'), { statusCode: 409 });
    }
    const old = entries.get(`linked:${number}`);
    // Registration may complete just before the async credentials save updates
    // the manifest. Never replace that newly registered socket on a retry.
    if (old && (old.status === 'active' || (old.status === 'pending' && (old.auth?.creds?.registered || credentialsOnDisk(old.dir)?.registered)))) {
      throw Object.assign(new Error('This number is already linked. Send .remove first if you want to link it again.'), { statusCode: 409 });
    }
    if (old?.pairResult && !old.stopped && Date.now() < old.pairResult.issuedAt + codeLifetimeMs) return old.pairResult;
    const existingCount = [...entries.values()].filter((e) => e.number && ['pending', 'active'].includes(e.status)).length;
    if ((!old || !['pending', 'active'].includes(old.status)) && existingCount >= maxAccounts) {
      throw Object.assign(new Error('The linked-account limit has been reached.'), { statusCode: 409 });
    }
    if (old) await retire(old);
    // Retirement can await socket or credential I/O. Shutdown during that wait
    // must not create a fresh generation afterwards.
    if (stopped) throw Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 });

    const attempt = crypto.randomBytes(12).toString('hex');
    // Baileys writes individual keys using the process umask. Restrict the
    // enclosing new directories even on hosts with a permissive default umask.
    fs.mkdirSync(path.join(linkedRoot, number, attempt), { recursive: true, mode: 0o700 });
    writeRecord(number, { attempt, state: 'pending' });
    const entry = newEntry({ id: `linked:${number}`, number, attempt, state: 'pending', pairNumber: number });
    entries.set(entry.id, entry);
    const pending = waitForCode(entry);
    // Start in the background so the timeout also covers authentication and the
    // WebSocket handshake. A failed start retries until the request expires.
    void startEntry(entry);
    try { return await pending; }
    catch (err) {
      if (!entry.connected && !entry.auth?.creds?.registered && !entry.stopped) {
        mark(entry, 'expired');
        await retire(entry, 'Linking request ended');
      }
      throw err;
    }
  }

  function requestPair(rawNumber) {
    if (stopped) return Promise.reject(Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 }));
    const number = String(rawNumber || '').replace(/\D/g, '');
    if (!NUMBER_RE.test(number)) return Promise.reject(Object.assign(new Error('Enter a valid international WhatsApp number.'), { statusCode: 400 }));
    if (flights.has(number)) return flights.get(number);
    const flight = doRequestPair(number).finally(() => { if (flights.get(number) === flight) flights.delete(number); });
    flights.set(number, flight);
    return flight;
  }

  function status() {
    const accounts = [];
    for (const entry of entries.values()) {
      const number = entry.number || primaryNumber();
      if (!number) continue;
      const state = entry.connected ? 'connected' : entry.status === 'pending' ? 'awaiting_link' : entry.status === 'active' ? 'connecting' : entry.status;
      const record = entry.number ? manifest.accounts[entry.number] : null;
      accounts.push({ number, state, ...(entry.attempt ? { sessionId: entry.attempt } : {}),
        ...(record?.linkedAt ? { linkedAt: record.linkedAt } : {}) });
    }
    const online = accounts.filter((a) => a.state === 'connected');
    return { connected: online.length > 0, botNumber: online[0]?.number || null, accounts };
  }

  // `.remove <number>`: log the device out of WhatsApp (best effort), then
  // forget the number completely. Only linked numbers can be removed, never
  // the owner.
  async function doRemoveAccount(number) {
    const entry = entries.get(`linked:${number}`);
    if (!entry || !manifest.accounts[number]) {
      throw Object.assign(new Error('That number is not linked.'), { statusCode: 404 });
    }
    // Stop listening first so the logout below is not reported as a WhatsApp logout.
    entry.stopped = true;
    entry.reconnector.stop();
    let loggedOut = false;
    const sock = entry.sock;
    if (sock && entry.connected && entry.status === 'active' && typeof sock.logout === 'function') {
      let timer;
      try {
        await Promise.race([
          sock.logout('Removed by the owner'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('logout timed out')), logoutTimeoutMs); }),
        ]);
        loggedOut = true;
      } catch (err) { log.warn(`+${number} could not be logged out of WhatsApp (${err?.message || err}); removing it here anyway.`); }
      finally { clearTimeout(timer); }
    }
    await retire(entry, 'Number removed');
    dropRecord(number);
    entries.delete(entry.id);
    try { removeCredentials(number); } catch (err) { log.warn(`Could not delete the stored login of +${number}: ${err?.message || err}`); }
    notify();
    return { number, loggedOut };
  }

  function removeAccount(rawNumber) {
    if (stopped) return Promise.reject(Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 }));
    const number = String(rawNumber || '').replace(/\D/g, '');
    if (!NUMBER_RE.test(number)) return Promise.reject(Object.assign(new Error('Enter a valid international WhatsApp number.'), { statusCode: 400 }));
    if (removals.has(number)) return removals.get(number);
    const operation = doRemoveAccount(number).finally(() => { if (removals.get(number) === operation) removals.delete(number); });
    removals.set(number, operation);
    return operation;
  }

  async function reconnectAll() {
    await Promise.all([...entries.values()].filter((e) => !e.stopped && (e === primary ? e.status !== 'logged_out' : e.status === 'active')).map(async (entry) => {
      entry.reconnector.reset();
      await startEntry(entry);
    }));
  }

  async function settleWithin(operations, timeoutMs) {
    if (!operations.length) return [];
    let timer;
    try {
      return await Promise.race([
        Promise.allSettled(operations),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
    if (maintainTimer) { clearInterval(maintainTimer); maintainTimer = null; }
    stopPromise = (async () => {
      const errors = [];
      // Give an accepted removal a short chance to finish before retiring sockets.
      const completed = await settleWithin([...removals.values()], logoutTimeoutMs);
      if (!completed) errors.push(new Error('A number removal did not finish before shutdown; its outcome is unknown.'));
      // Baileys socket.end() is asynchronous too; a stuck close must not consume
      // the entire process budget and prevent other sessions from closing.
      const retired = await settleWithin([...entries.values()].map((entry) => retire(entry, 'Service stopping')), retirementShutdownTimeoutMs);
      if (!retired) errors.push(new Error('A WhatsApp socket or credential write did not finish before shutdown.'));
      else for (const result of retired) if (result.status === 'rejected') errors.push(new Error('A WhatsApp session could not be retired.', { cause: result.reason }));
      if (errors.length) throw new AggregateError(errors, 'WhatsApp session shutdown was incomplete.');
    })();
    return stopPromise;
  }

  return { start, stop, requestPair, removeAccount, status, health, heal, reconnectAll, _checkStale: checkStale, _maintain: maintain };
}

module.exports = { createSessionManager };

'use strict';

/**
 * Download workers — the "receptionist / workers" split.
 *
 * The main process (the receptionist) stays connected to WhatsApp, reads
 * commands, checks permissions and replies. Heavy commands (movies, series,
 * TikTok, songs, DramaBox, …: every command module that exports
 * `worker: true`) run in a separate Node process started only for that
 * request:
 *
 *   main process                              worker process (lib/workers/child.js)
 *   ────────────                              ──────────────
 *   runCommand() ── exec ───────────────────▶ command.execute(proxySock, …)
 *                ◀── rpc sendMessage ───────   (downloads, ffmpeg, torrents)
 *   real sock.sendMessage(…)  ── result ────▶
 *                ◀── offer (numbered list) ─   selections.sendTextPrompt
 *   user replies ".2" ── select ───────────▶  runs the stored choice
 *                ◀── done ──────────────────   exits when nothing is left
 *
 * Media always travels as file paths ({ url: '/…/temp/x.mp4' }) — the worker
 * writes to disk and Baileys streams the file from disk — so no large buffer
 * ever crosses the process boundary or sits in the receptionist's memory.
 *
 * If a worker crashes (out of memory, native ffmpeg/torrent fault, bug) only
 * that request fails; the receptionist and WhatsApp connection stay up.
 *
 * WORKERS=off runs everything in-process like before (for debugging).
 */

const path = require('path');
const v8 = require('v8');
const { fork } = require('child_process');
const log = require('../logger')('workers');

const CHILD = path.join(__dirname, 'child.js');
const RPC_METHODS = new Set([
  'sendMessage', 'relayMessage', 'updateMediaMessage', 'groupMetadata',
  'sendPresenceUpdate', 'presenceSubscribe', 'readMessages',
]);
const TELEMETRY_FNS = new Set(['recordCommand', 'recordDownloadSuccess', 'recordFailure']);

const intEnv = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : fallback;
};
const maxWorkers = () => intEnv('WORKER_MAX', 2, 1, 16);
const heapMB = () => intEnv('WORKER_MAX_HEAP_MB', 768, 128, 8192);

let nextWorkerId = 0;
let nextTaskId = 0;
const workers = new Map();       // id -> worker
const waiting = [];              // slot queue (FIFO)
let running = 0;
let forkImpl = fork;             // swapped by tests

function enabled() {
  if (process.env.ZF_WORKER_CHILD === '1') return false; // never nest workers
  return !['off', '0', 'false', 'no'].includes(String(process.env.WORKERS || '').toLowerCase());
}

/** Should this command run in a worker? */
function shouldIsolate(command) {
  return Boolean(command && command.worker === true && enabled());
}

// ── slots ───────────────────────────────────────────────────────────────────
function acquireSlot() {
  if (running < maxWorkers()) { running++; return Promise.resolve(false); }
  return new Promise((resolve) => waiting.push(() => { running++; resolve(true); }));
}
function releaseSlot() {
  running = Math.max(0, running - 1);
  const next = waiting.shift();
  if (next) next();
}

// ── (de)serialization helpers ───────────────────────────────────────────────
/** v8 serialization turns Buffers into Uint8Arrays; Baileys needs real Buffers. */
function revive(value, depth = 0) {
  if (depth > 40 || value == null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = revive(value[i], depth + 1); return value; }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  for (const k of Object.keys(value)) value[k] = revive(value[k], depth + 1);
  return value;
}

/** Make a Baileys result safe to send back (class instances → plain data). */
function cloneable(value) {
  if (value === undefined) return undefined;
  try { v8.serialize(value); return value; } catch { /* fall through */ }
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (
      typeof v === 'bigint' ? Number(v)
        : (v && v.type === 'Buffer' && Array.isArray(v.data)) ? Buffer.from(v.data)
          : v)));
  } catch { /* fall through */ }
  return value && value.key ? { key: { ...value.key } } : undefined;
}

const plainError = (err) => ({
  message: String(err?.message || err || 'failed').slice(0, 500),
  code: err?.code ? String(err.code) : undefined,
  userMessage: typeof err?.userMessage === 'string' ? err.userMessage : undefined,
});
const toError = (data, fallback = 'worker failed') => Object.assign(new Error(data?.message || fallback), {
  ...(data?.code ? { code: data.code } : {}),
  ...(data?.userMessage ? { userMessage: data.userMessage } : {}),
});

/** Plain, structured-clone-safe snapshot of the socket for the worker. */
function sockInfo(sock) {
  return {
    sessionId: sock?.__sessionId ? String(sock.__sessionId) : null,
    sessionDir: sock?.__sessionDir ? String(sock.__sessionDir) : null,
    accountNumber: sock?.__accountNumber ? String(sock.__accountNumber) : null,
    user: sock?.user ? { id: sock.user.id, lid: sock.user.lid, name: sock.user.name } : null,
  };
}

/** Find the file a command module was loaded from (for require() in the worker). */
function commandFile(command) {
  if (command?.__workerFile) return command.__workerFile;
  for (const [file, mod] of Object.entries(require.cache)) {
    if (mod?.exports === command) return file;
    // Folders may export several commands as an array (commands/social).
    if (Array.isArray(mod?.exports) && mod.exports.includes(command)) return file;
  }
  return null;
}

// ── worker lifecycle ────────────────────────────────────────────────────────
function currentSock(worker) {
  try {
    const sockets = require('../accountSockets');
    if (worker.sessionId) {
      const live = sockets.getOnline(worker.sessionId);
      if (live) return live;
    }
  } catch { /* fall back to the original socket */ }
  return worker.sock;
}

function spawnWorker(sock, label) {
  const id = ++nextWorkerId;
  const child = forkImpl(CHILD, [], {
    serialization: 'advanced',
    execArgv: [`--max-old-space-size=${heapMB()}`],
    env: { ...process.env, ZF_WORKER_CHILD: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const worker = {
    id, child, label, sock, sessionId: sock?.__sessionId ? String(sock.__sessionId) : null,
    tasks: new Map(), offers: new Set(), selected: new Set(), holds: new Map(), alive: true, startedAt: Date.now(),
  };
  workers.set(id, worker);

  child.on('message', (message) => { void onMessage(worker, message); });
  child.on('error', (err) => { log.warn(`worker #${id} error: ${err?.message || err}`); });
  child.on('exit', (code, signal) => onExit(worker, code, signal));
  log.debug(`worker #${id} started for .${label}`);
  return worker;
}

function onExit(worker, code, signal) {
  if (!worker.alive) return;
  worker.alive = false;
  workers.delete(worker.id);
  const crashed = (code !== 0 && code !== null) || Boolean(signal);
  if (worker.tasks.size) {
    const err = Object.assign(new Error(`download worker stopped (${signal || `exit ${code}`})`), {
      code: 'WORKER_CRASHED',
      userMessage: '❌ That download crashed, but the bot is still online. Please try again.',
    });
    for (const task of worker.tasks.values()) task.reject(err);
    worker.tasks.clear();
    log.warn(`worker #${worker.id} (.${worker.label}) crashed: ${signal || `exit code ${code}`}`);
  } else if (crashed) {
    log.warn(`worker #${worker.id} (.${worker.label}) exited with ${signal || `code ${code}`}`);
  } else {
    log.debug(`worker #${worker.id} finished (${((Date.now() - worker.startedAt) / 1000).toFixed(1)}s)`);
  }
  for (const release of worker.holds.values()) { try { release(); } catch { /* ignore */ } }
  worker.holds.clear();
  if (worker.offers.size) {
    const selections = require('../selections');
    for (const offerId of [...worker.offers]) selections.dropOffer(offerId);
    worker.offers.clear();
  }
  releaseSlot();
}

function send(worker, message) {
  if (!worker.alive || !worker.child.connected) return false;
  try { worker.child.send(message); return true; } catch { return false; }
}

async function onMessage(worker, message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'rpc': {
      const { id, method } = message;
      try {
        if (!RPC_METHODS.has(method)) throw new Error(`method not available to workers: ${method}`);
        const sock = currentSock(worker);
        if (!sock || typeof sock[method] !== 'function') throw new Error('This WhatsApp account is offline or paused.');
        const value = await sock[method](...revive(Array.isArray(message.args) ? message.args : []));
        send(worker, { type: 'rpc-result', id, ok: true, value: cloneable(value) });
      } catch (err) {
        send(worker, { type: 'rpc-result', id, ok: false, error: plainError(err) });
      }
      return;
    }
    case 'offer': {
      registerOffer(worker, message.offer);
      return;
    }
    case 'hold': {
      // Mirror the worker's "file in use" marks so the main process' cleanup
      // and disk guard never delete a download that is still running.
      const { holdTemp } = require('../tempManager');
      worker.holds.set(message.holdId, holdTemp(message.key));
      return;
    }
    case 'release': {
      const release = worker.holds.get(message.holdId);
      worker.holds.delete(message.holdId);
      if (release) release();
      return;
    }
    case 'telemetry': {
      if (!TELEMETRY_FNS.has(message.fn)) return;
      try { const t = require('../telemetry'); t[message.fn](...(message.args || [])); } catch { /* counters are optional */ }
      return;
    }
    case 'done': {
      const task = worker.tasks.get(message.taskId);
      if (!task) return;
      worker.tasks.delete(message.taskId);
      if (message.ok) task.resolve(message.value);
      else task.reject(toError(message.error));
      return;
    }
    default:
  }
}

function registerOffer(worker, data) {
  if (!data || !data.offerId || !Number.isInteger(data.count) || data.count < 1) return;
  const selections = require('../selections');
  const offerId = String(data.offerId);
  worker.offers.add(offerId);
  try {
    selections.offer({
      chatId: data.chatId,
      sender: data.sender,
      items: Array.from({ length: data.count }, (_, i) => i),
      ids: Array.isArray(data.ids) ? data.ids : null,
      ttlMs: data.ttlMs,
      label: data.label || '',
      promptMessageId: data.promptMessageId || null,
      offerId,
      originMsg: data.originMsg || null,
      scope: data.scope,
      sessionDir: data.sessionDir,
      commandName: data.commandName || '',
      run: (sock, msg, extra, index) => select(worker, offerId, index, sock, msg, extra),
      onRemove: (entry) => {
        worker.offers.delete(offerId);
        if (entry?.picked) {
          // A pick: the "select" message follows shortly. If it never comes
          // (e.g. the command was switched off meanwhile), let the worker go.
          const timer = setTimeout(() => { if (!worker.selected.has(offerId)) send(worker, { type: 'offer-gone', offerId }); }, 60_000);
          timer.unref?.();
          return;
        }
        send(worker, { type: 'offer-gone', offerId });
      },
    });
  } catch (err) {
    worker.offers.delete(offerId);
    log.warn(`could not mirror a worker choice: ${err?.message || err}`);
  }
}

function startTask(worker, payload) {
  const taskId = ++nextTaskId;
  return new Promise((resolve, reject) => {
    worker.tasks.set(taskId, { resolve, reject });
    if (!send(worker, { ...payload, taskId })) {
      worker.tasks.delete(taskId);
      reject(Object.assign(new Error('download worker is not available'), {
        code: 'WORKER_GONE',
        userMessage: '⌛ That list has expired. Please run the command again.',
      }));
    }
  });
}

const extraCtx = (extra, msg) => ({
  from: extra?.from || msg?.key?.remoteJid,
  sender: extra?.sender,
  senderIds: Array.isArray(extra?.senderIds) ? extra.senderIds : [],
  commandName: extra?.commandName || '',
});

/** A numbered choice made in the main process runs inside the worker that offered it. */
async function select(worker, offerId, index, sock, msg, extra) {
  if (!worker.alive) {
    throw Object.assign(new Error('worker gone'), { code: 'WORKER_GONE', userMessage: '⌛ That list has expired. Please run the command again.' });
  }
  worker.sock = sock || worker.sock;
  worker.selected.add(offerId);
  return startTask(worker, { type: 'select', offerId, index, msg, ctx: extraCtx(extra, msg), sock: sockInfo(sock) });
}

/**
 * Run a command in a fresh worker process.
 * @returns {Promise<any>} resolves/rejects like command.execute would
 */
function runCommand({ command, sock, msg, args, ctx }) {
  const file = commandFile(command);
  const inProcess = () => command.execute(sock, msg, args, require('../../gateway/ctx').buildExtra(sock, msg, ctx));
  if (!file) return Promise.resolve().then(inProcess);
  let worker = null;
  let cancelled = false;
  const promise = acquireSlot().then(() => {
    if (cancelled) { releaseSlot(); throw Object.assign(new Error('cancelled'), { code: 'COMMAND_TIMEOUT' }); }
    try {
      worker = spawnWorker(sock, command.name || ctx?.commandName || 'command');
    } catch (err) {
      releaseSlot();
      log.warn(`could not start a worker (${err?.message || err}); running in-process`);
      return inProcess();
    }
    return startTask(worker, {
      type: 'exec',
      file,
      pick: command.name,
      msg,
      args: Array.isArray(args) ? args.map(String) : [],
      ctx: { from: ctx?.from, sender: ctx?.sender, senderIds: ctx?.senderIds || [], commandName: ctx?.commandName || '' },
      sock: sockInfo(sock),
    });
  });
  /** Stop the worker (used when the command times out). */
  promise.cancel = () => {
    cancelled = true;
    if (worker?.alive) { try { worker.child.kill('SIGKILL'); } catch { /* already gone */ } }
  };
  return promise;
}

/** Tell the user when every worker slot is busy (call before runCommand). */
function busy() { return running >= maxWorkers(); }

function stats() {
  return { running, waiting: waiting.length, max: maxWorkers(), workers: [...workers.values()].map((w) => ({ id: w.id, label: w.label, pid: w.child.pid, offers: w.offers.size, tasks: w.tasks.size, ageMs: Date.now() - w.startedAt })) };
}

/** Stop every worker (shutdown). */
function stopAll(signal = 'SIGTERM') {
  for (const worker of workers.values()) { try { worker.child.kill(signal); } catch { /* already gone */ } }
}

function _setForkForTests(fn) { forkImpl = typeof fn === 'function' ? fn : fork; }

module.exports = { enabled, shouldIsolate, runCommand, busy, stats, stopAll, _setForkForTests, _revive: revive };

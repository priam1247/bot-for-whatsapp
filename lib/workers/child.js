'use strict';

/**
 * Download worker process (started by lib/workers/pool.js).
 *
 * Runs one heavy command — and the numbered choices it offers — then exits,
 * giving all of its memory back to the system. It never connects to
 * WhatsApp: `sock` here is a small proxy whose sendMessage() asks the main
 * process to send. Media is passed as file paths, so big files are streamed
 * from disk by the main process instead of being copied between processes.
 */

const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const BOT_ROOT = path.resolve(__dirname, '..', '..');
process.chdir(BOT_ROOT);
process.env.ZF_WORKER_CHILD = '1';
process.title = 'zafar-worker';

if (typeof process.send !== 'function') {
  console.error('lib/workers/child.js is started by the bot; do not run it directly.');
  process.exit(1);
}

const send = (message) => { try { process.send(message); } catch { /* parent gone: exit below */ } };

// ── must run before any command module loads ───────────────────────────────
const tempManager = require('../tempManager');
tempManager.initializeTempSystem();
{
  // Mirror "in use" marks into the main process (its cleanup must skip them).
  const localHold = tempManager.holdTemp;
  let holdSeq = 0;
  tempManager.holdTemp = function holdTemp(key) {
    const releaseLocal = localHold(key);
    const holdId = ++holdSeq;
    send({ type: 'hold', holdId, key: String(key || '') });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseLocal();
      send({ type: 'release', holdId });
    };
  };
}
{
  // Counters are owned by the main process; forward instead of writing.
  const telemetry = require('../telemetry');
  for (const fn of ['recordCommand', 'recordDownloadSuccess', 'recordFailure']) {
    telemetry[fn] = (...args) => send({ type: 'telemetry', fn, args: args.map((a) => (typeof a === 'number' || typeof a === 'string' ? a : undefined)) });
  }
  telemetry.flushNow = () => {};
}
try { require('../safeLog').installConsoleFilter?.(['closing session', 'sessionentry', 'ratchet', 'chainkey', 'basekey', 'registrationid']); } catch { /* optional */ }

const selections = require('../selections');

// ── RPC to the main process ────────────────────────────────────────────────
let rpcSeq = 0;
const rpcPending = new Map();
function rpc(method, args) {
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    send({ type: 'rpc', id, method, args });
  });
}

/** Streams cannot cross processes: spool `{ stream }` media to a temp file first. */
async function spoolStreams(content) {
  if (!content || typeof content !== 'object') return { content, cleanup: [] };
  const cleanup = [];
  for (const key of ['video', 'image', 'audio', 'document', 'sticker']) {
    const media = content[key];
    if (media && typeof media === 'object' && media.stream && typeof media.stream.pipe === 'function') {
      const file = path.join(tempManager.getTempDir(), `wk_${process.pid}_${Date.now().toString(36)}_${key}`);
      await pipeline(media.stream, fs.createWriteStream(file));
      content = { ...content, [key]: { url: file } };
      cleanup.push(file);
    }
  }
  return { content, cleanup };
}

const PASSTHROUGH = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', 'inspect', 'ev', 'ws', 'authState', 'end', 'logout']);
function makeSock(info) {
  const base = {
    __sessionId: info?.sessionId || undefined,
    __sessionDir: info?.sessionDir || undefined,
    __accountNumber: info?.accountNumber || undefined,
    __isWorkerProxy: true,
    user: info?.user || undefined,
    __canRespond: () => true,
    async sendMessage(jid, content, options) {
      const { content: ready, cleanup } = await spoolStreams(content);
      try { return await rpc('sendMessage', [jid, ready, options]); }
      finally { for (const file of cleanup) tempManager.deleteTempFile(file); }
    },
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || PASSTHROUGH.has(prop)) return undefined;
      // Any other socket method (relayMessage, groupMetadata, …) is forwarded.
      return (...args) => rpc(prop, args);
    },
  });
}

// ── task bookkeeping & exit policy ─────────────────────────────────────────
const offers = new Map(); // offerId -> expiresAt
let busy = 0;
let exitTimer = null;

function scheduleExit() {
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
  if (busy > 0) return;
  const now = Date.now();
  for (const [id, until] of offers) if (until <= now) offers.delete(id);
  if (!offers.size) {
    // Nothing left to do: give the memory back.
    setImmediate(() => process.exit(0));
    return;
  }
  const soonest = Math.min(...offers.values());
  exitTimer = setTimeout(scheduleExit, Math.max(250, soonest - now + 250));
}

// Choices are kept here (with their closures) and mirrored into the main
// process, which asks for "run choice N of offer X" when the user replies.
const localChoices = new Map(); // offerId -> { run, items }
selections.setOfferHook((entry) => {
  localChoices.set(entry.offerId, { run: entry.run, items: entry.items });
  offers.set(entry.offerId, entry.at + entry.ttlMs);
  let originMsg = null;
  try { originMsg = entry.originMsg ? JSON.parse(JSON.stringify(entry.originMsg)) : null; } catch { originMsg = null; }
  send({
    type: 'offer',
    offer: {
      offerId: entry.offerId,
      chatId: entry.chatId,
      sender: [entry.rawSender, ...entry.senderSet].filter(Boolean),
      count: entry.items.length,
      ids: entry.ids,
      ttlMs: entry.ttlMs,
      label: entry.label,
      promptMessageId: entry.promptMessageId,
      scope: entry.scope,
      sessionDir: entry.sessionDir,
      commandName: entry.commandName,
      originMsg,
    },
  });
});

function errorData(err) {
  return {
    message: String(err?.message || err || 'failed').slice(0, 500),
    code: err?.code ? String(err.code) : undefined,
    userMessage: typeof err?.userMessage === 'string' ? err.userMessage : undefined,
  };
}

async function runTask(message) {
  busy++;
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
  try {
    const sock = makeSock(message.sock);
    const { buildExtra } = require('../../gateway/ctx');
    const extra = buildExtra(sock, message.msg, message.ctx || {});
    let value;
    if (message.type === 'exec') {
      const exported = require(message.file);
      const command = Array.isArray(exported) ? exported.find((c) => c?.name === message.pick) : exported;
      if (!command || typeof command.execute !== 'function') throw new Error('command not found in worker');
      value = await command.execute(sock, message.msg, message.args || [], extra);
    } else {
      const choice = localChoices.get(message.offerId);
      offers.delete(message.offerId);
      localChoices.delete(message.offerId);
      selections.dropOffer(message.offerId);
      if (!choice) throw Object.assign(new Error('choice expired'), { code: 'WORKER_GONE', userMessage: '⌛ That list has expired. Please run the command again.' });
      value = await choice.run(sock, message.msg, extra, choice.items[message.index]);
    }
    send({ type: 'done', taskId: message.taskId, ok: true, value: value === undefined || typeof value === 'object' ? undefined : value });
  } catch (err) {
    send({ type: 'done', taskId: message.taskId, ok: false, error: errorData(err) });
  } finally {
    busy--;
    scheduleExit();
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'rpc-result') {
    const pending = rpcPending.get(message.id);
    if (!pending) return;
    rpcPending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(Object.assign(new Error(message.error?.message || 'request failed'), message.error?.code ? { code: message.error.code } : {}));
    return;
  }
  if (message.type === 'offer-gone') {
    // The main process consumed, replaced or expired this choice.
    if (offers.delete(message.offerId)) {
      localChoices.delete(message.offerId);
      selections.dropOffer(message.offerId);
      scheduleExit();
    }
    return;
  }
  if (message.type === 'exec' || message.type === 'select') void runTask(message);
});

// The main process went away (restart/crash): stop instead of lingering.
process.on('disconnect', () => process.exit(0));
process.on('unhandledRejection', (err) => { console.error('[worker] unhandled rejection:', err?.message || err); });
process.on('uncaughtException', (err) => {
  console.error('[worker] crashed:', err?.message || err);
  process.exit(70);
});

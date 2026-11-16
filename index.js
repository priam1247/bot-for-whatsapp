/**
 * WhatsApp MD Bot - Main Entry Point
 */

// Keep .env, session/ and other cwd-relative runtime files with the bot even
// when the entry point is started from the repository root or a panel script.
process.chdir(__dirname);

// Baileys and the built-in SQLite store need a current Node runtime.
// Give panel users an actionable message before a dependency crashes on load.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(`Node.js ${process.versions.node} is too old. Use Node.js 22.13 or newer (Node 22 LTS is recommended).`);
  process.exit(1);
}

// A fresh install (or a panel reinstall) has no node_modules yet. Say that in
// one line instead of letting the first require() throw a 40-line stack.
(function checkDependencies() {
  try {
    require.resolve('@whiskeysockets/baileys');
  } catch {
    console.error('❌ Dependencies are missing — run `npm install` in this folder.');
    console.error('   Make sure the panel\'s Startup Command runs it, e.g. `npm install && node index.js`.');
    process.exit(1);
  }
})();

// There is no built-in owner. Without OWNER_NUMBER nobody could run owner
// commands, so fail with one clear line instead of starting half-configured.
(function checkOwner() {
  const { ownerNumber } = require('./config');
  if (!ownerNumber.length) {
    console.error('❌ OWNER_NUMBER is not set. Add your WhatsApp number (digits only, with country code) to .env or the panel variables.');
    console.error('   Example: OWNER_NUMBER=265XXXXXXXXX   (optional extra admins: ADMIN_NUMBERS=265AAA...,265BBB...)');
    process.exit(1);
  }
})();

// Production by default: skips the pino-pretty worker thread + dev overhead.
// Override with NODE_ENV=development when debugging locally.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { formatArgs, safeText, installConsoleFilter } = require('./lib/safeLog');
const { initializeTempSystem } = require('./lib/tempManager');
const { startCleanup, stopCleanup } = require('./lib/cleanup');
const { startDiskGuard, stopDiskGuard } = require('./lib/diskGuard');
initializeTempSystem();
startCleanup();
startDiskGuard();

const forbiddenPatternsConsole = [
  'closing session',
  'closing open session',
  'opening session',
  'removing old closed session',
  'migrating session',
  'session already',
  'sessionentry',
  'prekey bundle',
  'pendingprekey',
  '_chains',
  'registrationid',
  'currentratchet',
  'chainkey',
  'ratchet',
  'signal protocol',
  'ephemeralkeypair',
  'indexinfo',
  'basekey'
];

// Covers console.info too: libsignal prints "Closing session: SessionEntry {...}"
// (with private keys) through it.
const { warn: originalConsoleWarn } = installConsoleFilter(forbiddenPatternsConsole);

// Now safe to load libraries
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('./config');
let handler = require('./gateway/handler');
const { onReload } = require('./lib/hotReload');
onReload((freshHandler) => { handler = freshHandler; });
const { isSystemJid } = require('./lib/jid');

// Custom Pino logger with suppression for Baileys noise
const createSuppressedLogger = (level = 'silent') => {
  const forbiddenPatterns = [
    'closing session',
    'closing open session',
    'sessionentry',
    'prekey bundle',
    'pendingprekey',
    '_chains',
    'registrationid',
    'currentratchet',
    'chainkey',
    'ratchet',
    'signal protocol',
    'ephemeralkeypair',
    'indexinfo',
    'basekey',
    'sessionentry',
    'ratchetkey'
  ];

  let logger;
  try {
    logger = pino({
      level,
      // Fallback transport without pino-pretty (in case not installed)
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname'
        }
      },
      customLevels: {
        trace: 0,
        debug: 1,
        info: 2,
        warn: 3,
        error: 4,
        fatal: 5
      },
      // Redact sensitive fields
      redact: ['registrationId', 'ephemeralKeyPair', 'rootKey', 'chainKey', 'baseKey']
    });
  } catch (err) {
    // Fallback to basic pino without transport
    logger = pino({ level });
  }

  // Wrap log methods to filter
  const originalInfo = logger.info.bind(logger);
  logger.info = (...args) => {
    const msg = formatArgs(args);
    if (!forbiddenPatterns.some(pattern => msg.includes(pattern))) {
      originalInfo(...args);
    }
  };
  logger.debug = () => { }; // Fully disable debug
  logger.trace = () => { }; // Fully disable trace
  return logger;
};


const { createSessionManager } = require('./gateway/sessions/manager');
const FALLBACK_VERSION = [2, 3000, 1033141466];
let versionPromise = null;
let cachedVersion = null;
let versionValidUntil = 0;
function getWebVersion() {
  if (cachedVersion && Date.now() < versionValidUntil) return Promise.resolve(cachedVersion);
  if (!versionPromise) {
    versionPromise = new Promise((resolve) => {
      let done = false;
      const finish = (version, isFallback = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cachedVersion = version;
        // Retry failed lookups sooner, but coalesce simultaneous connections.
        versionValidUntil = Date.now() + (isFallback ? 5 * 60_000 : 60 * 60_000);
        versionPromise = null;
        resolve(version);
      };
      const timer = setTimeout(() => finish(FALLBACK_VERSION, true), 8000);
      timer.unref?.();
      Promise.resolve().then(() => fetchLatestWaWebVersion())
        .then((result) => result?.version ? finish(result.version) : finish(FALLBACK_VERSION, true))
        .catch(() => finish(FALLBACK_VERSION, true));
    });
  }
  return versionPromise;
}

// Owner notices (a number finished linking, WhatsApp logged one out, a code
// expired) arrive in the owner's own chat. They never start with the prefix, so
// the bot does not read them as commands.
function tellOwner(text) {
  try {
    const accountSockets = require('./lib/accountSockets');
    const sock = accountSockets.getOnline();
    const me = sock?.user?.id;
    if (!sock || !me) { console.warn(`Owner notice not sent (owner connection is offline): ${text}`); return; }
    Promise.resolve(sock.sendMessage(jidNormalizedUser(me), { text })).catch((err) => console.warn(`Owner notice failed: ${err?.message || err}`));
  } catch (err) { console.warn(`Owner notice failed: ${err?.message || err}`); }
}

function onSessionEvent(event) {
  const n = event?.number;
  if (!n) return;
  if (event.type === 'linked') {
    tellOwner(`✅ +${n} is linked. It stays connected until you send ${config.prefix}remove ${n}.`);
  } else if (event.type === 'logged_out') {
    tellOwner(`⚠️ +${n} was disconnected${event.reason ? ` (${event.reason})` : ''} and cannot reconnect by itself. Send ${config.prefix}pair ${n} to link it again, or ${config.prefix}remove ${n} to delete it.`);
  } else if (event.type === 'expired') {
    tellOwner(`⌛ The linking code for +${n} was not used in time. Send ${config.prefix}pair ${n} for a new one.`);
  }
}

async function startService() {
  const sessions = createSessionManager({
  sessionDir: config.sessionName,
  pairNumber: config.pairNumber,
  maxAccounts: Number(process.env.MAX_LINKED_ACCOUNTS || 20),
  loggedOutCode: DisconnectReason.loggedOut,
  // Login keys live in database/bot.sqlite (old session files are imported once).
  loadAuthState: (dir, options) => require('./lib/authStore').useSqliteAuthState(dir, options),
  getVersion: getWebVersion,
  makeSocket: ({ auth, version }) => makeWASocket({
    version,
    logger: createSuppressedLogger('silent'),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth,
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 20_000, // frequent pings keep idle panel/mobile networks from dropping the socket
    connectTimeoutMs: 60_000,
    getMessage: async () => undefined,
  }),
  // Idle = nothing downloading or queued, so a scheduled reconnect cannot cut a job off.
  isBusy: () => {
    try {
      const q = require('./lib/jobQueue').stats();
      return ((q.light?.active || 0) + (q.light?.queued || 0) + (q.heavy?.active || 0) + (q.heavy?.queued || 0)) > 0;
    } catch { return false; }
  },
  isSystemJid,
  onMessage: (sock, msg) => handler.handleMessage(sock, msg),
  onOpen: (sock) => {
    handler.onSocketOpen?.(sock);
    // Say "ready" once per account; later reconnects are routine and stay quiet.
    const who = String(sock?.__accountNumber || sock?.__sessionId || 'primary');
    if (!globalThis.__waOpened) globalThis.__waOpened = new Set();
    if (!globalThis.__waOpened.has(who)) { globalThis.__waOpened.add(who); console.log('WhatsApp connection is ready.'); }
    else require('./lib/logger')('sessions').debug('WhatsApp reconnected.');
  },
  onEvent: onSessionEvent,
  onQr: (qr) => { console.log('Scan this QR code with WhatsApp:'); qrcode.generate(qr, { small: true }); },
  // Only the owner's first login prints a code here. Codes for numbers added
  // with .pair are sent to the owner's chat instead.
  onConsoleCode: (code) => {
    console.log(`Linking code: ${code}`);
    console.log('WhatsApp → Linked devices → Link a device → Link with phone number instead.');
  },
});

const accountSockets = require('./lib/accountSockets');
accountSockets.setHealthSource(() => sessions.health());
accountSockets.setHealer((options) => sessions.heal(options));
accountSockets.setLinker({ pair: (number) => sessions.requestPair(number), remove: (number) => sessions.removeAccount(number) });
const { startSessionServices } = require('./gateway/sessions/startup');
await startSessionServices(sessions);

try { require('./lib/logger').banner([
  'WhatsApp Service',
  `prefix   ${config.prefix}`,
  `node     ${process.version}`,
]); } catch (error) { console.warn('Startup banner warning:', error.message); }

// Report the optional local media tools without installing or repairing them at boot.
(() => {
  try {
  const ffmpeg = require('./lib/ffmpeg');
  const nm3u8dl = require('./lib/nm3u8dl');
  const mediaLog = require('./lib/logger')('media');
  if (!ffmpeg.works()) mediaLog.warn('ffmpeg unavailable; some media conversions will not work.');
  else mediaLog.debug(`ffmpeg ${ffmpeg.version() || 'ready'}`);
  nm3u8dl.ensureInstalled().then((bin) => {
    mediaLog.debug(bin ? `N_m3u8DL-RE ${nm3u8dl.version() || 'ready'}` : 'N_m3u8DL-RE unavailable; using HLS fallback');
  }).catch(() => {});
  } catch (error) { console.warn('Media helper startup warning:', error.message); }
})();

return { sessions };
}

const { createServiceLifecycle, stopSessionServices } = require('./gateway/sessions/startup');
const lifecycle = createServiceLifecycle({
  start: startService,
  stop: stopSessionServices,
  onError: (err) => console.error('WhatsApp service startup failed; local session files were preserved. Check the storage and the logs above.', err?.message || err),
});

// This is a long-running service even when all sockets are disconnected and
// maintenance timers are unref'd. Stay available for retries until an explicit shutdown.
const serviceLifetime = setInterval(() => {}, 24 * 60 * 60 * 1000);

// Give accepted credential writes a chance to finish on a normal panel stop.
// The local session files are never deleted.
let shutdownRequested = false;
function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`Stopping WhatsApp service (${signal}).`);
  stopCleanup();
  stopDiskGuard();
  try { require('./lib/workers/pool').stopAll(); } catch { /* no workers */ }
  let finished = false;
  let timer;
  const finish = (timedOut = false) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    clearInterval(serviceLifetime);
    if (timedOut) console.warn('Shutdown timed out. Local files were preserved.');
    try { require('./lib/telemetry').flushNow(); } catch { /* non-fatal */ }
    process.exit(0);
  };
  timer = setTimeout(() => finish(true), 20_000);
  void lifecycle.shutdown().catch((err) => {
    console.warn('WhatsApp shutdown was incomplete.');
    // Normal Baileys noise filtering may suppress an entire error merely because
    // it mentions a closing session. Bypass that filter only for sanitized,
    // component-labelled shutdown diagnostics; never print raw session data.
    const failures = err instanceof AggregateError && Array.isArray(err.errors) ? err.errors : [err];
    const labels = new Set(['WhatsApp sessions shutdown failed']);
    for (const failure of failures) {
      const detail = safeText(failure);
      const lower = detail.toLowerCase();
      const sensitive = forbiddenPatternsConsole.some((pattern) => pattern !== 'closing session' && pattern !== 'closing open session' && lower.includes(pattern)) ||
        /\b(?:private|public|identity|signing|encryption|backup|chain|pre|base)[\s_-]*key\b|\b(?:buffer|uint8array)\b|[A-Za-z0-9+/]{40,}={0,2}/i.test(detail);
      if (!sensitive) {
        originalConsoleWarn.call(console, 'Shutdown detail:', detail);
        continue;
      }
      const label = labels.has(failure?.message) ? failure.message : 'WhatsApp shutdown component failed';
      const reason = lower.includes('closing open session') ? 'closing open session; ' : lower.includes('closing session') ? 'closing session; ' : '';
      originalConsoleWarn.call(console, 'Shutdown detail:', `${label}; ${reason}sensitive session details omitted.`);
    }
  }).finally(() => finish());
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
void lifecycle.start();
// Handle process termination
process.on('uncaughtException', (err) => {
  // Handle ENOSPC errors gracefully without crashing
  if (err?.code === 'ENOSPC' || err?.errno === -28 || err?.message?.includes('no space left on device')) {
    console.error('⚠️ ENOSPC Error: No space left on device. Attempting cleanup...');
    {
      const { cleanupOldFiles } = require('./lib/cleanup');
      cleanupOldFiles();
      console.warn('⚠️ Cleanup completed. The service may need more disk space.');
    }
    return; // Don't crash, just log and continue
  }
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  // Handle ENOSPC errors gracefully
  if (err?.code === 'ENOSPC' || err?.errno === -28 || err?.message?.includes('no space left on device')) {
    console.warn('⚠️ ENOSPC Error in promise: No space left on device. Attempting cleanup...');
    {
      const { cleanupOldFiles } = require('./lib/cleanup');
      cleanupOldFiles();
      console.warn('⚠️ Cleanup completed. The service may need more disk space.');
    }
    return; // Don't crash, just log and continue
  }

  // Don't spam console with rate limit errors
  if (err?.message?.includes('rate-overlimit')) {
    console.warn('⚠️ Rate limit reached. Please slow down your requests.');
    return;
  }
  console.error('Unhandled Rejection:', err);
});

module.exports = {};

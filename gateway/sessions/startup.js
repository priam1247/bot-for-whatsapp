'use strict';

// Start the WhatsApp sessions. If startup fails, close whatever was opened so a
// retry never leaves duplicate sockets or listeners behind.
async function startSessionServices(sessions, cleanup) {
  try {
    await sessions.start();
    return {};
  } catch (error) {
    try { await sessions.stop(); } catch { /* preserve the original failure */ }
    try { await cleanup?.(); } catch { /* preserve the original failure */ }
    throw error;
  }
}

// Close every socket and flush credentials. The caller bounds shutdown time.
async function stopSessionServices({ sessions } = {}) {
  try { await sessions?.stop(); }
  catch (err) { throw new AggregateError([new Error('WhatsApp sessions shutdown failed', { cause: err })], 'Some WhatsApp services could not stop cleanly.'); }
}

// Own the startup retry and shutdown race in one place. A shutdown that arrives
// while recovery is still starting waits for its result and closes it exactly once.
function createServiceLifecycle({ start, stop, onError, retryDelayMs = 30_000 } = {}) {
  if (typeof start !== 'function') throw new TypeError('A service start function is required.');
  let resource = null; let inFlight = null; let retryTimer = null;
  let closing = false; let shutdownPromise = null;

  function startOnce() {
    if (closing || inFlight || resource) return inFlight || Promise.resolve(resource);
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    inFlight = Promise.resolve().then(start).then((value) => {
      resource = value || {};
      return resource;
    }).catch((err) => {
      if (!closing) {
        try { onError?.(err); } catch { /* reporting must not prevent retry */ }
        retryTimer = setTimeout(() => { retryTimer = null; void startOnce(); }, Math.max(1, Number(retryDelayMs) || 30_000));
      }
      return null;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    shutdownPromise = (async () => {
      if (inFlight) await inFlight;
      if (resource) {
        const current = resource;
        resource = null;
        if (stop) await stop(current);
        else await current.stop?.();
      }
    })();
    return shutdownPromise;
  }

  return { start: startOnce, shutdown };
}

module.exports = { startSessionServices, stopSessionServices, createServiceLifecycle };

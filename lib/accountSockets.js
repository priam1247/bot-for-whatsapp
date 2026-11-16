'use strict';

// A stable session key prevents a download or selection from being sent through
// a different WhatsApp account when several accounts are connected at once.
const { EventEmitter } = require('events');
const events = new EventEmitter();
const sockets = new Map();
const PRIMARY_SESSION = 'primary';
let healthSource = null;
let healer = null;
let linker = null;

function sessionKey(sock) {
  return String(sock?.__sessionId || PRIMARY_SESSION);
}

function setOnline(id, sock) {
  const key = String(id || PRIMARY_SESSION);
  sockets.set(key, sock);
  events.emit('online', key);
}

function setOffline(id, sock) {
  const key = String(id || PRIMARY_SESSION);
  if (sockets.get(key) === sock) sockets.delete(key);
}

function getOnline(id = PRIMARY_SESSION) {
  const sock = sockets.get(String(id || PRIMARY_SESSION)) || null;
  if (!sock) return null;
  try { return typeof sock.__canRespond !== 'function' || sock.__canRespond() ? sock : null; }
  catch { return null; }
}

function list() {
  return [...sockets.values()];
}

// The session manager registers a function that describes every account (state,
// why it is paused, last message heard) for the owner's .status.
const setHealthSource = (fn) => { healthSource = typeof fn === 'function' ? fn : null; };
const health = () => { try { return healthSource ? healthSource() : []; } catch { return []; } };

// `.heal` asks the session manager to check every account and reconnect the ones that are stuck.
const setHealer = (fn) => { healer = typeof fn === 'function' ? fn : null; };
const heal = async (options) => (healer ? healer(options) : []);

// `.pair` and `.remove` reach the session manager through this hook.
const setLinker = (impl) => { linker = impl && typeof impl.pair === 'function' && typeof impl.remove === 'function' ? impl : null; };
const needLinker = () => { if (!linker) throw new Error('Linking is not available right now.'); return linker; };
const pairNumber = (number) => needLinker().pair(number);
const removeNumber = (number) => needLinker().remove(number);

module.exports = {
  PRIMARY_SESSION,
  setLinker,
  pairNumber,
  removeNumber,
  setHealer,
  heal,
  setHealthSource,
  health,
  list,
  sessionKey,
  setOnline,
  setOffline,
  getOnline,
  onOnline: (fn) => { events.on('online', fn); return () => events.off('online', fn); },
};

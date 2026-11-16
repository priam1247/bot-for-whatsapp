'use strict';

/**
 * Message guards — decide whether THIS socket may act on THIS message.
 * `decide()` is the only entry point the handler uses.
 *
 * ROLES
 *   owner    the main pairing number (the primary session). Full control.
 *   linked   a secondary number paired under the owner. Acts from its own account.
 *   allowed  a number a specific linked number (or the owner) allowed with .allow.
 *            Its Parent is that session, permanently. Entries with no recorded
 *            parent belong to the owner's session.
 *
 * RULES
 *   1. Owner and linked numbers: only messages sent by this socket's own account
 *      (fromMe) run, in groups and DMs. Strangers never trigger anything.
 *   2. Allowed users (database/allowed.json, written only by .allow): only in a GROUP, only with the prefix, and only the Parent's
 *      socket replies. In a DM they get no reply from anyone.
 *   3. Cross-talk is forbidden: a socket never answers another session's users.
 *      If the Parent is offline or not approved, nobody answers them — not the
 *      owner and not another linked number — until the Parent is back.
 *   4. Exactly one socket claims a message, so several sessions in one group
 *      never produce duplicate replies.
 *   5. An allowed user who also has their own online session is answered by that
 *      session (rule 1), not by their Parent.
 *
 * Replies go back through the claiming socket, quoted to the original message.
 */

const { jidVariants, splitIdentity } = require('../lib/jid');
const accountSockets = require('../lib/accountSockets');
const { readAllowed, isApprovedUser, isParentSession } = require('./users/access');

const CLAIM_TTL_MS = 10 * 60 * 1000;
const MAX_CLAIMS = 5000;
const claims = new Map(); // `${chat}:${id}` -> { at, session }

const isGroupJid = (jid) => String(jid || '').endsWith('@g.us');

function ownIds(sock) {
  const number = sock?.__accountNumber;
  return [number ? `${number}@s.whatsapp.net` : null, sock?.user?.id, sock?.user?.lid].filter(Boolean);
}

function sweep(now) {
  if (claims.size < MAX_CLAIMS / 2 && claims.size % 50 !== 0) return;
  for (const [key, c] of claims) if (now - c.at > CLAIM_TTL_MS) claims.delete(key);
  while (claims.size > MAX_CLAIMS) claims.delete(claims.keys().next().value);
}

/** True when the sender recorded on the message is this socket's own account. */
function isOwnSender(sock, msg) {
  if (msg?.key?.fromMe !== true) return false;
  const chat = msg.key.remoteJid;
  if (!isGroupJid(chat)) return true;
  const participant = msg.key.participant || msg.participant;
  if (!participant) return true; // own group messages normally carry no participant
  const mine = jidVariants(ownIds(sock), sock.__sessionDir);
  const theirs = jidVariants(participant, sock.__sessionDir);
  if (!mine.size || !theirs.size) return true; // cannot compare; WhatsApp already marked it fromMe
  if ([...theirs].some((id) => mine.has(id))) return true;
  // An @lid participant we cannot map to a phone number is still our own
  // message (fromMe is set by WhatsApp). Only a participant we can positively
  // identify as a DIFFERENT number is rejected.
  return !splitIdentity(participant, sock.__sessionDir).pn;
}

/** First socket to claim a chat message wins; other sockets get false. */
function claim(sock, msg, now = Date.now()) {
  const chat = msg?.key?.remoteJid;
  const id = msg?.key?.id;
  if (!chat || !id) return true;
  sweep(now);
  const key = `${chat}:${id}`;
  const session = accountSockets.sessionKey(sock);
  const existing = claims.get(key);
  if (existing && existing.session !== session) return false;
  if (!existing) claims.set(key, { at: now, session });
  return true;
}

/** @returns {{ allow: boolean, reason: string }} */
function evaluate(sock, msg) {
  if (!msg?.message) return { allow: false, reason: 'empty' };
  if (msg.key?.fromMe !== true) return { allow: false, reason: 'not-sender' };
  if (!isOwnSender(sock, msg)) return { allow: false, reason: 'foreign-participant' };
  if (typeof sock.__canRespond === 'function' && !sock.__canRespond()) return { allow: false, reason: 'not-approved' };
  if (!claim(sock, msg)) return { allow: false, reason: 'claimed-by-other-session' };
  return { allow: true, reason: 'ok' };
}

/**
 * Allowed users who message in a GROUP from their own number (rule 2, 3, 5).
 * @returns {{ allow: boolean, reason: string, sender?: string, senderIds?: string[] }}
 */
function evaluateAllowedUser(sock, msg) {
  if (!msg?.message) return { allow: false, reason: 'empty' };
  if (msg.key?.fromMe === true) return { allow: false, reason: 'own-message' };
  if (!isGroupJid(msg.key?.remoteJid)) return { allow: false, reason: 'not-group' };
  const participant = msg.key.participant || msg.participant;
  if (!participant) return { allow: false, reason: 'no-participant' };
  const senderIds = [participant, msg.key.participantAlt].filter(Boolean);
  let users;
  try { users = readAllowed().users; } catch { return { allow: false, reason: 'allowlist-unavailable' }; }
  const theirs = jidVariants(senderIds, sock.__sessionDir);
  // Check EVERY entry for this person (duplicates can exist when sessions know different PN/LID forms).
  const matches = users.filter((u) => isApprovedUser(u) && (theirs.has(u.number) || (u.alt || []).some((a) => theirs.has(a))));
  if (!matches.length) return { allow: false, reason: 'not-allowed' };
  // One person, one Parent: if duplicates exist, the oldest entry decides, so only the number that allowed them first answers.
  const owner = matches.reduce((a, b) => (Number(b.addedAt) || Infinity) < (Number(a.addedAt) || Infinity) ? b : a);
  if (!isParentSession(owner, sock)) return { allow: false, reason: 'not-parent' };
  // The socket's own account is only ever served through the fromMe path.
  if ([...jidVariants(ownIds(sock), sock.__sessionDir)].some((id) => theirs.has(id))) return { allow: false, reason: 'own-account' };
  const hasOwnSession = accountSockets.list().some((s) => {
    if (typeof s.__canRespond === 'function' && !s.__canRespond()) return false;
    return [...jidVariants(ownIds(s), s.__sessionDir)].some((id) => theirs.has(id));
  });
  if (hasOwnSession) return { allow: false, reason: 'has-own-session' };
  if (typeof sock.__canRespond === 'function' && !sock.__canRespond()) return { allow: false, reason: 'not-approved' };
  if (!claim(sock, msg)) return { allow: false, reason: 'claimed-by-other-session' };
  return { allow: true, reason: 'ok', sender: participant, senderIds };
}

/**
 * The one decision the handler asks for. `role` is set only when allow is true:
 * 'owner' | 'linked' (own messages) or 'allowed' (a guest, with sender/senderIds).
 * @returns {{ allow: boolean, reason: string, role?: string, parent?: string, sender?: string, senderIds?: string[] }}
 */
function decide(sock, msg) {
  const session = accountSockets.sessionKey(sock);
  if (msg?.key?.fromMe === true) {
    const r = evaluate(sock, msg);
    if (!r.allow) return r;
    return { ...r, role: session === accountSockets.PRIMARY_SESSION ? 'owner' : 'linked', parent: session };
  }
  const r = evaluateAllowedUser(sock, msg);
  return r.allow ? { ...r, role: 'allowed', parent: session } : r;
}

const _resetForTests = () => claims.clear();

module.exports = { decide, evaluate, evaluateAllowedUser, isOwnSender, claim, ownIds, isGroupJid, _resetForTests };

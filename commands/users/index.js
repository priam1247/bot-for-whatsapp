const { readAllowed, writeAllowed, cleanNumber, findUserIndex, isParentSession } = require('../../gateway/users/access');
const { canonicalIdentity } = require('../../lib/jid');
const accountSockets = require('../../lib/accountSockets');
const { jidVariants } = require('../../lib/jid');
const { ownIds } = require('../../gateway/guards');

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

function resolveTarget(args, msg, sessionDir) {
  const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  let jid = mentioned?.length ? mentioned[0] : null;
  if (!jid && args[0]) {
    const n = cleanNumber(args[0]);
    if (n) jid = `${n}@s.whatsapp.net`;
  }
  if (!jid) return null;
  const { number, alt } = canonicalIdentity(jid, sessionDir);
  return number ? { number, alt, jid } : null;
}

// Owner/admin: manage everyone. A linked number (non-owner): only its own users,
// i.e. entries whose Parent is this socket's session.
const isMine = (entry, sock) => isParentSession(entry, sock);

module.exports = [
  {
    name: 'allow',
    aliases: ['allowuser'],
    category: 'admin',
    description: 'Allow a number',
    usage: '.allow <number>',
    ownerOnly: true,
    adminOk: true,
    linkedOk: true,
    async execute(sock, msg, args, extra) {
      const target = resolveTarget(args, msg, sock.__sessionDir);
      if (!target) return extra.reply('Usage: .allow <number>');
      const { number, alt, jid } = target;
      const wl = readAllowed();
      if (!extra.isOwner) {
        const theirs = jidVariants(jid, sock.__sessionDir);
        if ([...jidVariants(ownIds(sock), sock.__sessionDir)].some((id) => theirs.has(id))) {
          await react(sock, msg, '⚠️');
          return extra.reply('⚠️ That is your own number.');
        }
      }
      const existingIdx = findUserIndex(wl.users, jid, sock.__sessionDir);
      if (existingIdx !== -1) {
        await react(sock, msg, '⚠️');
        if (!extra.isOwner && !isMine(wl.users[existingIdx], sock)) {
          return extra.reply(`⚠️ +${number} is already allowed by another number.`);
        }
        return extra.reply(`⚠️ Already allowed: +${number}`);
      }
      wl.users.push({
        number,
        ...(alt.length ? { alt } : {}),
        addedBy: 'whatsapp',
        allowedVia: accountSockets.sessionKey(sock),
        enabled: true,
        addedAt: Date.now(),
      });
      writeAllowed(wl);
      await react(sock, msg, '✅');
      return extra.reply(`✅ Allowed +${number}`);
    },
  },
  {
    name: 'disallow',
    aliases: ['disallowuser', 'removeuser'],
    category: 'admin',
    description: 'Disallow a number',
    usage: '.disallow <number>',
    ownerOnly: true,
    adminOk: true,
    linkedOk: true,
    async execute(sock, msg, args, extra) {
      const target = resolveTarget(args, msg, sock.__sessionDir);
      if (!target) return extra.reply('Usage: .disallow <number>');
      const { number, jid } = target;
      const wl  = readAllowed();
      const idx = findUserIndex(wl.users, jid, sock.__sessionDir);
      // A linked number can only remove people it allowed; to it, anyone else
      // looks the same as "not found".
      if (idx === -1 || (!extra.isOwner && !isMine(wl.users[idx], sock))) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ Not found: +${number}`);
      }
      wl.users.splice(idx, 1);
      writeAllowed(wl);
      await react(sock, msg, '✅');
      return extra.reply(`🗑️ Removed +${number}`);
    },
  },
  {
    name: 'listusers',
    aliases: ['users', 'allowed'],
    category: 'admin',
    description: 'List allowed users',
    usage: '.listusers',
    ownerOnly: true,
    linkedOk: true,
    async execute(sock, msg, args, extra) {
      const wl = readAllowed();
      const users = extra.isOwner ? wl.users : wl.users.filter((u) => isMine(u, sock));
      if (!users.length) return extra.reply('📋 Allowed (0)');
      const lines = users.map((u, i) => `${i + 1}. +${u.number}${u.enabled === false ? ' _(paused)_' : ''}`);
      return extra.reply([`📋 *Allowed (${users.length})*`, ...lines].join('\n'));
    },
  },
];

'use strict';

// Owner-only: link another WhatsApp number and remove it again.
//   .pair 265991234567     → sends a linking code; once the number enters it
//                            the number stays connected until .remove
//   .remove 265991234567   → logs it out of WhatsApp and forgets it
// The restrictions between the owner and linked numbers are unchanged
// (see gateway/guards.js): a linked number only acts from its own account.

const accountSockets = require('../../lib/accountSockets');

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

const digits = (raw) => String(raw || '').replace(/\D/g, '');
const validNumber = (n) => /^\d{7,15}$/.test(n);

function formatCode(code) {
  const c = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : String(code);
}

module.exports = [
  {
    name: 'pair',
    aliases: ['link'],
    category: 'admin',
    description: 'Link another WhatsApp number',
    usage: '.pair <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const number = digits(args[0]);
      if (!validNumber(number)) return extra.reply('Usage: .pair <number>\nExample: .pair 265991234567 (digits only, country code first)');
      await react(sock, msg, '⏳');
      let result;
      try { result = await accountSockets.pairNumber(number); }
      catch (err) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ ${String(err?.message || 'Could not request a linking code.')}`);
      }
      await react(sock, msg, '✅');
      return extra.reply([
        `🔗 *Linking code for +${number}*`,
        '',
        `*${formatCode(result.code)}*`,
        '',
        `On that phone: WhatsApp → Linked devices → Link a device → Link with phone number instead, then enter the code within about ${result.expiresInSeconds || 60} seconds.`,
        '',
        `It stays connected until you send .remove ${number}`,
      ].join('\n'));
    },
  },
  {
    name: 'remove',
    aliases: ['unlink'],
    category: 'admin',
    description: 'Disconnect and forget a linked number',
    usage: '.remove <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const number = digits(args[0]);
      if (!validNumber(number)) return extra.reply('Usage: .remove <number>\nExample: .remove 265991234567');
      await react(sock, msg, '⏳');
      let result;
      try { result = await accountSockets.removeNumber(number); }
      catch (err) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ ${err?.statusCode === 404 ? `+${number} is not linked.` : String(err?.message || 'Could not remove that number.')}`);
      }
      await react(sock, msg, '✅');
      return extra.reply(result.loggedOut
        ? `🗑️ Removed +${number}. It was logged out of WhatsApp.`
        : `🗑️ Removed +${number} from the bot. WhatsApp could not be reached, so if the device still shows in that phone's Linked devices, they can log it out there.`);
    },
  },
];

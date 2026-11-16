/**
 * ZaFar Bot — site shortcuts: .tiktok / .instagram / .fb
 *
 * Gronka (see socialMedia.js) is the only download source.
 *
 *   .tiktok <link>       .tt
 *   .instagram <link>    .ig .insta .igdl .reels
 *   .fb <link>           .fbdl .facebookdl .facebook
 */

const config = require('../../config');
const { extractUrl } = require('../../lib/publicMediaDownload');
const socialMedia = require('./socialMedia.js');

function quotedTextOf(msg) {
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return '';
  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    ''
  );
}

const makeCommand = ({ name, aliases, description, usage, platform }) => ({
  worker: true, // runs in a download worker process (lib/workers)
  name,
  aliases,
  category: 'media',
  description,
  usage,

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const input = (Array.isArray(args) ? args : []).join(' ');
    const url = extractUrl(input) || extractUrl(quotedTextOf(msg));
    if (!url) return say(`Usage: ${config.prefix || '.'}${usage.replace(/^\./, '')}`);
    try {
      return await socialMedia.downloadAndSend(sock, msg, extra, { platform, url });
    } catch (error) {
      return say(socialMedia.friendlyError(error, platform));
    }
  },
});

module.exports = [
  makeCommand({
    name: 'tiktok',
    aliases: ['tt'],
    description: 'Download a TikTok video (no watermark when the source allows it)',
    usage: '.tiktok <TikTok link>',
    platform: 'tiktok',
  }),
  makeCommand({
    name: 'instagram',
    aliases: ['ig', 'insta', 'igdl', 'reels'],
    description: 'Download Instagram reels, videos, or photos',
    usage: '.instagram <Instagram link>',
    platform: 'instagram',
  }),
  makeCommand({
    name: 'fb',
    aliases: ['fbdl', 'facebookdl', 'facebook'],
    description: 'Download a Facebook video or reel',
    usage: '.fb <Facebook video link>',
    platform: 'facebook',
  }),
];

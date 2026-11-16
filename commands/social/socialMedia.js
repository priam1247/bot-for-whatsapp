'use strict';

/**
 * Public TikTok, Facebook and Instagram downloads for .tiktok, .fb and .instagram.
 *
 * Gronka (lib/downloads/gronka.js) is the ONLY source. One request returns the
 * finished file(s); if it fails the command reports Gronka's reason and stops.
 * There is no second provider and no local pipeline behind it, so a
 * broken source shows up as a clear error that can be fixed.
 *
 * Delivery follows .movie/.kk: each file is downloaded to ./temp, sent to
 * WhatsApp from disk, then deleted (see lib/downloads/stage.js).
 */

const defaultGronka = require('../../lib/downloads/gronka');
const { safeUrl } = require('../../lib/publicMediaDownload');
const { withStagedMedia } = require('../../lib/downloads/stage');
const log = require('../../lib/logger')('social-media');

const MAX_ITEMS = 10;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function safeMediaUrl(value) {
  try { return safeUrl(value).href; } catch { return null; }
}

function normalizeInputUrl(value, platform) {
  const text = String(value || '').trim();
  if (!text || text.length > 4096) throw fail('BAD_LINK', 'unsupported link');
  let url;
  try { url = new URL(text); } catch { throw fail('BAD_LINK', 'unsupported link'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw fail('BAD_LINK', 'unsupported link');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const matches = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (platform === 'facebook') {
    if (!['facebook.com', 'fb.watch', 'fb.com'].some(matches)) throw fail('BAD_LINK', 'unsupported Facebook link');
    return url.href;
  }
  if (platform === 'tiktok') {
    if (!matches('tiktok.com')) throw fail('BAD_LINK', 'unsupported TikTok link');
    return url.href;
  }
  if (!['instagram.com', 'instagr.am', 'ddinstagram.com'].some(matches)) {
    throw fail('BAD_LINK', 'unsupported Instagram link');
  }
  if (matches('ddinstagram.com')) url.hostname = 'www.instagram.com';
  return url.href;
}

function createSocialMedia({ logger = log, gronka = defaultGronka, stage = withStagedMedia } = {}) {
  async function resolveViaGronka(url) {
    if (!gronka.enabled) {
      throw fail('NOT_CONFIGURED', 'GRONKA_API_KEY is not set', { userMessage: 'Downloads are not set up yet. The owner needs to set GRONKA_API_KEY.' });
    }
    const result = await gronka.download(url, { mode: 'auto' });
    const items = [];
    for (const file of result.files) {
      if (file.kind === 'audio' || file.type === 'audio') continue;
      const safe = safeMediaUrl(file.url);
      if (!safe) continue;
      const image = file.type === 'image' || file.kind === 'file';
      const ext = (/\.(png|webp|jpe?g)(?:\?|$)/i.exec(file.filename || file.url) || [])[1] || '';
      items.push(image
        ? { url: safe, kind: 'image', mimeType: /png/i.test(ext) ? 'image/png' : /webp/i.test(ext) ? 'image/webp' : 'image/jpeg' }
        : { url: safe, kind: 'video', title: defaultGronka.titleFromFilename(file.filename || result.filename) });
      if (items.length >= MAX_ITEMS) break;
    }
    if (!items.length) throw fail('NO_MEDIA', 'Gronka returned no safe media URL', { userMessage: 'The download service returned no file for that link.' });
    return items;
  }

  async function resolveFacebook(input) {
    const url = normalizeInputUrl(input, 'facebook');
    const video = (await resolveViaGronka(url)).find((item) => item.kind === 'video');
    if (!video) throw fail('NO_MEDIA', 'Gronka returned no video', { userMessage: 'That Facebook link has no downloadable video.' });
    return { url: video.url, kind: 'video', title: video.title || '' };
  }

  async function resolveTiktok(input) {
    const url = normalizeInputUrl(input, 'tiktok');
    const video = (await resolveViaGronka(url)).find((item) => item.kind === 'video');
    if (!video) throw fail('NO_MEDIA', 'Gronka returned no video', { userMessage: 'That TikTok link has no downloadable video.' });
    return { url: video.url, kind: 'video', title: video.title || '' };
  }

  async function resolveInstagram(input) {
    return resolveViaGronka(normalizeInputUrl(input, 'instagram'));
  }

  async function downloadAndSend(sock, msg, extra, { platform, url } = {}) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
    const sendItems = async (items) => {
      let sent = 0;
      let lastError = null;
      for (const item of items) {
        const caption = item.caption || '';
        const isVideo = item.kind === 'video';
        try {
          // one file on disk at a time: download → send → delete
          await stage(item.url, { kind: isVideo ? 'video' : 'image', label: platform || 'social' }, async (staged) => {
            const imageMime = staged.kind === 'image' ? staged.mime : (item.mimeType || 'image/jpeg');
            const body = isVideo
              ? { video: { url: staged.file }, mimetype: 'video/mp4', ...(caption ? { caption } : {}) }
              : { image: { url: staged.file }, mimetype: imageMime, ...(caption ? { caption } : {}) };
            await sock.sendMessage(chatId, body, { quoted: msg });
          });
          sent++;
        } catch (error) {
          lastError = error;
          logger.warn?.(`${item.kind} delivery failed (${error?.code || 'SEND_FAILED'})`);
        }
      }
      if (!sent) {
        // a clear reason (file too big, storage full, link expired) beats a generic one
        if (lastError?.userMessage) throw lastError;
        throw fail('SEND_FAILED', 'WhatsApp could not send the resolved media');
      }
      if (lastError) logger.warn?.('some carousel media could not be sent');
      return sent;
    };

    await react('⏳');
    try {
      const items = platform === 'facebook' ? [await resolveFacebook(url)]
        : platform === 'tiktok' ? [await resolveTiktok(url)]
          : await resolveInstagram(url);
      const sent = await sendItems(items);
      await react('✅');
      for (const item of items) {
        try { require('../../lib/telemetry').recordDownloadSuccess(item.kind); } catch { /* optional telemetry */ }
      }
      return { sent: true, count: sent, platform };
    } catch (error) {
      await react('❌');
      const code = String(error?.code || 'FAILED');
      logger.warn?.(`${platform || 'social'} download failed (${code})`);
      if (!error.code) error.code = code;
      throw error;
    }
  }

  return { resolveFacebook, resolveTiktok, resolveInstagram, downloadAndSend };
}

function friendlyError(error, platform) {
  if (error?.userMessage) return `❌ ${error.userMessage}`;
  if (String(error?.code || '') === 'BAD_LINK') {
    if (platform === 'facebook') return '❌ Please provide a public Facebook video or reel link.';
    if (platform === 'tiktok') return '❌ Please provide a public TikTok video link.';
    return '❌ Please provide a public Instagram post, reel, or video link.';
  }
  if (String(error?.code || '') === 'SEND_FAILED') return '❌ WhatsApp could not send that media. Try again.';
  return `❌ ${platform === 'facebook' ? 'Facebook' : platform === 'tiktok' ? 'TikTok' : 'Instagram'} download failed. Try again later.`;
}

module.exports = {
  ...createSocialMedia(),
  createSocialMedia,
  friendlyError,
  normalizeInputUrl,
  constants: { MAX_ITEMS },
};

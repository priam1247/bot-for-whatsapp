'use strict';

// .dramabox — search DramaBox by title or book ID and deliver an episode as a
// video. The episode is streamed internet → disk → WhatsApp; it is never held
// in memory. Runs in a download worker (see lib/workers), so a failed or huge
// download can never freeze the bot.
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const dramabox = require('./source');
const selections = require('../../lib/selections');
const { downloadPublicFile } = require('../../lib/publicMediaDownload');
const { getTempDir, deleteTempFile, holdTemp } = require('../../lib/tempManager');
const log = require('../../lib/logger')('dramabox');

const MAX_EPISODE_MB = 2000; // WhatsApp 2 GB file limit
const AS_DOCUMENT_ABOVE = 64 * 1024 * 1024; // WhatsApp plays inline videos up to ~64 MB reliably
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const prefixOf = () => config.prefix || '.';
const USAGE = (p) => [
  `❌ Usage: ${p}dramabox <title or book ID> [episode]`,
  '',
  `Examples:`,
  `${p}dramabox love ruse`,
  `${p}dramabox 42000028805 3`,
].join('\n');

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function reply(sock, msg, extra, text) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  return extra?.reply ? extra.reply(text) : sock.sendMessage(chatId, { text }, selections.quoteOpts(msg));
}

/** "love ruse 3" → { query: 'love ruse', episode: 3 } ; "42000028805 ep2" → id + 2 */
function parseArgs(args) {
  const tokens = (Array.isArray(args) ? args : []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!tokens.length) return null;
  let episode = 1;
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && /^(?:ep?|episode)?\d{1,4}$/i.test(last)) {
    episode = Number(last.replace(/^\D+/, ''));
    tokens.pop();
  }
  const query = tokens.join(' ');
  return { query, episode, bookId: dramabox.looksLikeBookId(query) ? query : null };
}

async function deliverEpisode(sock, msg, extra, { bookId, episode, title = '' }) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  const p = prefixOf();
  const status = extra?.status ? await extra.status(`🎭 Getting episode ${episode}…`).catch(() => null) : null;
  const update = async (text) => {
    if (status?.update) { try { await status.update(text); return; } catch { /* fall through */ } }
    await reply(sock, msg, extra, text);
  };

  let stream;
  try {
    stream = await dramabox.getDramaBoxStream(bookId, episode);
  } catch (error) {
    log.warn(`resolve failed (${error?.code || 'FAILED'})`);
    if (error?.code === 'NO_EPISODE') return update(`❌ Episode ${episode} does not exist — this drama has ${error.total} episodes.`);
    if (error?.rateLimited) return update('⏳ DramaBox is busy right now. Please try again in a minute.');
    if (error?.serviceDown) return update('❌ The DramaBox service is offline right now. Please try again later.');
    if (error?.code === 'NOT_FOUND' || error?.code === 'BAD_INPUT') return update('❌ No DramaBox title found with that ID. Try searching by name instead.');
    return update('❌ Could not get this DramaBox episode. Please try again.');
  }

  if (!title) {
    try { title = (await dramabox.details(bookId)).title; } catch { /* the title is only cosmetic */ }
  }
  const label = title || `DramaBox ${bookId}`;
  await update(`⬇️ Downloading *${label}* — episode ${stream.episode}/${stream.total}${stream.quality ? ` (${stream.quality})` : ''}…`);

  const file = path.join(getTempDir(), `drama_${bookId}_${stream.episode}_${Date.now().toString(36)}.mp4`);
  const release = holdTemp(path.basename(file));
  try {
    const { bytes } = await downloadPublicFile(stream.url, file, {
      maxBytes: MAX_EPISODE_MB * 1024 * 1024,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    });
    const next = stream.episode < stream.total ? `\n\n▶️ Next: ${p}dramabox ${bookId} ${stream.episode + 1}` : '\n\n✅ Final episode';
    const caption = `🎭 *${label}*\n📺 Episode ${stream.episode}/${stream.total}${stream.quality ? ` · ${stream.quality}` : ''}\n📦 ${fmtMB(bytes)}${next}`;
    const fileName = `${label.replace(/[^\w\s.-]+/g, '').trim().slice(0, 60) || 'DramaBox'} - EP${String(stream.episode).padStart(2, '0')}.mp4`;
    // { url: <local file> } makes Baileys stream the file from disk.
    const content = bytes > AS_DOCUMENT_ABOVE
      ? { document: { url: file }, mimetype: 'video/mp4', fileName, caption }
      : { video: { url: file }, mimetype: 'video/mp4', caption, fileName };
    await sock.sendMessage(chatId, content, selections.quoteOpts(msg));
    try { require('../../lib/telemetry').recordDownloadSuccess('dramabox'); } catch { /* counters are optional */ }
    try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch { /* best effort */ }
  } catch (error) {
    log.warn(`download failed (${error?.code || 'FAILED'})`);
    const why = error?.code === 'TOO_BIG' ? `it is larger than ${MAX_EPISODE_MB} MB`
      : error?.code === 'MEDIA_RATE_LIMIT' ? 'DramaBox is busy right now'
        : (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') ? 'the server is out of disk space'
          : 'the download failed';
    await reply(sock, msg, extra, `❌ Could not send episode ${stream.episode} (${why}).\n\nYou can still watch it here:\n${stream.url}`);
  } finally {
    release();
    if (fs.existsSync(file)) deleteTempFile(file);
  }
  return undefined;
}

async function execute(sock, msg, args, extra) {
  const p = prefixOf();
  const parsed = parseArgs(args);
  if (!parsed) return reply(sock, msg, extra, USAGE(p));
  let episode;
  try { episode = dramabox.validateEpisode(parsed.episode); }
  catch { return reply(sock, msg, extra, USAGE(p)); }

  try { await sock.sendMessage(extra?.from || msg?.key?.remoteJid, { react: { text: '🎭', key: msg.key } }); }
  catch { /* best effort */ }

  if (parsed.bookId) return deliverEpisode(sock, msg, extra, { bookId: parsed.bookId, episode });

  let results;
  try {
    results = await dramabox.search(parsed.query, 8);
  } catch (error) {
    log.warn(`search failed (${error?.code || 'FAILED'})`);
    if (error?.rateLimited) return reply(sock, msg, extra, '⏳ DramaBox is busy right now. Please try again in a minute.');
    if (error?.serviceDown) return reply(sock, msg, extra, '❌ The DramaBox service is offline right now. Please try again later.');
    return reply(sock, msg, extra, '❌ DramaBox search failed. Please try again.');
  }
  if (!results.length) return reply(sock, msg, extra, `❌ No DramaBox drama found for "${parsed.query}".`);
  if (results.length === 1) return deliverEpisode(sock, msg, extra, { ...results[0], episode });

  const lines = results.map((r, i) => `*${i + 1}.* ${r.title}${r.episodes ? ` · ${r.episodes} eps` : ''}`);
  const text = [
    `🎭 *DramaBox results for "${parsed.query}"*`,
    '',
    ...lines,
    '',
    `Reply with a number to get episode ${episode}. ${p}cancel to stop.`,
  ].join('\n');
  await selections.sendTextPrompt(sock, msg, extra, {
    text,
    items: results,
    label: 'dramabox',
    run: (s, m, x, item) => deliverEpisode(s, m, x, { bookId: item.bookId, title: item.title, episode }),
  });
  return undefined;
}

module.exports = {
  name: 'dramabox',
  aliases: ['drama', 'dramastream'],
  category: 'media',
  description: 'Search DramaBox and get an episode as a video',
  usage: `${prefixOf()}dramabox <title or book ID> [episode]`,
  worker: true,
  timeoutMs: 25 * 60 * 1000,
  execute,
  _parseArgs: parseArgs,
};

/**
 * .kk — Asian dramas, movies, anime and Hollywood from KissKh.
 *
 *   .kk <title>            search, tap a result (a movie downloads; a series gives episode 1)
 *   .kk <title> e5         one episode
 *   .kk <title> e1-3       an episode range (max MAX_EPISODES per request)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const kisskh = require('../../lib/kisskh');
const engine = require('../../lib/movies/adapter');
const host = require('../../lib/movies/host');
const selections = require('../../lib/selections');
const diskSpace = require('../../lib/diskSpace');
const jobQueue = require('../../lib/jobQueue');
const { getTempDir, createTempFilePath, deleteTempFile, holdTemp } = require('../../lib/tempManager');
const { safeErrorMessage } = require('../../lib/userErrors');
const log = require('../../lib/logger')('kisskh');

const MAX_EPISODES = 6;
const EPISODE_RX = /^ep?(\d{1,4})(?:-(\d{1,4}))?$/i;
const MOVIES = () => config.movies || {};
const pad = (n) => String(n).padStart(2, '0');

function parseArgs(args) {
  const words = [];
  let from = null;
  let to = null;
  for (const a of args) {
    const m = EPISODE_RX.exec(a);
    if (m && from === null) { from = Number(m[1]); to = m[2] ? Number(m[2]) : from; continue; }
    words.push(a);
  }
  if (from !== null && to < from) [from, to] = [to, from];
  return { title: words.join(' ').trim(), from, to };
}

const help = (P) => `Usage: ${P}kk <title> [e5 | e1-3]`;

async function sendSubtitle(sock, chatId, msg, episodeId, baseName) {
  if ((MOVIES().subtitles ?? true) === false) return;
  const dest = createTempFilePath('kisskh_sub', 'srt');
  const release = holdTemp(path.basename(dest, '.srt'));
  try {
    const sub = await kisskh.subtitle(episodeId, 'english');
    if (!sub) return;
    fs.writeFileSync(dest, sub.text, 'utf8');
    await host.sendSubtitle(sock, chatId, msg, { file: dest, name: baseName, language: sub.language });
  } catch (e) {
    log.debug(`${baseName} · no subtitle (${e.message})`);
  } finally {
    deleteTempFile(dest);
    release();
  }
}

/** Resolve the stream, download it, send the file (+ subtitle). Throws on failure. */
async function fetchEpisode(sock, msg, chatId, show, ep) {
  const label = show.isMovie ? show.title : `${show.title} E${pad(ep.number)}`;
  const quality = host.defaultQuality();
  const src = await kisskh.stream(ep.id);
  const dest = await engine.targetFile(label, show.year, quality, null, null);
  const reservation = diskSpace.reserveMovieSpace(getTempDir(), 0, MOVIES(), {
    label: `kisskh:${label}`,
    tagDir: path.dirname(dest),
    tagPrefix: path.basename(dest, path.extname(dest)),
  });
  const releaseHold = holdTemp(path.basename(dest, path.extname(dest)));
  let file = dest;
  try {
    const saved = await engine.download({ ...src, quality }, dest);
    file = (saved && saved.file) || dest;
    const sizeMB = fs.statSync(file).size / 1048576;
    if (sizeMB > host.maxDownloadMB()) {
      throw Object.assign(new Error(`file is ${Math.round(sizeMB)} MB`), { code: 'TOO_BIG', sizeMB });
    }
    await host.deliver(sock, chatId, msg, {
      file,
      title: label,
      caption: `🎬 *${show.title}${show.year ? ` (${show.year})` : ''}*${show.isMovie ? '' : `\nEpisode ${pad(ep.number)}`}\n${host.fmtMB(fs.statSync(file).size)}`,
    });
    if (ep.subs > 0) await sendSubtitle(sock, chatId, msg, ep.id, label);
  } finally {
    await host.release(file).catch(() => false);
    for (const f of new Set([dest, file])) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    reservation.release();
    releaseHold();
  }
}

async function start(sock, msg, extra, pick, job) {
  const chatId = extra.from;
  const react = (emoji) => (msg?.key
    ? sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {})
    : Promise.resolve());
  const say = (text) => sock.sendMessage(chatId, { text }, selections.quoteOpts(msg));

  await react('🔎');
  let show;
  try {
    show = await kisskh.details(pick.id);
  } catch (e) {
    log.error(`${pick.title} · details · ${e.code || 'FAIL'} · ${e.message}`);
    await react('❌');
    return say(safeErrorMessage(e, { isOwner: Boolean(extra?.isOwner), fallback: '❌ KissKh is not responding right now. Try again shortly.' }));
  }
  if (!show.episodes.length) { await react('❌'); return say(`❌ No episodes listed for *${show.title}* yet.`); }

  const first = show.episodes[0].number;
  const last = show.episodes[show.episodes.length - 1].number;
  let wanted;
  if (show.isMovie || show.episodes.length === 1) wanted = show.episodes;
  else {
    const from = job.from ?? first;
    const to = job.to ?? from;
    wanted = show.episodes.filter((e) => e.number >= from && e.number <= to);
  }
  if (!wanted.length) { await react('❌'); return say(`❌ *${show.title}* has episodes ${first}–${last}.`); }

  let note = '';
  if (wanted.length > MAX_EPISODES) { wanted = wanted.slice(0, MAX_EPISODES); note = ` (max ${MAX_EPISODES} per request)`; }
  if (note) await say(`ℹ️ Sending ${wanted.length} episodes${note}.`);

  await react('⏳');
  const failed = [];
  for (const ep of wanted) {
    try {
      await jobQueue.runInLane('heavy', () => fetchEpisode(sock, msg, chatId, show, ep));
      require('../../lib/telemetry').recordDownloadSuccess('movie');
    } catch (e) {
      require('../../lib/telemetry').recordFailure('movie');
      log.error(`${show.title} E${ep.number} · ${e.code || 'FAIL'} · ${e.message}`);
      failed.push({ ep, e });
    }
  }

  if (!failed.length) return react('✅');
  await react('❌');
  const [{ ep, e }] = failed;
  const nums = failed.map((f) => f.ep.number).join(', ');
  if (e.code === 'KISSKH_UPCOMING') return say(`⏳ ${show.title} E${pad(ep.number)} is not released yet.`);
  if (e.code === 'TOO_BIG') return say(`❌ *${show.title}* E${pad(ep.number)} is over the ${host.maxDownloadMB()} MB download cap.`);
  if (e.code === 'NOT_ENOUGH_DISK') return say(safeErrorMessage(e, { isOwner: Boolean(extra?.isOwner) }));
  return say(`❌ Could not get *${show.title}* ${show.isMovie ? '' : `episode ${nums}`}.`.trim());
}

async function offerChoices(sock, msg, extra, matches, job) {
  const labels = matches.map((m) => `${m.title} · ${m.kind}${m.episodes > 1 ? ` · ${m.episodes} eps` : ''}`);
  const header = `🎬 *${matches.length} results* for *${job.title}*`;
  const lines = labels.map((l, i) => `*${i + 1}.* ${l}`);
  await selections.sendPollOrText(sock, msg, extra, {
    pollName: `${header}\nTap a title:`,
    optionLabels: labels,
    fallbackText: `${header}\n\n${lines.join('\n')}\n\n_Reply ${config.prefix}1–${config.prefix}${matches.length}_`,
    selector: {
      headerTitle: `🎬 ${job.title}`,
      bodyText: `${matches.length} matches found — tap below to select:`,
      footerText: 'KissKh',
      buttonText: 'Select Title',
      sectionTitle: 'Matches',
      rows: matches.map((m, i) => ({
        title: `${i + 1}. ${m.title}`.slice(0, 24),
        description: [m.kind, m.episodes > 1 ? `${m.episodes} eps` : null].filter(Boolean).join(' · '),
      })),
    },
    items: matches,
    label: 'kisskh',
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, item) => start(sock2, msg2, extra2, item, job),
  });
}

module.exports = {
  worker: true, // runs in a download worker process (lib/workers)
  name: 'kk',
  timeoutMs: 3 * 60 * 60 * 1000,
  aliases: ['kisskh', 'asian'],
  category: 'media',
  description: 'Download dramas, movies and anime from KissKh',
  usage: '.kk <title> [e5 | e1-3]',

  async execute(sock, msg, args, extra) {
    const P = config.prefix;
    const job = parseArgs(args);
    if (!job.title) return extra.reply(help(P));
    try {
      const matches = await kisskh.search(job.title);
      if (!matches.length) return extra.reply(`❌ No results for *${job.title}* on KissKh.`);
      if (matches.length === 1) return start(sock, msg, extra, matches[0], job);
      return offerChoices(sock, msg, extra, matches, job);
    } catch (e) {
      log.error(`${job.title} · search · ${e.code || 'FAIL'} · ${e.message}`);
      if (e.code === 'KISSKH_DOWN') return extra.reply('❌ KissKh is blocking or not answering this server right now. Try again later.');
      return extra.reply(safeErrorMessage(e, { isOwner: Boolean(extra?.isOwner), fallback: '❌ KissKh search failed. Try again shortly.' }));
    }
  },

  _parseArgs: parseArgs,
};

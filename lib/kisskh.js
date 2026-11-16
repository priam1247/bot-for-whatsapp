/**
 * KissKh source (Asian dramas, movies, anime, Hollywood) — port of UDB's
 * KissKhClient. Search → details → per-episode stream link (+ subtitles).
 * No downloading here: commands/kisskh hands the stream to the movie engine.
 */
'use strict';

const crypto = require('crypto');
const vm = require('vm');

const BASE = String(process.env.KISSKH_BASE || 'https://kisskh.is/').replace(/\/?$/, '/');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;
const TYPES = { 1: 'Drama', 2: 'Movie', 3: 'Anime', 4: 'Hollywood' };

// Site constants used by the token generator (same values UDB ships with).
const GUID = { sub: 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp', video: '62f176f3bb1b5b8e70e39932ad34a0c7' };
const TOKEN_FN = '_0x54b991';
const SUB_KEYS = {
  txt: ['8056483646328763', '6852612370185273'],
  txt1: ['AmSmZVcH93UQUezi', 'ReBKWW8cqdjPEnF6'],
  other: ['sWODXX04QRTkHdlZ', '8pwhapJeC4hrS9hO'],
};

const fail = (message, code) => Object.assign(new Error(message), { code });

// UDB retries 429 and 5xx responses (its log shows four 429s before a search
// succeeded). Without this, one rate-limited catalog counted as an outage.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { json = false, referer = BASE } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*', referer },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return json ? res.json() : res.text();
    if (!RETRY_STATUS.has(res.status) || attempt >= MAX_RETRIES) throw fail(`kisskh ${res.status}`, 'KISSKH_HTTP');
    const asked = Number(res.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(asked) && asked > 0 ? asked * 1000 : 1500 * (attempt + 1), 8000));
  }
}

let tokenJs = null;
let tokenJsAt = 0;

async function tokenCode() {
  if (tokenJs && Date.now() - tokenJsAt < 30 * 60 * 1000) return tokenJs;
  const html = await request(`${BASE}index.html`);
  const src = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).find((s) => s.includes('common'));
  if (!src) throw fail('kisskh token script not found', 'KISSKH_TOKEN');
  tokenJs = await request(new URL(src, BASE).href);
  tokenJsAt = Date.now();
  return tokenJs;
}

/** kkey token the site requires for stream and subtitle requests. */
async function makeToken(episodeId, guid) {
  const code = await tokenCode();
  const call = `${TOKEN_FN}(${Number(episodeId)}, null, "2.8.10", "${guid}", 4830201, "kisskh", "kisskh", "kisskh", "kisskh", "kisskh", "kisskh")`;
  try {
    const token = vm.runInNewContext(`${code}\n${call}`, {}, { timeout: 5000 });
    if (!token || typeof token !== 'string') throw new Error('empty token');
    return token;
  } catch (e) {
    tokenJs = null;
    throw fail(`kisskh token failed: ${e.message}`, 'KISSKH_TOKEN');
  }
}

/** Search all four catalogs. @returns {Promise<Array<{id,title,kind,episodes}>>} */
async function search(query, { perType = 4 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  let failed = 0;
  let lastError = null;
  const groups = await Promise.all(Object.entries(TYPES).map(async ([code, kind]) => {
    try {
      const rows = await request(`${BASE}api/DramaList/Search?q=${q}&type=${code}`, { json: true });
      return (Array.isArray(rows) ? rows : []).slice(0, perType).map((r) => ({
        id: r.id, title: String(r.title || '').trim(), kind, episodes: Number(r.episodesCount) || null,
      }));
    } catch (e) { failed += 1; lastError = e; return []; }
  }));
  // Every catalog failing (e.g. a Cloudflare challenge) is an outage, not "no results".
  if (failed === Object.keys(TYPES).length) {
    throw fail(`KissKh unreachable (${lastError?.message || 'request failed'})`, 'KISSKH_DOWN');
  }
  return groups.flat().filter((r) => r.id && r.title);
}

/** @returns {Promise<{id,title,year,country,status,isMovie,episodes:Array<{id,number,subs}>}>} */
async function details(id) {
  const d = await request(`${BASE}api/DramaList/Drama/${Number(id)}`, { json: true });
  const eps = (d.episodes || [])
    .map((e) => ({ id: e.id, number: Number(e.number), subs: Number(e.sub) || 0 }))
    .filter((e) => e.id && Number.isFinite(e.number))
    .sort((a, b) => a.number - b.number);
  return {
    id: d.id ?? id,
    title: String(d.title || '').trim(),
    year: String(d.releaseDate || '').split('-')[0] || '',
    country: d.country || '',
    status: d.status || '',
    isMovie: String(d.type || '').toLowerCase() === 'movie',
    episodes: eps,
  };
}

/** Direct stream for one episode. @returns {Promise<{url, kind:'hls'|'http', headers}>} */
async function stream(episodeId) {
  const token = await makeToken(episodeId, GUID.video);
  const data = await request(`${BASE}api/DramaList/Episode/${Number(episodeId)}.png?kkey=${token}`, { json: true });
  const url = data?.Video;
  if (!url) throw fail('no stream link', 'KISSKH_NO_STREAM');
  if (url.includes('tickcounter.com')) throw fail('episode not released yet', 'KISSKH_UPCOMING');
  const isHls = url.split('?')[0].endsWith('.m3u8');
  if (!isHls && !/\.mp4(\?|$)/i.test(url)) throw fail('unsupported stream type', 'KISSKH_UNSUPPORTED');
  return { url, kind: isHls ? 'hls' : 'http', headers: { referer: BASE, origin: BASE.replace(/\/$/, ''), 'user-agent': UA } };
}

function decryptLine(text, [key, iv]) {
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([d.update(Buffer.from(text, 'base64')), d.final()]).toString('utf8').trim();
}

/** Decrypt a KissKh subtitle (SRT whose text lines are AES-encrypted). */
function decryptSubtitle(raw, ext) {
  const pair = ext === 'srt' ? null : (SUB_KEYS[ext] || SUB_KEYS.other);
  if (!pair) return raw;
  return raw.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t || /^\d+$/.test(t) || t.includes('-->')) return line;
    try { return decryptLine(t, pair); } catch { return line; }
  }).join('\n');
}

/** Subtitle in the wanted language, decrypted. @returns {Promise<{text,language}|null>} */
async function subtitle(episodeId, lang = 'english') {
  const token = await makeToken(episodeId, GUID.sub);
  const list = await request(`${BASE}api/Sub/${Number(episodeId)}?kkey=${token}`, { json: true });
  const want = String(lang).toLowerCase();
  const pick = (Array.isArray(list) ? list : []).find((s) => String(s.label || '').toLowerCase().includes(want)) || null;
  if (!pick?.src) return null;
  const ext = pick.src.split('?')[0].split('.').pop().toLowerCase();
  const text = decryptSubtitle(await request(pick.src), ext);
  return text.trim() ? { text, language: String(pick.label || lang).toLowerCase().slice(0, 2) } : null;
}

module.exports = { BASE, TYPES, search, details, stream, subtitle, _decryptSubtitle: decryptSubtitle };

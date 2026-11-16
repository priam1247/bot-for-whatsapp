'use strict';

/**
 * DramaBox resolver.
 *
 * Why the old version stopped working: it called
 * `apiskeith2-production-ec66.up.railway.app/dramabox/stream`, and that
 * Railway app was deleted (every request answers 404 "Application not
 * found"). The other Keith mirrors are disabled too, and DramaBox's own API
 * blocks server IPs.
 *
 * Current source: the public Sansekai DramaBox API
 *   GET /search?query=…           → [{ bookId, bookName, introduction, cover, … }]
 *   GET /details?bookId=…         → { bookName, chapterCount, introduction, … }
 *   GET /get-allepisodes?bookId=… → [{ chapterIndex, chapterName, cdnList:[{ isDefault, videoPathList:[{ quality, videoPath }] }] }]
 *   GET /decrypt-videos?url=…     → the playable MP4 (DramaBox ships `*.encrypt.mp4` files)
 *
 * The API allows ~5 requests a minute per IP, so episode lists are cached and
 * a 429 is waited out once (Retry-After) instead of failing straight away.
 * DRAMABOX_API_BASE can point at a compatible mirror.
 */
const axios = require('axios');
const { safeUrl } = require('../../lib/publicMediaDownload');

const API_BASE = String(process.env.DRAMABOX_API_BASE || 'https://api.sansekai.my.id/api/dramabox').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // an 100-episode list is ~1 MB
const CACHE_TTL_MS = 20 * 60 * 1000;         // signed CDN links stay valid for hours
const CACHE_MAX = 30;
const QUALITY_ORDER = [720, 540, 1080, 360, 480, 144];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const defaultHttp = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  maxRedirects: 2,
  maxContentLength: MAX_RESPONSE_BYTES,
  headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

function cleanText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function publicHttpsUrl(value) {
  try { return safeUrl(value).href; } catch { return null; }
}

function validateBookId(bookId) {
  const id = String(bookId || '').trim();
  if (!/^\d{5,20}$/.test(id)) throw fail('BAD_INPUT', 'invalid DramaBox book ID');
  return id;
}

function validateEpisode(episode = 1) {
  const text = String(episode ?? 1).trim().replace(/^ep(?:isode)?/i, '');
  if (!/^\d{1,4}$/.test(text)) throw fail('BAD_INPUT', 'invalid DramaBox episode');
  const ep = Number(text);
  if (!Number.isSafeInteger(ep) || ep < 1 || ep > 9999) throw fail('BAD_INPUT', 'invalid DramaBox episode');
  return ep;
}

function validateRequest(bookId, episode = 1) {
  return { bookId: validateBookId(bookId), episode: validateEpisode(episode) };
}

/** Is this a numeric DramaBox book ID (vs. a title to search for)? */
const looksLikeBookId = (value) => /^\d{5,20}$/.test(String(value || '').trim());

function pickVideo(chapter, preferred = QUALITY_ORDER) {
  const cdns = Array.isArray(chapter?.cdnList) ? [...chapter.cdnList] : [];
  // Default CDN first: its links carry the token in the path and do not expire quickly.
  cdns.sort((a, b) => Number(b?.isDefault || 0) - Number(a?.isDefault || 0));
  for (const quality of preferred) {
    for (const cdn of cdns) {
      const match = (cdn?.videoPathList || []).find((v) => Number(v?.quality) === quality && typeof v?.videoPath === 'string');
      const url = match && publicHttpsUrl(match.videoPath);
      if (url) return { url, quality };
    }
  }
  for (const cdn of cdns) {
    for (const v of cdn?.videoPathList || []) {
      const url = typeof v?.videoPath === 'string' && publicHttpsUrl(v.videoPath);
      if (url) return { url, quality: Number(v.quality) || 0 };
    }
  }
  return null;
}

function createDramaBox({
  http = defaultHttp,
  apiBase = API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  wait = sleep,
  now = () => Date.now(),
} = {}) {
  const base = String(apiBase || API_BASE).replace(/\/+$/, '');
  const timeout = Math.max(1000, Math.min(180000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const episodeCache = new Map(); // bookId -> { at, episodes }
  const inflight = new Map();

  async function get(path, params) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await http.get(`${base}${path}`, {
          params, timeout, maxRedirects: 2, maxContentLength: MAX_RESPONSE_BYTES,
          headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
          validateStatus: () => true,
        });
      } catch (error) {
        throw fail('PROVIDER_FAILED', 'DramaBox service request failed', { serviceDown: true, cause: error });
      }
      const status = Number(response?.status || 200);
      if (status === 429) {
        const retry = Number(response?.headers?.['retry-after'] || response?.headers?.['ratelimit-reset']);
        const delay = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 65) * 1000 : 0;
        if (attempt === 0 && delay) { await wait(delay); continue; }
        throw fail('RATE_LIMITED', 'DramaBox service is rate limiting', { rateLimited: true });
      }
      if (status >= 500 || status === 404 && /application not found|cannot get/i.test(JSON.stringify(response?.data || ''))) {
        throw fail(`HTTP_${status}`, 'DramaBox service is unavailable', { serviceDown: true });
      }
      if (status >= 400) throw fail(`HTTP_${status}`, 'DramaBox service rejected the request');
      return response?.data;
    }
    throw fail('RATE_LIMITED', 'DramaBox service is rate limiting', { rateLimited: true });
  }

  async function search(query, limit = 8) {
    const q = cleanText(query, 100);
    if (!q) throw fail('BAD_INPUT', 'empty DramaBox search');
    const data = await get('/search', { query: q });
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return list
      .filter((item) => looksLikeBookId(item?.bookId))
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map((item) => ({
        bookId: String(item.bookId),
        title: cleanText(item.bookName, 120) || `Drama ${item.bookId}`,
        intro: cleanText(item.introduction, 200),
        episodes: Number(item.chapterCount) || null,
        cover: publicHttpsUrl(item.cover || item.coverWap) || null,
      }));
  }

  async function details(bookId) {
    const id = validateBookId(bookId);
    const data = await get('/details', { bookId: id });
    const d = data?.data && typeof data.data === 'object' ? data.data : data;
    if (!d || typeof d !== 'object' || !d.bookId) throw fail('NOT_FOUND', 'DramaBox title not found');
    return {
      bookId: String(d.bookId),
      title: cleanText(d.bookName, 160),
      intro: cleanText(d.introduction, 400),
      episodes: Number(d.chapterCount) || null,
      cover: publicHttpsUrl(d.coverWap || d.cover) || null,
    };
  }

  async function episodes(bookId) {
    const id = validateBookId(bookId);
    const cached = episodeCache.get(id);
    if (cached && now() - cached.at < CACHE_TTL_MS) return cached.episodes;
    if (inflight.has(id)) return inflight.get(id);
    const job = (async () => {
      const data = await get('/get-allepisodes', { bookId: id });
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
      if (!list || !list.length) throw fail('NOT_FOUND', 'DramaBox returned no episodes');
      const mapped = list
        .filter((ch) => ch && Array.isArray(ch.cdnList))
        .map((ch, i) => ({
          index: Number.isInteger(ch.chapterIndex) ? ch.chapterIndex : i,
          name: cleanText(ch.chapterName, 60) || `Episode ${i + 1}`,
          chapter: ch,
        }))
        .sort((a, b) => a.index - b.index);
      if (!mapped.length) throw fail('NOT_FOUND', 'DramaBox returned no playable episodes');
      episodeCache.set(id, { at: now(), episodes: mapped });
      while (episodeCache.size > CACHE_MAX) episodeCache.delete(episodeCache.keys().next().value);
      return mapped;
    })();
    inflight.set(id, job);
    try { return await job; } finally { inflight.delete(id); }
  }

  /** Resolve one episode to a downloadable (decrypted) MP4 link. */
  async function getDramaBoxStream(bookId, episode = 1) {
    const params = validateRequest(bookId, episode);
    const list = await episodes(params.bookId);
    const entry = list[params.episode - 1];
    if (!entry) throw fail('NO_EPISODE', `this drama has ${list.length} episodes`, { total: list.length });
    const video = pickVideo(entry.chapter);
    if (!video) throw fail('NO_STREAM', 'DramaBox returned no stream link');
    const encrypted = /\.encrypt\./i.test(new URL(video.url).pathname);
    const url = encrypted ? `${base}/decrypt-videos?url=${encodeURIComponent(video.url)}` : video.url;
    if (!publicHttpsUrl(url)) throw fail('UNSAFE_URL', 'DramaBox returned an unsafe stream URL');
    return {
      bookId: params.bookId,
      episode: params.episode,
      total: list.length,
      name: entry.name,
      quality: video.quality ? `${video.quality}p` : '',
      url,
      sourceUrl: video.url,
    };
  }

  return { search, details, episodes, getDramaBoxStream, _cache: episodeCache };
}

module.exports = {
  ...createDramaBox(),
  createDramaBox,
  validateRequest,
  validateBookId,
  validateEpisode,
  looksLikeBookId,
  pickVideo,
  constants: { API_BASE, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, QUALITY_ORDER },
};

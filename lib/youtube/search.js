/**
 * ZaFar Bot — YouTube search
 *
 * Used by .spotify and local media search flows. The XJX-style .song/.video
 * commands use yt-search's first hit directly, matching their reference.
 *
 * Returns a list for the commands that offer numbered results.
 */

const config = require('../../config');
const { extractYouTubeId, canonicalYouTubeUrl } = require('../downloads/xjx');

const DEFAULT_LIMIT = 5;
// Cache search metadata briefly, never media files or provider download URLs.
const searchCache = new Map();
const SEARCH_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 100;

function remember(query, rows) {
  if (!rows.length) return;
  if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(query.toLowerCase(), { at: Date.now(), rows: rows.map((row) => ({ ...row })) });
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally { clearTimeout(timer); }
}

const clean = (s) => String(s || '').trim();

const toResult = ({ url, id, title, author, duration, thumbnail }) => ({
  url: url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
  id: id || extractYouTubeId(url || '') || '',
  title: clean(title) || 'Unknown title',
  author: clean(author),
  duration: Number(duration) || 0,
  thumbnail: clean(thumbnail) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
});

async function viaYtSearch(query, limit) {
  try {
    const yts = require('yt-search'); // lazy: scraping library, only needed here
    const found = await yts(query);
    const videos = (found && found.videos) || [];
    return videos.slice(0, limit).map(v => toResult({
      url: v.url,
      id: v.videoId || extractYouTubeId(v.url || ''),
      title: v.title,
      author: v.author?.name,
      duration: v.seconds,
      thumbnail: v.thumbnail,
    })).filter(r => r.url);
  } catch (e) {
    console.warn('[search] yt-search failed:', e.message);
    return [];
  }
}

/**
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array<{url:string,id:string,title:string,author:string,duration:number,thumbnail:string}>>}
 */
async function searchYouTube(query, { limit = DEFAULT_LIMIT } = {}) {
  const q = clean(query);
  if (!q) return [];

  // A link is not a search
  const linkUrl = canonicalYouTubeUrl(q);
  if (linkUrl) return [toResult({ url: linkUrl, id: extractYouTubeId(q) })];

  const cached = searchCache.get(q.toLowerCase());
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS && cached.rows.length >= limit) {
    return cached.rows.slice(0, limit).map((row) => ({ ...row }));
  }
  if (cached && Date.now() - cached.at >= SEARCH_TTL_MS) searchCache.delete(q.toLowerCase());

  const rows = await withTimeout(viaYtSearch(q, Math.max(limit, 5)), 8000, []);
  remember(q, rows);
  return rows.slice(0, limit);
}

/** "1. Title — artist (3:32)" list for the picker message. */

module.exports = { searchYouTube, DEFAULT_LIMIT };

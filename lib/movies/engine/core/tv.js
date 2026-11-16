// src/core/tv.js — episode/season text handling: input parsing, query building
// and the "pick the right file inside a pack" logic. Clean rewrite of 2.0's
// parse.js + the tangled season-parsing mess in its series.js (lines 91-94).
import { parseRelease, matchesEpisode } from './release.js';

const Q = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const pad2 = (n) => String(n).padStart(2, '0');

const RX = [
  /\bs(\d{1,2})[\s._-]?e(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/,
  /\bseason[ ._-]?(\d{1,2})[ ._-]?ep(?:isode)?[ ._-]?(\d{1,3})\b/i
];




// structured parse of a user series request — replaces 2.0's line-noise

// query strings indexers want — per-episode by default
export function episodeQuery(title, year, season, episode) {
  return Q(`${title} ${year || ''} S${pad2(season)}E${pad2(episode)}`);
}

export function seasonQuery(title, year, season) {
  return Q(`${title} ${year || ''} S${pad2(season)}`);
}

// Read explicit labels even when an underscore (a regex word character)
// separates the title and SxxExx. A range may contain the requested episode.
export function episodeFileLabel(name) {
  const text = String(name || '');
  const sane = (m) => {
    if (!m) return null;
    const first = Number(m[2]);
    let last = Number(m[3] || m[2]);
    if (last < first || last - first > 50) last = first;
    return { season: Number(m[1]), first, last };
  };
  // Require a second E in SxxExx ranges; bare numbers can be resolutions.
  const sxe = /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?:[\s._]*-?[\s._]*e(\d{1,3})(?![0-9pik]))?(?:[^0-9]|$)/i.exec(text);
  if (sxe) return sane(sxe);
  // NxMM ranges need an explicit dash or X; reject resolution suffixes.
  const alt = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:[\s._]*(?:x|-[\s._]*x?)(\d{1,3})(?![0-9pik]))?(?:[^0-9]|$)/i.exec(text);
  return sane(alt);
}

// From a debrid pack, never choose a known different episode or an arbitrary
// position in an ambiguously named pack.
export function pickEpisodeFile(files, season, episode) {
  const vids = (files || [])
    .filter(f => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(f.path || ''))
    .filter(f => !/sample|trailer|extras|behind/i.test(f.path || ''));
  if (!vids.length) return null;
  const labelled = vids.map(file => ({ file, label: episodeFileLabel(file.path) }));
  const matching = labelled.find(({ label }) => label && label.season === Number(season)
    && Number(episode) >= label.first && Number(episode) <= label.last);
  if (matching) return matching.file;
  if (labelled.some(({ label }) => label)) return null;

  // Anime packs sometimes use absolute numbers rather than SxxExx.
  if (Number(season) === 1) {
    const abs = vids.filter(f => new RegExp(`(?:^|\\D)0*${Number(episode)}(?:\\D|$)`).test(f.path));
    if (abs.length === 1) return abs[0];
  }
  return vids.length === 1 ? vids[0] : null;
}

export { parseRelease, matchesEpisode };

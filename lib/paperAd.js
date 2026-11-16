/**
 * StudyMW advert for .paper (groups only).
 * Every 2nd .paper in a group → after it finishes, send ONE advert image.
 * Images rotate in fixed order, per group. State is saved so restarts keep it.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { readJsonSafe, writeJsonAtomic } = require('./jsonStore');

const SITE = 'https://studymw.netlibrary.dpdns.org';
const EVERY = 2;
const STATE_FILE = path.join(__dirname, '../database/paper_ad.json');
const DIR = path.join(__dirname, '../assets/ads');

const body =
  `Secondary & Primary resources — create a free account and download!\n\n` +
  `👉 ${SITE}`;

const ADS = [
  { file: '1-books.png',        head: '📚 *FREE Books for everyone!*' },
  { file: '2-past-papers.png',  head: '📝 *FREE Past Papers!*' },
  { file: '3-notes.png',        head: '🗒️ *FREE Notes!*' },
  { file: '4-marking-keys.png', head: '🔑 *FREE Marking Keys!*' },
];

let _state = null; // { [groupJid]: { n: requestCount, i: nextImageIndex } }

function load() {
  if (_state) return _state;
  const s = readJsonSafe(STATE_FILE, { defaultValue: {} });
  _state = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  return _state;
}

function save() {
  try { writeJsonAtomic(STATE_FILE, _state); } catch (_) { /* never break .paper */ }
}

const isGroup = (jid) => String(jid || '').endsWith('@g.us');

// Call once per .paper. Returns true when an advert is due for this request.
function tick(jid) {
  if (!isGroup(jid)) return false;
  const st = load();
  const g = st[jid] || (st[jid] = { n: 0, i: 0 });
  g.n += 1;
  save();
  return g.n % EVERY === 0;
}

// Send the next advert image to the group (never throws).
async function send(sock, jid) {
  try {
    const g = load()[jid] || { n: 0, i: 0 };
    const ad = ADS[g.i % ADS.length];
    const file = path.join(DIR, ad.file);
    if (!fs.existsSync(file)) return;
    await sock.sendMessage(jid, { image: { url: file }, caption: `${ad.head}\n\n${body}` });
    g.i = (g.i + 1) % ADS.length;
    load()[jid] = g;
    save();
  } catch (e) {
    console.warn('[paperAd] send failed:', e.message);
  }
}

module.exports = { tick, send, ADS, EVERY };

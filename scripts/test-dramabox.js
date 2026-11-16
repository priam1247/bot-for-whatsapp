#!/usr/bin/env node
'use strict';

// Offline coverage for .dramabox: source parsing, episode selection,
// rate-limit handling and command delivery. The DramaBox API, the media
// download and the WhatsApp socket are mocked; no network calls are made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dramabox-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
process.env.PREFIX = '.';

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const dramabox = require(path.join(ROOT, 'commands/dramabox/source'));
const BASE = dramabox.constants.API_BASE;

const chapter = (i, extra = {}) => ({
  chapterId: String(700 + i), chapterIndex: i, chapterName: `Episode ${i + 1}`,
  cdnList: [
    { cdnDomain: 'b.example.org', isDefault: 0, videoPathList: [{ quality: 720, videoPath: `https://b.example.org/${i}.720p.encrypt.mp4?x=1` }] },
    { cdnDomain: 'a.example.org', isDefault: 1, videoPathList: [
      { quality: 1080, videoPath: `https://a.example.org/${i}.1080p.encrypt.mp4?x=1` },
      { quality: 720, videoPath: `https://a.example.org/${i}.720p.encrypt.mp4?x=1` },
      { quality: 144, videoPath: `https://a.example.org/${i}.144p.mp4` },
    ] },
  ],
  ...extra,
});

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    http: {
      async get(url, options) {
        calls.push({ url, params: options.params });
        const route = url.slice(BASE.length);
        const handler = routes[route];
        if (!handler) return { status: 404, data: 'Cannot GET' };
        return handler(options.params, calls.length);
      },
    },
  };
}

test('resolves an episode from the episode list, preferring 720p on the default CDN, via the decrypt proxy', async () => {
  const { http, calls } = fakeHttp({
    '/get-allepisodes': (params) => {
      assert.deepEqual(params, { bookId: '42000028805' });
      return { status: 200, data: [chapter(1), chapter(0), chapter(2)] };
    },
  });
  const client = dramabox.createDramaBox({ http });
  const result = await client.getDramaBoxStream('42000028805', 2);
  assert.equal(result.episode, 2);
  assert.equal(result.total, 3);
  assert.equal(result.quality, '720p');
  assert.equal(result.sourceUrl, 'https://a.example.org/1.720p.encrypt.mp4?x=1');
  assert.equal(result.url, `${BASE}/decrypt-videos?url=${encodeURIComponent('https://a.example.org/1.720p.encrypt.mp4?x=1')}`);
  // The episode list is cached: a second episode costs no extra request.
  await client.getDramaBoxStream('42000028805', 3);
  assert.equal(calls.length, 1);
});

test('unencrypted links are used directly and missing episodes report the total', async () => {
  const plain = chapter(0);
  plain.cdnList = [{ isDefault: 1, videoPathList: [{ quality: 540, videoPath: 'https://a.example.org/0.540p.mp4' }] }];
  const { http } = fakeHttp({ '/get-allepisodes': () => ({ status: 200, data: [plain] }) });
  const client = dramabox.createDramaBox({ http });
  assert.equal((await client.getDramaBoxStream('42000028805', 1)).url, 'https://a.example.org/0.540p.mp4');
  await assert.rejects(client.getDramaBoxStream('42000028805', 5), (e) => e.code === 'NO_EPISODE' && e.total === 1);
});

test('rejects invalid IDs/episodes and never returns unsafe (non-public, non-https) links', async () => {
  const unsafe = chapter(0);
  unsafe.cdnList = [{ isDefault: 1, videoPathList: [{ quality: 720, videoPath: 'http://127.0.0.1/private.mp4' }] }];
  let requests = 0;
  const client = dramabox.createDramaBox({ http: { async get() { requests++; return { status: 200, data: [unsafe] }; } } });
  await assert.rejects(client.getDramaBoxStream('../private'), { code: 'BAD_INPUT' });
  await assert.rejects(client.getDramaBoxStream('42000028805', 0), { code: 'BAD_INPUT' });
  await assert.rejects(client.getDramaBoxStream('42000028805', 'x'), { code: 'BAD_INPUT' });
  assert.equal(requests, 0);
  await assert.rejects(client.getDramaBoxStream('42000028805', 1), { code: 'NO_STREAM' });
});

test('waits out one 429 (Retry-After) and maps outages to serviceDown', async () => {
  const waits = [];
  let n = 0;
  const client = dramabox.createDramaBox({
    wait: async (ms) => { waits.push(ms); },
    http: { async get() { n++; return n === 1 ? { status: 429, headers: { 'retry-after': '3' }, data: {} } : { status: 200, data: [chapter(0)] }; } },
  });
  assert.equal((await client.getDramaBoxStream('42000028805', 1)).episode, 1);
  assert.deepEqual(waits, [3000]);

  const limited = dramabox.createDramaBox({ wait: async () => {}, http: { async get() { return { status: 429, headers: {}, data: {} }; } } });
  await assert.rejects(limited.getDramaBoxStream('42000028805'), (e) => e.rateLimited === true);

  const down = dramabox.createDramaBox({ http: { async get() { return { status: 503, data: 'x' }; } } });
  await assert.rejects(down.getDramaBoxStream('42000028805'), (e) => e.serviceDown === true && e.code === 'HTTP_503');
});

test('search returns clean results with book IDs', async () => {
  const { http } = fakeHttp({
    '/search': (params) => {
      assert.deepEqual(params, { query: 'love ruse' });
      return { status: 200, data: [
        { bookId: '42000028805', bookName: 'Love Ruse', introduction: 'x', chapterCount: 60, cover: 'https://img.example.org/a.jpg' },
        { bookId: 'bad', bookName: 'Ignored' },
      ] };
    },
  });
  const results = await dramabox.createDramaBox({ http }).search('love ruse');
  assert.deepEqual(results.map((r) => [r.bookId, r.title, r.episodes]), [['42000028805', 'Love Ruse', 60]]);
});

test('.dramabox parses titles, IDs and episode numbers', () => {
  const command = require(path.join(ROOT, 'commands/dramabox/index'));
  assert.deepEqual(command._parseArgs(['42000028805']), { query: '42000028805', episode: 1, bookId: '42000028805' });
  assert.deepEqual(command._parseArgs(['42000028805', '7']), { query: '42000028805', episode: 7, bookId: '42000028805' });
  assert.deepEqual(command._parseArgs(['love', 'ruse', 'ep3']), { query: 'love ruse', episode: 3, bookId: null });
  assert.deepEqual(command._parseArgs(['love', 'ruse']), { query: 'love ruse', episode: 1, bookId: null });
  assert.equal(command._parseArgs([]), null);
});

test('.dramabox is registered, runs in a worker, downloads to disk and sends the episode as a file video', async () => {
  const commands = require(path.join(ROOT, 'gateway/registry')).loadCommands();
  const command = commands.get('dramabox');
  assert.ok(command);
  assert.equal(commands.get('drama'), command);
  assert.equal(command.worker, true);

  const menu = require(path.join(ROOT, 'commands/menu/index'));
  const card = menu._buildCard(menu._buildGroups('.', { isOwner: false }));
  assert.match(card, /\.dramabox <title\|bookId> \[episode\]/);

  const download = require(path.join(ROOT, 'lib/publicMediaDownload'));
  const originalDownload = download.downloadPublicFile;
  const originalStream = dramabox.getDramaBoxStream;
  const originalDetails = dramabox.details;
  const sent = [];
  let downloaded = null;
  dramabox.getDramaBoxStream = async (bookId, episode) => ({ bookId, episode, total: 60, quality: '720p', url: 'https://cdn.example.org/ep.mp4', name: 'Episode 3' });
  dramabox.details = async () => ({ title: 'Love Ruse' });
  download.downloadPublicFile = async (url, dest) => { downloaded = { url, dest }; fs.writeFileSync(dest, Buffer.alloc(20000)); return { file: dest, bytes: 20000 }; };
  // Re-require the command so it picks up the patched download helper.
  delete require.cache[require.resolve(path.join(ROOT, 'commands/dramabox/index'))];
  const fresh = require(path.join(ROOT, 'commands/dramabox/index'));
  const sock = { async sendMessage(_chat, body) { if (body.video) body.existed = fs.existsSync(body.video.url); sent.push(body); return { key: { id: 'x' } }; } };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'fixture' } };
  const extra = { from: msg.key.remoteJid, reply: async (text) => { sent.push({ text }); } };
  try {
    await fresh.execute(sock, msg, ['42000028805', '3'], extra);
  } finally {
    dramabox.getDramaBoxStream = originalStream;
    dramabox.details = originalDetails;
    download.downloadPublicFile = originalDownload;
  }
  assert.equal(downloaded.url, 'https://cdn.example.org/ep.mp4');
  const video = sent.find((body) => body.video);
  assert.ok(video, 'episode sent as a video');
  assert.equal(typeof video.video.url, 'string', 'sent from a file path, not a memory buffer');
  assert.equal(video.existed, true);
  assert.match(video.caption, /Love Ruse/);
  assert.match(video.caption, /Episode 3\/60/);
  assert.match(video.caption, /\.dramabox 42000028805 4/);
  assert.equal(fs.existsSync(downloaded.dest), false, 'temp file removed after sending');
});

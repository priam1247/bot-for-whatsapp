#!/usr/bin/env node
'use strict';

// Offline tests for lib/downloads/stage.js — the download → send → delete
// lifecycle shared by .song, .video, .tiktok, .fb and .instagram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);

const { withStagedMedia } = require(path.join(ROOT, 'lib/downloads/stage'));
const diskSpace = require(path.join(ROOT, 'lib/diskSpace'));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const tempFiles = () => {
  const dir = path.join(TMP, 'temp');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const writer = (log, bytes = 20000) => async (url, dest) => {
  log.push(url);
  fs.writeFileSync(dest, Buffer.alloc(bytes, 7));
  return { file: dest, bytes };
};

test('the file exists while sending and is deleted once the send has finished', async () => {
  const fetched = [];
  let during = null;
  let path_ = '';
  const result = await withStagedMedia('https://cdn.example.com/a.mp4', { kind: 'video', fetchFile: writer(fetched) }, async (staged) => {
    path_ = staged.file;
    await new Promise((resolve) => setTimeout(resolve, 20)); // the "upload"
    during = fs.existsSync(staged.file) && fs.statSync(staged.file).size === staged.bytes;
    return 'sent';
  });
  assert.equal(result, 'sent');
  assert.equal(during, true);
  assert.deepEqual(fetched, ['https://cdn.example.com/a.mp4']);
  assert.equal(fs.existsSync(path_), false);
  assert.deepEqual(tempFiles(), []);
});

test('a failed send still deletes the file and passes the error through', async () => {
  let file = '';
  await assert.rejects(
    withStagedMedia('https://cdn.example.com/a.mp3', { kind: 'audio', fetchFile: writer([]) }, async (staged) => {
      file = staged.file;
      throw new Error('upload failed');
    }),
    /upload failed/,
  );
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(tempFiles(), []);
});

test('falls back to the next URL, but never retries a file that is too big', async () => {
  const tried = [];
  const flaky = async (url, dest) => {
    tried.push(url);
    if (url.includes('bad')) throw Object.assign(new Error('x'), { code: 'MEDIA_NETWORK' });
    fs.writeFileSync(dest, Buffer.alloc(20000, 1));
    return { file: dest, bytes: 20000 };
  };
  await withStagedMedia(['https://a.example.com/bad', 'https://b.example.com/good'], { fetchFile: flaky }, async (s) => assert.equal(s.url, 'https://b.example.com/good'));
  assert.deepEqual(tried, ['https://a.example.com/bad', 'https://b.example.com/good']);

  const big = [];
  await assert.rejects(
    withStagedMedia(['https://a.example.com/1', 'https://b.example.com/2'], {
      kind: 'audio', maxMB: 5,
      fetchFile: async (url) => { big.push(url); throw Object.assign(new Error('x'), { code: 'TOO_BIG' }); },
    }, async () => assert.fail('must not send')),
    (e) => e.code === 'TOO_BIG' && /larger than the 5 MB/.test(e.userMessage),
  );
  assert.deepEqual(big, ['https://a.example.com/1']);
  assert.deepEqual(tempFiles(), []);
});

test('download failures become a safe chat message and nothing is sent', async () => {
  await assert.rejects(
    withStagedMedia('https://a.example.com/x', {
      fetchFile: async () => { throw Object.assign(new Error('connect ECONNRESET 10.0.0.1:443'), { code: 'MEDIA_NETWORK' }); },
    }, async () => assert.fail('must not send')),
    (e) => e.code === 'DOWNLOAD_FAILED' && !/10\.0\.0\.1|ECONNRESET/.test(e.userMessage),
  );
  assert.deepEqual(tempFiles(), []);
});

test('files use cleanup-recognised names and the disk reservation is always released', async () => {
  const before = diskSpace.reservedMB();
  let name = '';
  let reservedDuring = 0;
  await withStagedMedia('https://a.example.com/x', { kind: 'video', fetchFile: writer([]) }, async (staged) => {
    name = path.basename(staged.file);
    reservedDuring = diskSpace.reservedMB();
  });
  assert.match(name, /^ytv_\d{10,}_[a-z0-9]+\.mp4$/);
  assert.ok(reservedDuring > before, 'space is reserved while the file is on disk');
  assert.equal(diskSpace.reservedMB(), before);

  await assert.rejects(withStagedMedia('https://a.example.com/x', { fetchFile: writer([]) }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(diskSpace.reservedMB(), before);
});

test('real downloader refuses private and non-HTTPS links before touching the network', async () => {
  for (const url of ['http://cdn.example.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://localhost/a.mp4']) {
    await assert.rejects(
      withStagedMedia(url, { kind: 'video' }, async () => assert.fail('must not send')),
      (e) => e.code === 'DOWNLOAD_FAILED',
    );
  }
  assert.deepEqual(tempFiles(), []);
});

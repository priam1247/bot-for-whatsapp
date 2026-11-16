'use strict';

/**
 * Stage → send → delete, the same lifecycle .movie and .kk use.
 *
 *   1. reserve disk space for the job
 *   2. download the finished file from the provider to ./temp (streamed, size-capped)
 *   3. hand the LOCAL file to the sender (WhatsApp upload)
 *   4. delete the file — after the send has completely finished, success or not
 *
 * Used by .song, .video, .tiktok, .fb, .instagram (and .mfind via xjx.js).
 * Nothing is cached: when the callback returns (or throws) the file is gone.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const tempManager = require('../tempManager');
const diskSpace = require('../diskSpace');
const { downloadPublicFile } = require('../publicMediaDownload');

const MB = 1024 * 1024;

// prefix: recognised by lib/cleanup.js, so a crash can never strand the file
// for long (boot sweep + age sweep both pick these names up).
const KINDS = {
  audio: { prefix: 'song', ext: 'mp3', mime: 'audio/mpeg', reserveMB: 40, timeoutMs: 5 * 60 * 1000, maxMB: () => Number(config.song?.maxMB) || 2000 },
  video: { prefix: 'ytv', ext: 'mp4', mime: 'video/mp4', reserveMB: 250, timeoutMs: 20 * 60 * 1000, maxMB: () => Number(config.video?.maxMB) || 2000 },
  image: { prefix: 'dl', ext: 'jpg', mime: 'image/jpeg', reserveMB: 20, timeoutMs: 2 * 60 * 1000, maxMB: () => 2000 },
};

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Provider failures → short, safe chat text (never paths, hosts or status dumps). */
function stageError(error, maxMB) {
  const code = String(error?.code || '');
  if (error?.userMessage) return error;
  if (code === 'NOT_ENOUGH_DISK') {
    return Object.assign(error, { userMessage: 'Server storage is temporarily full. Please try again in a few minutes.' });
  }
  if (code === 'TOO_BIG') {
    return fail('TOO_BIG', 'Media exceeds the size limit', { userMessage: `That file is larger than the ${maxMB} MB limit.`, cause: error });
  }
  if (code === 'MEDIA_UNAVAILABLE') {
    return fail('MEDIA_UNAVAILABLE', 'Media is unavailable', { userMessage: 'The download link expired or is not available. Please try again.', cause: error });
  }
  if (code === 'MEDIA_RATE_LIMIT') {
    return fail('MEDIA_RATE_LIMIT', 'Media source is rate limiting', { userMessage: 'The media source is busy. Please try again in a minute.', cause: error });
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return fail('NOT_ENOUGH_DISK', 'Disk is full', { userMessage: 'Server storage is temporarily full. Please try again in a few minutes.', cause: error });
  }
  return fail('DOWNLOAD_FAILED', 'Media download failed', { userMessage: 'Could not download that file from the source. Please try again later.', cause: error });
}

/** Real container from the file header (never trust the URL); defaults when unknown. */
function sniffFile(file, spec) {
  try {
    const sniffed = require('../mediaTransfer').sniffFile(file);
    if (sniffed && sniffed.kind !== 'unknown') return sniffed;
  } catch { /* sniffing is best effort */ }
  return { kind: 'unknown', ext: spec.ext, mime: spec.mime };
}

function removeFile(file) {
  try { tempManager.deleteTempFile(file); } catch { /* best effort */ }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

/**
 * Download the first working URL in `urls` to disk, run `send(staged)`, then delete.
 *
 * `staged` = { file, bytes, ext, mime, kind, url }  (ext/mime come from the file header)
 * The return value of `send` is returned. The file is deleted in `finally`, so a
 * failed or refused send also leaves nothing behind.
 *
 * @param {string|string[]} urls
 * @param {{kind?:'audio'|'video'|'image', label?:string, maxMB?:number, reserveMB?:number,
 *          timeoutMs?:number, fetchFile?:Function}} options
 * @param {(staged:object)=>Promise<any>} send
 */
async function withStagedMedia(urls, options = {}, send) {
  const spec = KINDS[options.kind] || KINDS.video;
  const maxMB = Number(options.maxMB) || spec.maxMB();
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter((u) => typeof u === 'string' && u))];
  if (!list.length) throw fail('NO_MEDIA', 'no media URL to download');
  const fetchFile = options.fetchFile || downloadPublicFile;

  const dest = tempManager.createTempFilePath(spec.prefix, spec.ext);
  const releaseHold = tempManager.holdTemp(path.basename(dest));
  let reservation = null;
  try {
    reservation = diskSpace.reserveSpace(tempManager.getTempDir(), Number(options.reserveMB) || spec.reserveMB, {
      label: `${options.kind || 'video'}:${options.label || 'media'}`,
      tagDir: path.dirname(dest),
      tagPrefix: path.basename(dest, path.extname(dest)),
    });

    let saved = null;
    let lastError = null;
    for (const url of list) {
      try {
        const result = await fetchFile(url, dest, {
          maxBytes: maxMB * MB,
          timeoutMs: Number(options.timeoutMs) || spec.timeoutMs,
        });
        if (!fs.existsSync(dest) || fs.statSync(dest).size < 1) throw fail('BAD_SOURCE', 'Media file is empty');
        saved = { url, bytes: Number(result?.bytes) || fs.statSync(dest).size };
        break;
      } catch (error) {
        lastError = error;
        removeFile(dest);
        if (error?.code === 'TOO_BIG') break; // another link will not be smaller
      }
    }
    if (!saved) throw stageError(lastError, maxMB);

    const info = sniffFile(dest, spec);
    return await send({ file: dest, bytes: saved.bytes, ext: info.ext, mime: info.mime, kind: info.kind, url: saved.url });
  } finally {
    removeFile(dest);
    reservation?.release?.();
    releaseHold();
  }
}

/**
 * Remote image (poster / cover) → disk → WhatsApp → delete.
 * `body` is merged into the message ({ caption }); resolves the sendMessage result.
 */
async function sendStagedImage(sock, chatId, url, body, options) {
  return withStagedMedia(url, { kind: 'image', label: 'image' }, (staged) =>
    sock.sendMessage(chatId, { image: { url: staged.file }, ...(body || {}) }, options));
}

module.exports = { withStagedMedia, sendStagedImage, stageError, KINDS };

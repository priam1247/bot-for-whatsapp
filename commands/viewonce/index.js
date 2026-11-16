/**
 * ViewOnce Command - Reveal view-once messages
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { getTempDir, deleteTempFile } = require('../../lib/tempManager');

module.exports = {
  name: 'viewonce',
  aliases: ['readvo', 'read', 'vv', 'readviewonce'],
  category: 'general',
  description: 'Reveal view-once messages (images/videos/audio)',
  usage: '.viewonce (reply to view-once message)',
  
  async execute(sock, msg, args) {
    try {
      const chatId = msg.key.remoteJid;

      // Try to get contextInfo from different message types (reply can be from text, image, video, etc.)
      const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo
        || msg.message?.buttonsResponseMessage?.contextInfo
        || msg.message?.listResponseMessage?.contextInfo;

      if (!ctx?.quotedMessage || !ctx?.stanzaId) {
        return await sock.sendMessage(
          chatId,
          { text: 'Reply to a view-once message.' },
          { quoted: msg }
        );
      }

      const quotedMsg = ctx.quotedMessage;

      // Check various patterns used for view-once messages
      const hasViewOnce =
        !!quotedMsg.viewOnceMessageV2 ||
        !!quotedMsg.viewOnceMessageV2Extension ||
        !!quotedMsg.viewOnceMessage ||
        !!quotedMsg.viewOnce ||
        !!quotedMsg?.imageMessage?.viewOnce ||
        !!quotedMsg?.videoMessage?.viewOnce ||
        !!quotedMsg?.audioMessage?.viewOnce;

      if (!hasViewOnce) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ This is not a view-once message!' },
          { quoted: msg }
        );
      }

      let actualMsg = null;
      let mtype = null;

      // The media is not always the first key (messageContextInfo usually is),
      // so look for the real media container explicitly.
      const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage'];
      const pickMedia = (container) => MEDIA_KEYS.find(k => container?.[k]) || null;

      // Newer Baileys: viewOnceMessageV2Extension
      if (quotedMsg.viewOnceMessageV2Extension?.message) {
        actualMsg = quotedMsg.viewOnceMessageV2Extension.message;
        mtype = pickMedia(actualMsg);

      // Classic Baileys: viewOnceMessageV2
      } else if (quotedMsg.viewOnceMessageV2?.message) {
        actualMsg = quotedMsg.viewOnceMessageV2.message;
        mtype = pickMedia(actualMsg);

      // Older: viewOnceMessage
      } else if (quotedMsg.viewOnceMessage?.message) {
        actualMsg = quotedMsg.viewOnceMessage.message;
        mtype = pickMedia(actualMsg);

      // Direct message with viewOnce flag on media
      } else if (quotedMsg.imageMessage?.viewOnce) {
        actualMsg = { imageMessage: quotedMsg.imageMessage };
        mtype = 'imageMessage';
      } else if (quotedMsg.videoMessage?.viewOnce) {
        actualMsg = { videoMessage: quotedMsg.videoMessage };
        mtype = 'videoMessage';
      } else if (quotedMsg.audioMessage?.viewOnce) {
        actualMsg = { audioMessage: quotedMsg.audioMessage };
        mtype = 'audioMessage';
      }

      if (!actualMsg || !mtype) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ Unsupported view-once message type.' },
          { quoted: msg }
        );
      }

      const downloadType =
        mtype === 'imageMessage'
          ? 'image'
          : mtype === 'videoMessage'
          ? 'video'
          : 'audio';

      const mediaStream = await downloadContentFromMessage(
        actualMsg[mtype],
        downloadType
      );

      // Stream the media to a temp file instead of growing a Buffer chunk by
      // chunk (which copied the whole video on every chunk). Baileys then
      // streams the file back out from disk.
      const ext = downloadType === 'image' ? 'jpg' : downloadType === 'video' ? 'mp4' : 'audio';
      const tempFile = path.join(getTempDir(), `viewonce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.${ext}`);
      try {
        await pipeline(mediaStream, fs.createWriteStream(tempFile));

        const caption = actualMsg[mtype]?.caption || '';

        if (/video/.test(mtype)) {
          await sock.sendMessage(chatId, { video: { url: tempFile }, caption, mimetype: 'video/mp4' }, { quoted: msg });
        } else if (/image/.test(mtype)) {
          await sock.sendMessage(chatId, { image: { url: tempFile }, caption, mimetype: 'image/jpeg' }, { quoted: msg });
        } else if (/audio/.test(mtype)) {
          // Keep the original codec: forcing ptt on non-Opus audio breaks playback.
          const srcMime = actualMsg[mtype]?.mimetype || '';
          const isOpus = /ogg|opus/i.test(srcMime);
          await sock.sendMessage(chatId, {
            audio: { url: tempFile },
            ptt: isOpus,
            mimetype: isOpus ? 'audio/ogg; codecs=opus' : (srcMime || 'audio/mp4'),
          }, { quoted: msg });
        }
      } finally {
        deleteTempFile(tempFile);
      }
    } catch (error) {
      console.error('Error in viewonce command:', error);
      await sock.sendMessage(
        msg.key.remoteJid,
        {
          text: '❌ Could not unlock that view-once message. Ask the sender to resend it and try again.'
        },
        { quoted: msg }
      );
    }
  }
};

const telemetry = require('../../lib/telemetry');

const BOT_START = Date.now();

function uptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60),
        h = Math.floor(m / 60),   d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

module.exports = [
  {
    name: 'status',
    aliases: ['update', 'botstatus'],
    category: 'admin',
    description: 'Server stats',
    usage: '.status',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      await react(sock, msg, '🔄');
      const mem = process.memoryUsage();
      const { inspectDisk } = require('../../lib/diskSpace');
      const disk = inspectDisk();
      const t = telemetry.snapshot();

      const text = [
        '🟢 *SERVICE STATUS*',
        `⏱ Uptime: ${uptime(Date.now() - BOT_START)}`,
        `⚡ Commands: ${t.commandsTotal}`,
        `📥 Downloads: ${t.downloadsSuccess} ok · ${t.failedTotal} failed`,
        `💾 RAM: ${(mem.rss / 1048576).toFixed(0)} MB`,
        `💿 Disk: ${disk.folderUsedMB.toFixed(0)} / ${disk.budgetMB} MB`,
        ...(() => {
          const rows = require('../../lib/accountSockets').health();
          if (!rows.length) return [];
          const ago = (ms) => (ms == null ? 'nothing yet' : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${(ms / 3_600_000).toFixed(1)} h ago`);
          return ['', '*ACCOUNTS*', ...rows.map((r) => {
            const down = r.state === 'logged_out' || r.state === 'expired';
            const icon = r.state === 'answering' ? '✅' : down ? '❌' : r.state === 'paused' ? '⛔' : '🔄';
            const drop = r.lastClose ? ` · last drop ${r.lastClose.code} ${ago(r.lastClose.ago)}` : '';
            const hint = r.state === 'logged_out' ? ` — send .pair ${r.number} to link again` : '';
            return `${icon} ${r.role === 'owner' ? 'Owner' : 'Linked'} +${r.number} — ${r.state}${r.reason ? ` (${r.reason})` : ''} · last message heard ${ago(r.lastInboundAgo)} · ${r.reconnects} reconnect${r.reconnects === 1 ? '' : 's'}${drop}${hint}`;
          })];
        })(),
        '',
        '*DOWNLOAD SERVICE*',
        await (async () => {
          try {
            const h = await require('../../lib/downloads/gronka').health();
            if (h.state === 'ok') return `✅ Gronka (${h.ms}ms) — .song .video .fb .instagram`;
            if (h.state === 'not-set') return '⚠️ GRONKA_API_KEY is not set — .song .video .fb .instagram are off';
            return `❌ Gronka is down (${h.reason}) — .song .video .fb .instagram will fail`;
          } catch (error) { return `❌ Gronka check failed (${String(error?.message || error).slice(0, 60)})`; }
        })(),
        '',
        '*COMMANDS*',
        ...require('../../gateway/registry').board().map((row) => {
          const icon = row.state === 'ok' ? '✅' : row.state === 'broken' ? '❌' : '⛔';
          const detail = row.state === 'partial' ? ` — off: ${row.off.map((n) => '.' + n).join(' ')}` : (row.reason ? ` — ${row.reason}` : '');
          return `${icon} ${row.folder}${detail}`;
        }),
      ].join('\n');

      await react(sock, msg, '✅');
      return extra.reply(text);
    },
  },

  {
    name: 'heal',
    aliases: ['fixlinks'],
    category: 'admin',
    description: 'Check every linked number and reconnect the ones that are stuck',
    usage: '.heal [all]',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      await react(sock, msg, '🔄');
      const accounts = require('../../lib/accountSockets');
      const rows = await accounts.heal({ all: /^all$/i.test(String(args?.[0] || '')), skip: accounts.sessionKey(sock) });
      await react(sock, msg, '✅');
      if (!rows.length) return extra.reply('ℹ️ No accounts to check.');
      const icon = (r) => (r === 'ok' ? '✅' : /paused/.test(r) ? '⛔' : '🔄');
      return extra.reply(['🩺 *ACCOUNT CHECK*', ...rows.map((x) => `${icon(x.result)} ${x.role === 'owner' ? 'Owner' : 'Linked'} +${x.number} — ${x.result}`)].join('\n'));
    },
  },
  {
    name: 'restart',
    aliases: ['reboot'],
    category: 'admin',
    description: 'Reload code and reconnect WhatsApp',
    usage: '.restart [command]',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      // `.restart <command>` reloads just that command's folder — nothing else restarts.
      if (args && args[0]) {
        const result = require('../../gateway/handler').reloadCommand(args[0]);
        if (!result) return extra.reply(`❌ No command folder matches "${args[0]}".`);
        return extra.reply(result.state === 'ok'
          ? `♻️ Reloaded ${result.folder} (${result.names.map((n) => '.' + n).join(', ')}).`
          : `❌ ${result.folder} failed to load: ${result.reason}`);
      }
      const hotReload = require('../../lib/hotReload');
      if (!hotReload.beginRestart()) return extra.reply('⏳ Restart in progress.');
      let reconnectScheduled = false;
      try {
        await react(sock, msg, '🔄');
        // A failed acknowledgement must not leave the restart stuck or prevent
        // reconnecting a socket that is already having trouble sending.
        try { await extra.reply('🔄 Reloading and reconnecting…'); } catch { /* best effort */ }
        hotReload.reloadRuntime();
        try { await extra.reply('♻️ Reloaded code & reconnecting…'); } catch { /* best effort */ }
        setTimeout(() => {
          try {
            const ended = sock.end(new Error('restart requested'));
            if (ended && typeof ended.catch === 'function') ended.catch(() => {});
          } catch { /* already closed */ }
          finally { hotReload.finishRestart(); }
        }, 1000);
        reconnectScheduled = true;
      } finally {
        // Reload failures must not make every later restart report "in progress".
        if (!reconnectScheduled) hotReload.finishRestart();
      }
    },
  },

];

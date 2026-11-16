'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountSockets = require('../lib/accountSockets');
const commands = require('../commands/pair');

const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
const sock = { sendMessage: async () => ({}) };
const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm1', fromMe: true } };
const run = async (name, args) => {
  const replies = [];
  await byName[name].execute(sock, msg, args, { reply: async (t) => { replies.push(t); } });
  return replies.join('\n');
};

test('.pair and .remove are owner-only commands', () => {
  for (const name of ['pair', 'remove']) {
    assert.equal(byName[name].ownerOnly, true);
    assert.notEqual(byName[name].linkedOk, true, 'a linked number must never link or remove numbers');
    assert.notEqual(byName[name].adminOk, true);
  }
});

test('.pair sends the code and says the number stays until .remove', async () => {
  const asked = [];
  accountSockets.setLinker({ pair: async (n) => { asked.push(n); return { code: 'ABCD1234', expiresInSeconds: 60 }; }, remove: async () => ({}) });
  const text = await run('pair', ['+265 991 234 567']);
  assert.deepEqual(asked, ['265991234567']);
  assert.match(text, /ABCD-1234/);
  assert.match(text, /\.remove 265991234567/);
});

test('.pair rejects a bad number and reports why a link failed', async () => {
  accountSockets.setLinker({ pair: async () => { throw new Error('This number is already linked. Send .remove first if you want to link it again.'); }, remove: async () => ({}) });
  assert.match(await run('pair', []), /Usage: \.pair/);
  assert.match(await run('pair', ['12']), /Usage: \.pair/);
  assert.match(await run('pair', ['265991234567']), /already linked/);
});

test('.remove reports whether WhatsApp logged the device out, and unknown numbers', async () => {
  accountSockets.setLinker({ pair: async () => ({}), remove: async () => ({ number: '265991234567', loggedOut: true }) });
  assert.match(await run('remove', ['265991234567']), /Removed \+265991234567\. It was logged out/);
  accountSockets.setLinker({ pair: async () => ({}), remove: async () => ({ number: '265991234567', loggedOut: false }) });
  assert.match(await run('remove', ['265991234567']), /could not be reached/);
  accountSockets.setLinker({ pair: async () => ({}), remove: async () => { throw Object.assign(new Error('That number is not linked.'), { statusCode: 404 }); } });
  assert.match(await run('remove', ['265991234567']), /is not linked/);
  assert.match(await run('remove', []), /Usage: \.remove/);
});

test('the commands are registered and appear in the owner menu', () => {
  const { loadCommands } = require('../gateway/registry');
  const all = loadCommands();
  assert.equal(all.get('pair').name, 'pair');
  assert.equal(all.get('remove').name, 'remove');
});

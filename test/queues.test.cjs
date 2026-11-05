const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueStore } = require('../queues.cjs');

function queue(machine = 'access:local') {
  const thread = { id: 'queued-chat', cwd: '/project' };
  return { key: machine + ':' + thread.id, machine, thread, paused: false, editing: true, messages: [{ machine, thread, text: 'Keep my draft', images: [], input: [{ type: 'text', text: 'Keep my draft' }, { type: 'skill', name: 'cr', path: '/skills/cr/SKILL.md' }], access: { sandbox: 'read-only', approvalPolicy: 'on-request' }, model: 'test-model', effort: 'high', mode: 'plan' }] };
}

function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-queues-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new QueueStore(path.join(directory, 'queues'));
}

test('queued messages persist through restart with their inputs and settings and always restore paused', t => {
  const saved = store(t); const draft = queue();
  assert.deepEqual(saved.list(), []);
  saved.save(draft);
  assert.equal(saved.hasMessages(draft.key), true);
  assert.equal(saved.hasMessages('access:local:another-chat'), false);
  const restored = new QueueStore(saved.directory).list()[0];
  assert.deepEqual(restored.messages, draft.messages);
  assert.equal(restored.paused, true);
  assert.equal(restored.editing, undefined);
  assert.equal(fs.statSync(saved.file(draft.key)).mode & 0o777, 0o600);
});

test('text edits, images larger than localStorage, removal, and machine isolation persist', t => {
  const saved = store(t); const local = queue(); const ssh = queue('access:root@warmer:22');
  const image = { name: 'large.png', size: 5 * 1024 * 1024, url: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024) };
  local.messages[0].images.push(image); local.messages[0].input.push({ type: 'image', url: image.url });
  saved.save(local); saved.save(ssh);
  assert.equal(new QueueStore(saved.directory).list().find(entry => entry.machine === local.machine).messages[0].input.at(-1).url, image.url);
  local.messages[0].text = 'Edited draft'; saved.save(local);
  assert.equal(new QueueStore(saved.directory).list().find(entry => entry.machine === local.machine).messages[0].text, 'Edited draft');
  local.messages = []; saved.save(local);
  assert.equal(saved.hasMessages(local.key), false);
  assert.equal(saved.hasMessages(ssh.key), true);
  assert.deepEqual(new QueueStore(saved.directory).list().map(entry => entry.machine), [ssh.machine]);
});

test('failed queue writes preserve the previous draft and temporary files do not appear as queues', t => {
  const saved = store(t); const draft = queue(); saved.save(draft);
  fs.mkdirSync(saved.file(draft.key) + '.tmp');
  draft.messages[0].text = 'Unsaved edit';
  assert.throws(() => saved.save(draft));
  assert.equal(new QueueStore(saved.directory).list()[0].messages[0].text, 'Keep my draft');
});

test('invalid queue identities and malformed saved files fail without changing saved drafts', t => {
  const saved = store(t); const draft = queue(); saved.save(draft);
  assert.throws(() => saved.save({ ...draft, key: '../outside' }), /Invalid saved message queue/);
  assert.throws(() => saved.save({ ...draft, messages: [{ ...draft.messages[0], machine: 'access:another-host:22' }] }), /Invalid saved message queue/);
  fs.writeFileSync(path.join(saved.directory, 'broken.json'), '{broken');
  assert.throws(() => saved.list());
  assert.equal(JSON.parse(fs.readFileSync(saved.file(draft.key))).messages[0].text, 'Keep my draft');
});

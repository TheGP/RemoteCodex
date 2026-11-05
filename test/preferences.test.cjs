const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PreferencesStore } = require('../preferences.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-preferences-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'preferences.json');
}

test('theme and per-machine startup projects persist independently through restarts', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  assert.deepEqual(store.read(), { theme: 'system', startupProjects: {} });
  store.update({ theme: 'purple' });
  store.update({ startupProject: { machine: 'access:local', projectId: 'rapidcode' } });
  store.update({ startupProject: { machine: 'access:root@host:22', projectId: 'remote-project' } });
  assert.deepEqual(new PreferencesStore(file).read(), { theme: 'purple', startupProjects: { 'access:local': 'rapidcode', 'access:root@host:22': 'remote-project' } });
  store.update({ theme: 'claude-code' });
  store.update({ startupProject: { machine: 'access:local', projectId: null } });
  assert.deepEqual(new PreferencesStore(file).read(), { theme: 'claude-code', startupProjects: { 'access:root@host:22': 'remote-project' } });
});

test('invalid preferences and failed writes leave saved settings unchanged', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'dark' });
  for (const patch of [null, {}, [], { unknown: true }, { theme: 'unknown' }, { startupProject: null }, { startupProject: { machine: '__proto__', projectId: 'bad' } }, { startupProject: { machine: 'access:local', projectId: '' } }]) assert.throws(() => store.update(patch));
  assert.equal(store.read().theme, 'dark');
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ theme: 'light' }));
  assert.equal(new PreferencesStore(file).read().theme, 'dark');
});

test('unread and completion markers survive process restarts and remain separate per machine', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'purple', startupProject: { machine: 'access:local', projectId: 'rapidcode' } });
  store.update({ conversationState: { machine: 'access:local', unread: ['manual', 'manual'], completions: { finished: 'completed', broken: 'failed' } } });
  store.update({ conversationState: { machine: 'access:root@host:22', unread: ['remote'], completions: { done: 'completed' } } });
  const reopened = new PreferencesStore(file);
  assert.deepEqual(reopened.read().conversationStates['access:local'], { unread: ['manual'], completions: { finished: 'completed', broken: 'failed' } });
  reopened.update({ conversationState: { machine: 'access:local', unread: [], completions: {} } });
  assert.deepEqual(new PreferencesStore(file).read().conversationStates['access:local'], { unread: [], completions: {} });
  assert.deepEqual(new PreferencesStore(file).read().conversationStates['access:root@host:22'], { unread: ['remote'], completions: { done: 'completed' } });
  assert.equal(reopened.read().theme, 'purple');
  assert.equal(reopened.read().startupProjects['access:local'], 'rapidcode');
});

test('invalid markers and failed writes preserve the last saved unread state', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  const saved = { machine: 'access:local', unread: ['keep'], completions: { finished: 'completed' } };
  store.update({ conversationState: saved });
  for (const value of [null, { ...saved, machine: '__proto__' }, { ...saved, unread: [''] }, { ...saved, completions: [] }, { ...saved, completions: { finished: 'running' } }]) assert.throws(() => store.update({ conversationState: value }));
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ conversationState: { ...saved, unread: [] } }));
  assert.deepEqual(new PreferencesStore(file).read().conversationStates['access:local'], { unread: ['keep'], completions: { finished: 'completed' } });
});

test('conversation order survives restart independently for each project and machine', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'purple', conversationState: { machine: 'access:local', unread: ['unread'], completions: { finished: 'completed' } } });
  store.update({ threadOrder: { machine: 'access:local', projectId: 'rapidcode', ids: ['b', 'a', 'b'] } });
  store.update({ threadOrder: { machine: 'access:local', projectId: 'other', ids: ['other-b', 'other-a'] } });
  store.update({ threadOrder: { machine: 'access:host:22', projectId: 'rapidcode', ids: ['remote-a'] } });
  const saved = new PreferencesStore(file).read();
  assert.deepEqual(saved.threadOrders, { 'access:local': { rapidcode: ['b', 'a'], other: ['other-b', 'other-a'] }, 'access:host:22': { rapidcode: ['remote-a'] } });
  assert.equal(saved.theme, 'purple');
  assert.deepEqual(saved.conversationStates['access:local'].unread, ['unread']);
  const order = { machine: 'access:local', projectId: 'rapidcode', ids: ['a', 'b'] };
  for (const value of [null, { ...order, machine: '__proto__' }, { ...order, projectId: '' }, { ...order, ids: [''] }, { ...order, ids: 'invalid' }]) assert.throws(() => store.update({ threadOrder: value }));
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ threadOrder: order }));
  assert.deepEqual(new PreferencesStore(file).read().threadOrders['access:local'].rapidcode, ['b', 'a']);
});

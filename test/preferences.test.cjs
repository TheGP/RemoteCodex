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

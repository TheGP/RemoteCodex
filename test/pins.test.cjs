const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PinStore } = require('../pins.cjs');

test('pins persist across restarts, isolate machines, and unpin without duplicates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pins.json');
  const pins = new PinStore(file);
  const local = { mode: 'local' };
  const ssh = { mode: 'ssh', host: 'root@warmer', port: 22 };
  assert.deepEqual(pins.get(local), []);
  pins.set(local, 'local-chat', true);
  pins.set(local, 'local-chat', true);
  assert.deepEqual(new PinStore(file).get(local), ['local-chat']);
  assert.deepEqual(pins.get(ssh), []);
  pins.set(ssh, 'remote-chat', true);
  assert.deepEqual(pins.get({ ...ssh, port: 2200 }), []);
  assert.deepEqual(pins.get({ ...ssh, host: 'another-host' }), []);
  assert.deepEqual(pins.get(local), ['local-chat']);
  pins.set(local, 'local-chat', false);
  assert.deepEqual(new PinStore(file).get(local), []);
  assert.deepEqual(new PinStore(file).get(ssh), ['remote-chat']);
  assert.throws(() => pins.set(local, '../invalid', 'true'), /Invalid conversation pin/);
  assert.throws(() => pins.set(local, '', true), /Invalid conversation pin/);
});

test('a failed pin save preserves the previous file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pins.json');
  const pins = new PinStore(file);
  const local = { mode: 'local' };
  pins.set(local, 'saved', true);
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => pins.set(local, 'unsaved', true));
  assert.deepEqual(new PinStore(file).get(local), ['saved']);
});

test('adding a provider preserves old Codex pins and separates identical conversation IDs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-provider-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pins.json'), store = new PinStore(file);
  store.set({ mode: 'local' }, 'same-chat', true);
  assert.deepEqual(store.get({ mode: 'local', provider: 'codex' }), ['same-chat']);
  assert.deepEqual(store.get({ mode: 'local', provider: 'sample' }), []);
  store.set({ mode: 'local', provider: 'sample' }, 'same-chat', true);
  store.set({ mode: 'local', provider: 'codex' }, 'same-chat', false);
  assert.deepEqual(new PinStore(file).get({ mode: 'local', provider: 'sample' }), ['same-chat']);
  assert.deepEqual(store.get({ mode: 'ssh', provider: 'sample', host: 'host', port: 22 }), []);
});

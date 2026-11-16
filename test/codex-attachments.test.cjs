const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { CodexAttachmentStore } = require('../codex-history.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM9sAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-attachments-')));
  const home = path.join(directory, 'home'), storage = path.join(directory, 'private-events'), image = path.join(directory, 'image.png');
  fs.mkdirSync(home); fs.writeFileSync(image, png);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new CodexAttachmentStore(storage), threadId = randomUUID();
  const capture = (id = 'first', options = {}) => store.capture({ threadId, turnId: 'turn-one', item: { type: 'imageView', id, path: image }, home, ...options });
  return { directory, home, storage, image, store, threadId, capture };
}

test('tool-time image captures survive overwritten and deleted paths, duplicate events and store restart', t => {
  const f = fixture(t), first = f.capture();
  assert.deepEqual(first.data, png);
  const newer = Buffer.concat([png, Buffer.from('different screenshot')]); fs.writeFileSync(f.image, newer);
  assert.deepEqual(f.capture().data, png);
  assert.deepEqual(f.capture('second').data, newer);
  assert.deepEqual(f.capture('third').data, newer);
  assert.deepEqual(fs.readFileSync(f.image), newer);
  fs.unlinkSync(f.image);
  assert.deepEqual(f.capture().data, png);
  const reopened = new CodexAttachmentStore(f.storage);
  assert.deepEqual(reopened.get({ threadId: f.threadId, itemId: 'first' }).data, png);
  assert.deepEqual(reopened.get({ threadId: f.threadId, turnId: 'turn-one', itemId: 'second' }).data, newer);
  assert.equal(fs.readdirSync(path.join(f.storage, 'blobs')).length, 2);
  for (const folder of ['events', 'blobs']) for (const name of fs.readdirSync(path.join(f.storage, folder))) assert.equal(fs.statSync(path.join(f.storage, folder, name)).mode & 0o077, 0);
});

test('image event identity isolates conversations and accepts raw/native ImageView casing and file URIs', t => {
  const f = fixture(t);
  f.capture('same-item'); fs.writeFileSync(f.image, Buffer.concat([png, Buffer.from('other thread')]));
  const other = f.capture('same-item', { threadId: randomUUID(), item: { type: 'ImageView', id: 'same-item', path: pathToFileURL(f.image).href } });
  assert.notDeepEqual(other.data, png);
  assert.deepEqual(f.store.get({ threadId: f.threadId, itemId: 'same-item' }).data, png);
  assert.equal(f.capture('ignored', { item: { type: 'commandExecution', id: 'ignored', path: f.image } }), null);
  assert.throws(() => f.capture('bad', { threadId: '../escape\n' }), /identity/);
});

test('event captures retain image security checks and retry a failed started event when its image becomes valid', t => {
  const f = fixture(t);
  fs.writeFileSync(f.image, 'not yet an image'); assert.throws(() => f.capture(), /supported image/);
  fs.writeFileSync(f.image, png); assert.deepEqual(f.capture().data, png);
  const credentials = path.join(f.directory, 'credentials'); fs.mkdirSync(credentials);
  const cases = [path.join(f.home, 'auth.json'), path.join(f.directory, 'config.png'), path.join(credentials, 'image.png'), path.join(f.directory, 'database.sqlite')];
  for (const [index, file] of cases.entries()) {
    fs.writeFileSync(file, png);
    assert.throws(() => f.capture('secret-' + index, { item: { type: 'imageView', id: 'secret-' + index, path: file } }), /Account|configuration/);
  }
  fs.writeFileSync(f.image, ''); fs.truncateSync(f.image, 20 * 1024 * 1024 + 1);
  assert.throws(() => f.capture('too-large'), /20 MB/);
  assert.equal(fs.readdirSync(path.join(f.storage, 'events')).length, 1);
});

test('a missing or corrupt immutable blob fails closed rather than recapturing a reused source path', t => {
  const f = fixture(t); f.capture();
  const name = fs.readdirSync(path.join(f.storage, 'blobs'))[0], blob = path.join(f.storage, 'blobs', name);
  fs.writeFileSync(f.image, Buffer.concat([png, Buffer.from('new screenshot')]));
  fs.writeFileSync(blob, 'corrupt'); assert.throws(() => f.capture(), /checksum/);
  fs.unlinkSync(blob); assert.throws(() => f.capture(), /missing/);
  assert.equal(fs.readdirSync(path.join(f.storage, 'blobs')).length, 0);
});

test('attachment snapshot storage cannot follow a redirected events directory', t => {
  const f = fixture(t), outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(f.storage); fs.symlinkSync(outside, path.join(f.storage, 'events'), 'dir');
  assert.throws(() => f.capture(), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an image changed during its first read is rejected without creating an immutable event', t => {
  const f = fixture(t), read = fs.readSync; let changed = false;
  t.mock.method(fs, 'readSync', function (...args) {
    const count = read.apply(this, args);
    if (!changed) {
      changed = true; fs.writeFileSync(f.image, Buffer.concat([png, Buffer.from('concurrent replacement')]));
    }
    return count;
  });
  assert.throws(() => f.capture(), /changed while being captured/);
  assert.deepEqual(fs.readdirSync(path.join(f.storage, 'events')), []);
});

test('capture rejects a named pipe without waiting for a writer', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), { execFileSync, spawnSync } = require('node:child_process');
  fs.unlinkSync(f.image); execFileSync('mkfifo', [f.image]);
  const script = `const {CodexAttachmentStore}=require(process.argv[1]);
    try {new CodexAttachmentStore(process.argv[2]).capture({threadId:'thread',item:{type:'imageView',id:'view',path:process.argv[3]},home:process.argv[4]});process.exitCode=1;}
    catch(error){if(!/regular file/.test(error.message))process.exitCode=2;}`;
  const result = spawnSync(process.execPath, ['-e', script, require.resolve('../codex-history.cjs'), f.storage, f.image, f.home], { timeout: 2000, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
});

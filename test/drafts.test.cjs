const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DraftStore, draftKey } = require('../drafts.cjs');

const target = { machine: 'access:local', kind: 'composer', threadId: 'draft-chat', cwd: '/project', projectId: 'project-one' };
const image = { name: 'preview.png', url: 'data:image/png;base64,aGVsbG8=' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-drafts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new DraftStore(path.join(directory, 'drafts'));
}

test('typed text, images and send choices survive fresh store instances without localStorage', t => {
  const store = fixture(t);
  store.save(target, { text: '  Unsent\nmessage\n', images: [image], hours: 168, model: 'gpt-6.1-sol', effort: 'high', mode: 'plan', access: 'read-only' });
  const restarted = new DraftStore(store.directory);
  const draft = restarted.read(target);
  assert.equal(draft.text, '  Unsent\nmessage\n'); assert.equal(draft.hours, 168); assert.equal(draft.mode, 'plan');
  assert.equal(draft.images[0].url, image.url); assert.equal(draft.images[0].name, image.name);
  assert.deepEqual(restarted.last(target.machine).draft, draft);
  assert.equal(fs.statSync(path.join(store.folder(target), 'draft.json')).mode & 0o777, 0o600);
  const asset = path.join(store.folder(target), store.metadata(target).images[0].file);
  fs.utimesSync(asset, 1, 1);
  store.save(target, { text: 'Only the text changed' });
  assert.equal(fs.statSync(asset).mtimeMs, 1000, 'Typing rewrote image data');
  assert.equal(store.read(target).images[0].url, image.url);
});

test('drafts stay separate across chats, machines, projects, folders and editor types', t => {
  const store = fixture(t);
  const targets = [target, { ...target, threadId: 'other-chat' }, { ...target, machine: 'access:user@server:22' }, { ...target, threadId: null }, { ...target, threadId: null, projectId: 'project-two' }, { ...target, threadId: null, cwd: '/other-folder' }, { ...target, kind: 'edit-message', itemId: 'turn-one' }, { ...target, kind: 'edit-queue', itemId: 'queued-one' }];
  for (const [index, value] of targets.entries()) store.save(value, { text: 'Draft ' + index });
  for (const [index, value] of targets.entries()) assert.equal(new DraftStore(store.directory).read(value).text, 'Draft ' + index);
  assert.equal(draftKey(target), draftKey({ ...target, cwd: '/moved', projectId: 'moved-project' }));
  const emptyEditor = targets[6]; store.save(emptyEditor, { text: '' });
  assert.equal(store.read(emptyEditor).text, '', 'An intentionally empty edit reverted to the original message');
});

test('moving a new-chat draft preserves its contents and images before removing its old copy', t => {
  const store = fixture(t); const fresh = { ...target, threadId: null };
  store.save(fresh, { text: 'Not accepted yet', images: [image], hours: 24, model: '', effort: '', mode: 'default', access: 'workspace-write' });
  store.move(fresh, target);
  assert.equal(store.read(fresh), null); assert.equal(store.read(target).text, 'Not accepted yet');
  assert.equal(new DraftStore(store.directory).last(target.machine).target.threadId, target.threadId);
  assert.equal(store.read(target).images[0].url, image.url);
  store.save(target, { text: '', images: [] });
  assert.equal(store.read(target), null); assert.equal(fs.existsSync(store.folder(target)), false);
  assert.equal(store.last(target.machine), null);
});

test('image replacements clean old assets and invalid images cannot replace a saved draft', t => {
  const store = fixture(t); store.save(target, { text: 'Keep me', images: [image] });
  for (const url of ['https://example.com/image.png', 'file:///private/file', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,aGVsbG8=']) assert.throws(() => store.save(target, { images: [{ name: 'unsafe', url }] }));
  assert.equal(store.read(target).text, 'Keep me'); assert.equal(store.read(target).images[0].url, image.url);
  store.save(target, { images: [{ ...image, url: 'data:image/png;base64,bmV3' }] });
  assert.equal(fs.readdirSync(store.folder(target)).filter(file => file.startsWith('image-')).length, 1);
  assert.throws(() => store.save(target, { hours: 25 }));
  assert.throws(() => store.save({ ...target, kind: 'other' }, { text: 'x' }));
  assert.throws(() => store.save(target, { unexpected: 'x' }));
});

test('failed writes and failed moves retain the last successfully saved prompt', t => {
  const store = fixture(t); store.save(target, { text: 'Saved prompt' });
  fs.mkdirSync(path.join(store.folder(target), 'draft.json.tmp'));
  assert.throws(() => store.save(target, { text: 'Not saved' }));
  assert.equal(new DraftStore(store.directory).read(target).text, 'Saved prompt');
  const destination = { ...target, threadId: 'cannot-move' }; fs.mkdirSync(store.folder(destination), { recursive: true });
  fs.mkdirSync(path.join(store.folder(destination), 'draft.json.tmp'));
  assert.throws(() => store.move(target, destination));
  assert.equal(store.read(target).text, 'Saved prompt');
});

test('corrupt metadata and unsafe asset paths fail without reading outside draft storage', t => {
  const store = fixture(t); store.save(target, { text: 'Safe', images: [image] });
  const file = path.join(store.folder(target), 'draft.json'); const data = JSON.parse(fs.readFileSync(file));
  data.images[0].file = '../../outside.png'; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => store.read(target), /Invalid saved draft image/);
  data.version = 2; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => store.read(target), /Invalid saved draft/);
});

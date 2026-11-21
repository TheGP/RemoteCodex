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

test('draft markers read metadata without loading images and stay separate by chat and machine', async t => {
  const store = fixture(t);
  const ids = [target.threadId, 'other-chat'];
  assert.deepEqual(await store.indicators(target.machine, ids), []);
  store.save(target, { text: ' \n ' }); assert.deepEqual(await store.indicators(target.machine, ids), []);
  store.save(target, { text: 'Unsent prompt' });
  assert.deepEqual(await new DraftStore(store.directory).indicators(target.machine, ids), [target.threadId]);
  assert.deepEqual(await store.indicators('access:other-machine', ids), []);
  store.save(target, { text: '', images: [image] });
  fs.unlinkSync(path.join(store.folder(target), store.metadata(target).images[0].file));
  assert.deepEqual(await store.indicators(target.machine, ids), [target.threadId]);
  assert.throws(() => store.read(target), /ENOENT/);
  store.clear(target); assert.deepEqual(await store.indicators(target.machine, ids), []);
});

test('drafts stay separate across chats, machines, projects, folders and editor types', t => {
  const store = fixture(t);
  const targets = [target, { ...target, threadId: 'other-chat' }, { ...target, machine: 'access:user@server:22' }, { ...target, threadId: null }, { ...target, threadId: null, projectId: 'project-two' }, { ...target, threadId: null, cwd: '/other-folder' }, { ...target, kind: 'edit-message', itemId: 'turn-one' }, { ...target, kind: 'edit-queue', itemId: 'queued-one' }, { ...target, kind: 'edit-schedule', itemId: 'scheduled-one' }];
  for (const [index, value] of targets.entries()) store.save(value, { text: 'Draft ' + index });
  for (const [index, value] of targets.entries()) assert.equal(new DraftStore(store.directory).read(value).text, 'Draft ' + index);
  assert.equal(draftKey(target), draftKey({ ...target, cwd: '/moved', projectId: 'moved-project' }));
  const emptyEditor = targets[6]; store.save(emptyEditor, { text: '' });
  assert.equal(store.read(emptyEditor).text, '', 'An intentionally empty edit reverted to the original message');
  const scheduled = targets.at(-1);
  store.save(scheduled, { text: 'Unfinished scheduled edit', runAt: '2026-12-01T12:30' });
  const restored = new DraftStore(store.directory).last(target.machine);
  assert.equal(restored.target.kind, 'edit-schedule'); assert.equal(restored.draft.runAt, '2026-12-01T12:30');
  assert.throws(() => store.save(scheduled, { runAt: 'not a date' }));
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

test('editor IPC keeps stale typed text locally and flags conflicting text or schedule baselines before mutation', t => {
  const { EventEmitter } = require('node:events');
  const { registerDraftIpc } = require('../drafts.cjs');
  const store = fixture(t), ipc = new EventEmitter(), captures = [];
  ipc.handle = ipc.on;
  registerDraftIpc(ipc, store, () => {}, () => {}, (target, stale) => captures.push({ target, stale }));
  const editor = { ...target, kind: 'edit-message', itemId: 'turn' };
  store.save(editor, { text: 'Peer edited this' });
  const event = {}; ipc.emit('save-draft', event, editor, { text: 'Original plus local typing' }, { text: 'Original' });
  assert.equal(event.returnValue.error, undefined);
  assert.equal(store.read(editor).text, 'Original plus local typing'); assert.equal(captures.at(-1).stale, true);
  ipc.emit('save-draft', {}, editor, { text: 'More typing' }, { text: 'Original plus local typing' });
  assert.equal(captures.at(-1).stale, false);
  const scheduled = { ...editor, kind: 'edit-schedule' };
  store.save(scheduled, { text: 'Same text', runAt: '2026-12-01T15:00' });
  ipc.emit('save-draft', {}, scheduled, { text: 'Same text', runAt: '2026-12-02T15:00' }, { text: 'Same text', runAt: '2026-12-01T14:00' });
  assert.equal(captures.at(-1).stale, true);
  const invalid = {}; ipc.emit('save-draft', invalid, editor, { text: 'Must not save' }, { unknown: 'bad baseline' });
  assert.match(invalid.returnValue.error, /baseline/); assert.equal(store.read(editor).text, 'More typing');
});


test('editor Cancel uses the same stale baseline check before clearing a newer shared draft', t => {
  const { EventEmitter } = require('node:events');
  const { registerDraftIpc } = require('../drafts.cjs');
  const store = fixture(t), ipc = new EventEmitter(), captured = [];
  ipc.handle = ipc.on;
  registerDraftIpc(ipc, store, () => {}, () => {}, (target, stale) => captured.push(stale));
  const editor = { ...target, kind: 'edit-message', itemId: 'cancel-turn' };
  store.save(editor, { text: 'New peer draft' });
  const event = {}; ipc.emit('clear-draft', event, editor, undefined, { text: 'Old visible draft' });
  assert.equal(event.returnValue.error, undefined); assert.equal(store.read(editor), null); assert.equal(captured.at(-1), true);
});


test('a forced save supersedes an in-flight autosave in either IPC delivery order', t => {
  const { EventEmitter } = require('node:events');
  const { randomUUID } = require('node:crypto');
  const { registerDraftIpc } = require('../drafts.cjs');
  const store = fixture(t), ipc = new EventEmitter(), sender = {}, captures = [];
  ipc.handle = ipc.on;
  registerDraftIpc(ipc, store, () => {}, () => {}, (_target, stale) => captures.push(stale));

  for (const autosaveFirst of [true, false]) {
    const writeId = randomUUID(), expected = { text: 'Existing draft' };
    store.save(target, expected);
    const autosave = () => ipc.emit('autosave-draft', { sender }, target, { text: 'Earlier typing' }, expected, writeId);
    if (autosaveFirst) autosave();
    const event = { sender };
    ipc.emit('save-draft', event, target, { text: 'Latest text on close' }, expected, writeId);
    assert.equal(event.returnValue.error, undefined);
    if (!autosaveFirst) autosave();
    assert.equal(store.read(target).text, 'Latest text on close');
    assert.equal(captures.some(Boolean), false, 'The pending autosave looked like a remote draft edit');
  }
});

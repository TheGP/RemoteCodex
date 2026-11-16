const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { exportCodexHistory, importCodexHistory, extendsCodexHistory, CodexAttachmentStore } = require('../codex-history.cjs');

const checksum = data => createHash('sha256').update(data).digest('hex');
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
const decode = data => data.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
const timestamp = '2026-11-16T12:00:00.000Z';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM9sAAAAASUVORK5CYII=', 'base64');
const user = (ordinal, text = 'Question') => ({ timestamp, type: 'event_msg', ordinal, payload: { type: 'user_message', message: text } });
const assistant = ordinal => ({ timestamp, type: 'response_item', ordinal, payload: { type: 'message', id: 'unchanged-message-id', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } });
const imageRow = (ordinal, file) => ({ timestamp, type: 'response_item', ordinal, payload: { type: 'message', role: 'user', content: [{ type: 'localImage', path: file }] } });
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-history-')));
  const home = path.join(directory, 'source-home'), cwd = path.join(directory, 'source-project');
  const receiver = path.join(directory, 'receiver-home'), receiverCwd = path.join(directory, 'receiver-project');
  const cache = path.join(directory, 'receiver-private'), blobs = new Map();
  for (const folder of [home, cwd, receiver, receiverCwd, cache, path.join(home, 'sessions'), path.join(home, 'archived_sessions')]) fs.mkdirSync(folder, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keepBlob = data => { const id = checksum(data); blobs.set(id, Buffer.from(data)); return id; };
  const readBlob = async id => { assert.ok(blobs.has(id), 'unknown blob must not be fetched elsewhere'); return Buffer.from(blobs.get(id)); };
  const meta = (id, extra = {}) => ({ timestamp, type: 'session_meta', ordinal: 0, payload: { id, session_id: id, cwd, runtime_workspace_roots: [cwd], ...extra } });
  const write = (rows, id = rows[0].payload.id, root = 'sessions') => {
    const file = path.join(home, root, 'rollout-2026-11-16T12-00-00-' + id + '.jsonl');
    fs.writeFileSync(file, encode(rows)); return { id, path: file, cwd, name: 'Fixture conversation' };
  };
  const create = rows => { const id = randomUUID(); return write([meta(id), ...(rows || [user(1), assistant(2)])]); };
  const exportThread = thread => exportCodexHistory({ thread, home, keepBlob });
  const portable = manifest => gunzipSync(Buffer.concat(manifest.chunks.map(chunk => blobs.get(chunk.hash))));
  const importManifest = (manifest, overrides = {}) => importCodexHistory({ manifest, home: receiver, cwd: receiverCwd, readBlob, directory: cache, ...overrides });
  const replaceRows = (manifest, rows) => {
    const raw = encode(rows), compressed = gzipSync(raw), hash = keepBlob(compressed);
    return { ...manifest, digest: checksum(raw), bytes: raw.length, chunks: [{ hash, bytes: compressed.length }], blobs: [{ hash, bytes: compressed.length }, ...manifest.attachments.map(({ hash, bytes }) => ({ hash, bytes }))] };
  };
  return { directory, home, cwd, receiver, receiverCwd, cache, blobs, meta, write, create, keepBlob, readBlob, exportThread, portable, importManifest, replaceRows };
}

test('Codex history round trips into native session storage without copying account files', async t => {
  const f = fixture(t), thread = f.create(), original = fs.readFileSync(thread.path);
  fs.writeFileSync(path.join(f.home, 'auth.json'), 'private-auth-fixture');
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'private-config-fixture');
  fs.writeFileSync(path.join(f.cwd, 'unrelated.txt'), 'unrelated-project-fixture');
  const manifest = await f.exportThread(thread), raw = f.portable(manifest), rows = decode(raw);
  assert.equal(manifest.format, 'codex-rollout-v1'); assert.equal(manifest.id, thread.id);
  assert.equal(manifest.bytes, raw.length); assert.equal(manifest.digest, checksum(raw));
  assert.deepEqual(manifest.attachments, []);
  for (const chunk of manifest.chunks) { assert.ok(chunk.bytes <= 4 * 1024 * 1024); assert.equal(checksum(f.blobs.get(chunk.hash)), chunk.hash); assert.equal(f.blobs.get(chunk.hash).length, chunk.bytes); }
  assert.deepEqual(rows, decode(original));
  const imported = await f.importManifest(manifest), importedRows = decode(fs.readFileSync(imported.path));
  assert.equal(imported.id, thread.id);
  const name = path.basename(imported.path);
  assert.equal(path.dirname(imported.path), path.join(f.receiver, 'sessions', ...name.slice(8, 18).split('-')));
  assert.match(name, new RegExp('^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-' + thread.id + '_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.jsonl$'));
  assert.equal(importedRows[0].payload.cwd, f.receiverCwd);
  assert.deepEqual(importedRows[0].payload.runtime_workspace_roots, [f.receiverCwd]);
  assert.deepEqual(importedRows.slice(1), rows.slice(1));
  assert.equal(fs.statSync(imported.path).isFile(), true); fs.accessSync(imported.path, fs.constants.W_OK);
  assert.equal(fs.statSync(imported.path).mode & 0o077, 0);
  assert.deepEqual(fs.readFileSync(thread.path), original);
  assert.equal(fs.existsSync(path.join(f.receiver, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(f.receiver, 'config.toml')), false);
  assert.equal(f.blobs.size, manifest.chunks.length);
  assert.doesNotMatch(raw.toString(), /private-auth-fixture|private-config-fixture|unrelated-project-fixture/);
  const changed = new Date(Date.now() + 10000); fs.utimesSync(thread.path, changed, changed);
  const repeated = await f.exportThread(thread);
  assert.equal(repeated.digest, manifest.digest); assert.deepEqual(repeated.chunks, manifest.chunks);
});

test('linked histories flatten archived parents only to the captured byte and ordinal boundary', async t => {
  const f = fixture(t), parentId = randomUUID(), childId = randomUUID();
  const inherited = [f.meta(parentId), user(1, 'Inherited question'), assistant(2)];
  const parent = f.write([...inherited, user(3, 'Appended after the fork')], parentId, 'archived_sessions');
  const child = f.write([f.meta(childId, { history_base: { thread_id: parentId, end_ordinal_exclusive: 3, end_byte_offset: encode(inherited).length } }), user(5, 'Child question with ordinal hole')]);
  const originals = [parent, child].map(thread => fs.readFileSync(thread.path));
  const manifest = await f.exportThread(child), rows = decode(f.portable(manifest));
  assert.equal(rows[0].payload.id, childId); assert.equal(rows[0].ordinal, 0);
  assert.equal('history_base' in rows[0].payload, false);
  assert.deepEqual(rows.map(row => row.ordinal), [0, 1, 2, 5]);
  assert.deepEqual(rows.slice(1), [...inherited.slice(1), user(5, 'Child question with ordinal hole')]);
  assert.doesNotMatch(f.portable(manifest).toString(), /Appended after the fork/);
  const imported = await f.importManifest(manifest);
  assert.deepEqual(decode(fs.readFileSync(imported.path)).slice(1), rows.slice(1));
  [parent, child].forEach((thread, index) => assert.deepEqual(fs.readFileSync(thread.path), originals[index]));
});

test('continuation filenames can differ from the logical conversation identity', async t => {
  const f = fixture(t), logicalId = randomUUID(), segmentId = randomUUID();
  const inherited = [f.meta(logicalId), user(1, 'Earlier continuation')];
  f.write(inherited, segmentId);
  const current = f.write([f.meta(logicalId, { history_base: { thread_id: segmentId, end_ordinal_exclusive: 2, end_byte_offset: encode(inherited).length } }), assistant(4)]);
  const rows = decode(f.portable(await f.exportThread(current)));
  assert.equal(rows[0].payload.id, logicalId);
  assert.deepEqual(rows.map(row => row.ordinal), [0, 1, 4]);
  assert.equal(rows[1].payload.message, 'Earlier continuation');
});

test('one compressed stream round trips across multiple bounded blob chunks', async t => {
  const f = fixture(t), text = randomBytes(4 * 1024 * 1024 + 4096).toString('base64');
  const thread = f.create([user(1, text)]), manifest = await f.exportThread(thread);
  assert.ok(manifest.chunks.length >= 2);
  for (const chunk of manifest.chunks) assert.ok(chunk.bytes <= 4 * 1024 * 1024);
  const imported = await f.importManifest(manifest);
  assert.equal(decode(fs.readFileSync(imported.path))[1].payload.message, text);
});

test('source history must have its own matching first metadata record inside the session roots', async t => {
  for (const kind of ['outside', 'escaping-symlink', 'mismatched-id', 'not-metadata', 'incomplete']) await t.test(kind, async t => {
    const f = fixture(t), thread = f.create();
    if (kind === 'outside' || kind === 'escaping-symlink') {
      const outside = path.join(f.cwd, 'outside.jsonl'); fs.copyFileSync(thread.path, outside);
      if (kind === 'outside') thread.path = outside;
      else { fs.unlinkSync(thread.path); fs.symlinkSync(outside, thread.path); }
    }
    if (kind === 'mismatched-id') fs.writeFileSync(thread.path, encode([f.meta(randomUUID()), user(1)]));
    if (kind === 'not-metadata') fs.writeFileSync(thread.path, encode([user(1)]));
    if (kind === 'incomplete') fs.appendFileSync(thread.path, '{"type":');
    await assert.rejects(f.exportThread(thread));
  });
});

test('linked history rejects missing, cyclic and invalid boundaries', async t => {
  for (const kind of ['missing', 'cycle', 'partial-line', 'past-end', 'fractional-ordinal', 'negative-ordinal', 'ordinal-mismatch']) await t.test(kind, async t => {
    const f = fixture(t), parent = f.create(), id = randomUUID();
    const boundary = { thread_id: parent.id, end_ordinal_exclusive: 3, end_byte_offset: fs.statSync(parent.path).size };
    if (kind === 'missing') boundary.thread_id = randomUUID();
    if (kind === 'cycle') boundary.thread_id = id;
    if (kind === 'partial-line') boundary.end_byte_offset -= 2;
    if (kind === 'past-end') boundary.end_byte_offset += 1;
    if (kind === 'fractional-ordinal') boundary.end_ordinal_exclusive = 1.5;
    if (kind === 'negative-ordinal') boundary.end_ordinal_exclusive = -1;
    if (kind === 'ordinal-mismatch') boundary.end_ordinal_exclusive = 2;
    const child = f.write([f.meta(id, { history_base: boundary }), user(3)]);
    await assert.rejects(f.exportThread(child));
  });
});

test('images are deduplicated and rewritten only in typed attachment fields', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'screen # + 漢.png'), data = png;
  fs.writeFileSync(image, data);
  const rows = [
    { timestamp, type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ type: 'localImage', path: image }, { type: 'local_image', path: image }, { type: 'input_image', image_url: pathToFileURL(image).href }, { type: 'input_image', image_url: 'https://example.test/image.png' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }], path: image, text: 'Leave ordinary path ' + image } },
    { ...user(2), payload: { ...user(2).payload, local_images: [image] } },
  ];
  const thread = f.create(rows), original = fs.readFileSync(thread.path), manifest = await f.exportThread(thread), portableRows = decode(f.portable(manifest));
  assert.deepEqual(manifest.attachments, [{ hash: checksum(data), bytes: data.length, name: path.basename(image) }]);
  assert.deepEqual(f.blobs.get(checksum(data)), data);
  const token = 'remote-codex-attachment:' + checksum(data), portableContent = portableRows[1].payload.content;
  assert.equal(portableContent[0].path, token); assert.equal(portableContent[1].path, token); assert.equal(portableContent[2].image_url, token);
  assert.deepEqual(portableRows[2].payload.local_images, [token]);
  assert.equal(portableRows[1].payload.path, image); assert.equal(portableRows[1].payload.text, rows[0].payload.text);
  const imported = await f.importManifest(manifest), importedRows = decode(fs.readFileSync(imported.path)), content = importedRows[1].payload.content;
  const imagePath = path.join(f.cache, 'attachments', checksum(data) + '.png');
  assert.equal(content[0].path, imagePath); assert.equal(content[1].path, imagePath);
  assert.equal(content[2].image_url, pathToFileURL(imagePath).href);
  assert.deepEqual(content.slice(3), rows[0].payload.content.slice(3));
  assert.deepEqual(importedRows[2].payload.local_images, [imagePath]);
  assert.equal(importedRows[1].payload.path, image); assert.equal(importedRows[1].payload.text, rows[0].payload.text);
  assert.deepEqual(fs.readFileSync(imagePath), data); assert.deepEqual(fs.readFileSync(image), data);
  assert.deepEqual(fs.readFileSync(thread.path), original);
});

test('source attachments reject traversal, symlink escapes, directories and oversized files', async t => {
  for (const kind of ['outside', 'traversal', 'symlink', 'directory', 'oversized']) await t.test(kind, async t => {
    const f = fixture(t); let image = path.join(f.cwd, 'image.png');
    const outside = path.join(f.directory, 'outside.png'); fs.writeFileSync(outside, 'outside-secret');
    if (kind === 'outside') image = outside;
    if (kind === 'traversal') image = path.join(f.cwd, '..', 'outside.png');
    if (kind === 'symlink') fs.symlinkSync(outside, image);
    if (kind === 'directory') image = f.cwd;
    if (kind === 'oversized') { fs.writeFileSync(image, ''); fs.truncateSync(image, 20 * 1024 * 1024 + 1); }
    const thread = f.create([imageRow(1, image)]);
    await assert.rejects(f.exportThread(thread));
  });
});

test('forged image references cannot upload account files or JSON disguised as an image', async t => {
  for (const kind of ['account-json', 'disguised-png', 'account-image-name']) await t.test(kind, async t => {
    const f = fixture(t), secret = Buffer.from('{"access_token":"private-fixture-secret"}');
    let image;
    if (kind === 'account-json') image = path.join(f.home, 'auth.json');
    if (kind === 'disguised-png') image = path.join(f.cwd, 'fake.png');
    if (kind === 'account-image-name') { fs.mkdirSync(path.join(f.home, 'credentials')); image = path.join(f.home, 'credentials', 'saved.png'); }
    fs.writeFileSync(image, kind === 'account-image-name' ? png : secret);
    const thread = f.create([imageRow(1, image)]), uploads = [];
    await assert.rejects(exportCodexHistory({ thread, home: f.home, keepBlob: data => { uploads.push(Buffer.from(data)); return f.keepBlob(data); } }), /Account|configuration|supported image/);
    assert.equal(uploads.some(data => data.includes(secret)), false);
    assert.equal(uploads.some(data => data.equals(kind === 'account-image-name' ? png : secret)), false);
  });
});

test('import rejects a correctly checksummed non-image attachment', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'image.png'); fs.writeFileSync(image, png);
  const original = await f.exportThread(f.create([imageRow(1, image)])), rows = decode(f.portable(original));
  const data = Buffer.from('{"access_token":"not-an-image"}'), id = f.keepBlob(data);
  rows[1].payload.content[0].path = 'remote-codex-attachment:' + id;
  const manifest = f.replaceRows({ ...original, attachments: [{ hash: id, bytes: data.length, name: 'fake.png' }] }, rows);
  await assert.rejects(f.importManifest(manifest), /supported image/);
  assert.equal(fs.existsSync(path.join(f.cache, 'attachments', id + '.png')), false);
});

test('import validates chunk checksums, sizes, compression and total size before accepting history', async t => {
  for (const kind of ['corrupt-chunk', 'wrong-size', 'oversized-chunk', 'oversized-total', 'wrong-digest', 'wrong-identity', 'duplicate-meta', 'invalid-gzip']) await t.test(kind, async t => {
    const f = fixture(t), manifest = await f.exportThread(f.create()), altered = structuredClone(manifest);
    if (kind === 'corrupt-chunk') f.blobs.set(altered.chunks[0].hash, Buffer.alloc(altered.chunks[0].bytes));
    if (kind === 'wrong-size') altered.chunks[0].bytes += 1;
    if (kind === 'oversized-chunk') altered.chunks[0].bytes = 4 * 1024 * 1024 + 1;
    if (kind === 'oversized-total') altered.bytes = 512 * 1024 * 1024 + 1;
    if (kind === 'wrong-digest') altered.digest = '0'.repeat(64);
    if (kind === 'wrong-identity') altered.id = randomUUID();
    if (kind === 'duplicate-meta') { const rows = decode(f.portable(manifest)); Object.assign(altered, f.replaceRows(manifest, [...rows, rows[0]])); }
    if (kind === 'invalid-gzip') { const invalid = Buffer.from('not-gzip'); altered.chunks = [{ hash: f.keepBlob(invalid), bytes: invalid.length }]; }
    const storage = path.join(f.receiver, 'sessions'), day = path.join(storage, ...new Date().toISOString().slice(0, 10).split('-'));
    fs.mkdirSync(day, { recursive: true }); const sibling = path.join(day, 'existing-conversation.jsonl'); fs.writeFileSync(sibling, 'Unrelated fixture history');
    await assert.rejects(f.importManifest(altered));
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'Unrelated fixture history');
    assert.deepEqual(fs.globSync('**/*', { cwd: storage }).filter(file => fs.lstatSync(path.join(storage, file)).isFile()), [path.relative(storage, sibling)]);
  });
});

test('import never resolves missing portable attachment tokens against receiving-computer files', async t => {
  for (const kind of ['unlisted-token', 'unportable-path', 'wrong-attachment-checksum', 'traversal-hash']) await t.test(kind, async t => {
    const f = fixture(t), image = path.join(f.cwd, 'image.png'); fs.writeFileSync(image, png);
    const thread = f.create([imageRow(1, image)]);
    const manifest = await f.exportThread(thread), rows = decode(f.portable(manifest)); let altered = structuredClone(manifest);
    if (kind === 'unlisted-token') { rows[1].payload.content[0].path = 'remote-codex-attachment:' + '0'.repeat(64); altered = f.replaceRows(manifest, rows); }
    if (kind === 'unportable-path') { rows[1].payload.content[0].path = image; altered = f.replaceRows(manifest, rows); }
    if (kind === 'wrong-attachment-checksum') f.blobs.set(altered.attachments[0].hash, Buffer.alloc(altered.attachments[0].bytes));
    if (kind === 'traversal-hash') altered.attachments[0].hash = '../outside';
    await assert.rejects(f.importManifest(altered));
    assert.deepEqual(fs.readFileSync(image), png);
  });
});

test('session storage roots cannot escape the source home through a symlink', async t => {
  const f = fixture(t), thread = f.create(), moved = path.join(f.directory, 'external-sessions');
  fs.renameSync(path.join(f.home, 'sessions'), moved); fs.symlinkSync(moved, path.join(f.home, 'sessions'));
  await assert.rejects(f.exportThread(thread));
});

test('import refuses attachment cache and native storage symlink escapes', async t => {
  for (const kind of ['attachment-directory', 'cached-attachment', 'session-directory', 'session-day']) await t.test(kind, async t => {
    const f = fixture(t), image = path.join(f.cwd, 'image.png'), outside = path.join(f.directory, 'external');
    fs.writeFileSync(image, png); fs.mkdirSync(outside);
    const manifest = await f.exportThread(f.create([imageRow(1, image)]));
    if (kind === 'attachment-directory') fs.symlinkSync(outside, path.join(f.cache, 'attachments'));
    if (kind === 'cached-attachment') {
      fs.mkdirSync(path.join(f.cache, 'attachments')); const victim = path.join(outside, 'image.png'); fs.copyFileSync(image, victim);
      fs.symlinkSync(victim, path.join(f.cache, 'attachments', manifest.attachments[0].hash + '.png'));
    }
    if (kind === 'session-directory') fs.symlinkSync(outside, path.join(f.receiver, 'sessions'));
    if (kind === 'session-day') { const day = path.join(f.receiver, 'sessions', ...new Date().toISOString().slice(0, 10).split('-')); fs.mkdirSync(path.dirname(day), { recursive: true }); fs.symlinkSync(outside, day); }
    const before = fs.readdirSync(outside); await assert.rejects(f.importManifest(manifest));
    assert.deepEqual(fs.readdirSync(outside), before);
  });
});


test('fresh native aliases preserve logical identity and all existing turn and item IDs', async t => {
  const f = fixture(t), id = randomUUID(), nativeId = randomUUID(), turnId = randomUUID();
  const event = { timestamp, type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'AgentMessage', id: 'stable-pinned-item', content: [{ type: 'Text', text: 'Pinned answer' }] } } };
  const manifest = await f.exportThread(f.write([f.meta(id), event]));
  const imported = await f.importManifest(manifest, { nativeId });
  assert.equal(imported.id, nativeId); assert.equal(imported.logicalId, id);
  assert.match(path.basename(imported.path), new RegExp('-' + nativeId + '_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.jsonl$'));
  const rows = decode(fs.readFileSync(imported.path));
  assert.equal(rows[0].payload.id, nativeId); assert.equal(rows[0].payload.session_id, nativeId);
  assert.equal(rows[1].payload.thread_id, nativeId); assert.equal(rows[1].payload.turn_id, turnId);
  assert.deepEqual(rows[1].payload.item, event.payload.item);
  await assert.rejects(f.importManifest(manifest, { nativeId: 'not-a-uuid' }), /native conversation identity/);
  const forged = decode(f.portable(manifest)); forged[0].payload.id = randomUUID();
  await assert.rejects(f.importManifest(f.replaceRows(manifest, forged), { nativeId }), /identity/);
});

test('exporting an aliased native rollout restores the logical header and event IDs without rewriting turns or items', async t => {
  const f = fixture(t), nativeId = randomUUID(), logicalId = randomUUID(), turnId = randomUUID();
  const event = { timestamp, type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', thread_id: nativeId, turn_id: turnId, root_turn_id: turnId, item: { type: 'AgentMessage', id: 'stable-item', content: [{ type: 'Text', text: 'Alias answer' }] } } };
  const thread = f.write([f.meta(nativeId), event]), original = fs.readFileSync(thread.path);
  const manifest = await exportCodexHistory({ thread, logicalId, home: f.home, keepBlob: f.keepBlob }), portable = decode(f.portable(manifest));
  assert.equal(manifest.id, logicalId); assert.equal(portable[0].payload.id, logicalId); assert.equal(portable[0].payload.session_id, logicalId);
  assert.equal(portable[1].payload.thread_id, logicalId);
  assert.equal(portable[1].payload.turn_id, turnId); assert.equal(portable[1].payload.root_turn_id, turnId);
  assert.deepEqual(portable[1].payload.item, event.payload.item);
  assert.deepEqual(fs.readFileSync(thread.path), original);
  const nextId = randomUUID(), imported = await f.importManifest(manifest, { nativeId: nextId });
  const reexported = await exportCodexHistory({ thread: { id: nextId, path: imported.path, cwd: f.receiverCwd }, logicalId, home: f.receiver, keepBlob: f.keepBlob });
  assert.equal(reexported.id, logicalId);
  assert.deepEqual(decode(f.portable(reexported))[1], portable[1]);
});

test('deleted source images import as private missing-image paths without consulting old source paths', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'deleted.png');
  fs.writeFileSync(image, png); const thread = f.create([imageRow(1, image), imageRow(2, image)]); fs.unlinkSync(image);
  const manifest = await f.exportThread(thread), portable = decode(f.portable(manifest));
  assert.equal(manifest.missingImages, 1); assert.deepEqual(manifest.attachments, []);
  const token = portable[1].payload.content[0].path;
  assert.match(token, /^remote-codex-missing-image:[a-f0-9]{64}$/);
  assert.equal(portable[2].payload.content[0].path, token);
  const external = Buffer.from('Receiving-computer file at the old source path'); fs.writeFileSync(image, external);
  const reads = [], imported = await f.importManifest(manifest, { readBlob: async id => { reads.push(id); return f.readBlob(id); } });
  const missing = decode(fs.readFileSync(imported.path))[1].payload.content[0].path;
  assert.equal(missing, path.join(f.cache, 'attachments', 'missing-' + token.split(':')[1] + '.png'));
  assert.equal(fs.existsSync(missing), false); assert.deepEqual(fs.readFileSync(image), external);
  assert.deepEqual(reads, manifest.chunks.map(chunk => chunk.hash));
});

test('genuine user-selected PNGs outside the workspace and native ImageView file URIs are portable', async t => {
  for (const kind of ['selected-input', 'image-view']) await t.test(kind, async t => {
    const f = fixture(t), image = path.join(f.directory, 'selected.png'); fs.writeFileSync(image, png);
    const row = kind === 'selected-input' ? imageRow(1, image) : { timestamp, type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', thread_id: randomUUID(), turn_id: 'stable-turn', item: { type: 'ImageView', id: 'stable-view', path: pathToFileURL(image).href } } };
    const manifest = await f.exportThread(f.create([row]));
    assert.equal(manifest.attachments.length, 1); assert.deepEqual(f.blobs.get(manifest.attachments[0].hash), png);
    const imported = await f.importManifest(manifest), rows = decode(fs.readFileSync(imported.path));
    const expected = path.join(f.cache, 'attachments', checksum(png) + '.png');
    if (kind === 'selected-input') assert.equal(rows[1].payload.content[0].path, expected);
    else assert.equal(rows[1].payload.item.path, pathToFileURL(expected).href);
    assert.deepEqual(fs.readFileSync(expected), png);
  });
});

test('private attachment roots allow re-export from a cache outside both Codex home and workspace', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'image.png'), id = randomUUID(); fs.writeFileSync(image, png);
  const row = { timestamp, type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', thread_id: id, turn_id: 'same-turn', item: { type: 'UserMessage', id: 'same-user', content: [{ type: 'local_image', path: image }] } } };
  const manifest = await f.exportThread(f.write([f.meta(id), row])), nativeId = randomUUID();
  const imported = await f.importManifest(manifest, { nativeId });
  const options = { thread: { id: nativeId, path: imported.path, cwd: f.receiverCwd }, logicalId: id, home: f.receiver, keepBlob: f.keepBlob };
  await assert.rejects(exportCodexHistory(options), /outside its allowed folders/);
  const reexported = await exportCodexHistory({ ...options, attachmentRoots: [f.cache] });
  assert.equal(reexported.id, id); assert.equal(reexported.attachments.length, 1);
  assert.equal(reexported.attachments[0].hash, checksum(png));
  assert.equal(decode(f.portable(reexported))[1].payload.item.id, 'same-user');
});

test('concurrent native imports safely share newly created calendar storage folders', async t => {
  const f = fixture(t), manifest = await f.exportThread(f.create()), ids = [randomUUID(), randomUUID()];
  const results = await Promise.allSettled(ids.map(nativeId => f.importManifest(manifest, { nativeId })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 'fulfilled', result.reason?.message);
    assert.equal(decode(fs.readFileSync(result.value.path))[0].payload.id, ids[index]);
  }
  assert.notEqual(results[0].value.path, results[1].value.path);
});


test('history ancestry checks verify exact canonical prefixes and complete checksums across compressed chunks', async t => {
  const f = fixture(t), thread = f.create([user(1, 'Unicode: 確認碼 and 😀'), assistant(2)]);
  const base = await f.exportThread(thread);
  fs.appendFileSync(thread.path, encode([user(3, 'A newer local message')]));
  const manifest = await f.exportThread(thread), compressed = Buffer.concat(manifest.chunks.map(chunk => f.blobs.get(chunk.hash)));
  manifest.chunks = [];
  for (let offset = 0; offset < compressed.length; offset += 31) {
    const bytes = compressed.subarray(offset, offset + 31);
    manifest.chunks.push({ hash: f.keepBlob(bytes), bytes: bytes.length });
  }
  const check = (candidate = manifest, ancestor = base) => extendsCodexHistory({ manifest: candidate, base: ancestor, readBlob: f.readBlob });
  assert.equal(await check(), true);
  assert.equal(await check(manifest, { ...base, digest: checksum(Buffer.from('unrelated history')) }), false);
  assert.equal(await check({ ...manifest, digest: checksum(Buffer.from('wrong full checksum')) }), false);
  assert.equal(await check({ ...manifest, bytes: base.bytes - 1 }), false);
  assert.equal(await check({ ...manifest, id: randomUUID() }), false);
  f.blobs.set(manifest.chunks[0].hash, Buffer.from('corrupt bytes'));
  await assert.rejects(check(), /checksum/);
});

test('history recovery accepts changed ImageView attachments only when every other older record matches', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'latest-screen.png'); fs.writeFileSync(image, png);
  const view = { timestamp, type: 'event_msg', ordinal: 2, payload: { type: 'item_completed', item: { type: 'ImageView', id: 'original-view', path: image } } };
  const thread = f.create([user(1), view]), base = await f.exportThread(thread);
  fs.writeFileSync(image, Buffer.concat([png, Buffer.from('new screenshot')]));
  fs.appendFileSync(thread.path, encode([user(3, 'Continue the same conversation')]));
  const manifest = await f.exportThread(thread);
  assert.equal(await extendsCodexHistory({ manifest, base, readBlob: f.readBlob }), false);
  const check = candidate => extendsCodexHistory({ manifest: candidate, base, readBlob: f.readBlob, allowImageViewChanges: true });
  assert.equal(await check(manifest), true);
  const rows = decode(f.portable(manifest)); rows[1].payload.message = 'A different user message';
  assert.equal(await check(f.replaceRows(manifest, rows)), false);
  const changedView = decode(f.portable(manifest)); changedView[2].payload.item.id = 'different-view';
  assert.equal(await check(f.replaceRows(manifest, changedView)), false);
  const unlisted = decode(f.portable(manifest)); unlisted[2].payload.item.path = 'remote-codex-attachment:' + '0'.repeat(64);
  assert.equal(await check(f.replaceRows(manifest, unlisted)), false);
  f.blobs.set(base.chunks[0].hash, Buffer.from('corrupted older snapshot'));
  await assert.rejects(check(manifest), /checksum/);
});

test('changed user image inputs cannot be treated as changed ImageView output', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'user-input.png'); fs.writeFileSync(image, png);
  const thread = f.create([imageRow(1, image)]), base = await f.exportThread(thread);
  fs.writeFileSync(image, Buffer.concat([png, Buffer.from('different input')]));
  fs.appendFileSync(thread.path, encode([user(2, 'Follow-up')]));
  const manifest = await f.exportThread(thread);
  assert.equal(await extendsCodexHistory({ manifest, base, readBlob: f.readBlob, allowImageViewChanges: true }), false);
});

test('tool-time snapshots keep prior ImageView events immutable when one screenshot path is reused', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'screenshot.png'), id = randomUUID();
  const view = (ordinal, itemId) => ({ timestamp, type: 'event_msg', ordinal, payload: { type: 'item_completed', item: { type: 'ImageView', id: itemId, path: image } } });
  fs.writeFileSync(image, png);
  let store = new CodexAttachmentStore(path.join(f.directory, 'captured-events'));
  store.capture({ threadId: id, turnId: 'native-turn-with-no-rollout-turn-id', item: { type: 'imageView', id: 'first-view', path: image }, home: f.home });
  const newer = Buffer.concat([png, Buffer.from('newer capture')]); fs.writeFileSync(image, newer);
  const thread = f.write([f.meta(id), user(1), view(2, 'first-view')]);
  const exportThread = () => exportCodexHistory({ thread, home: f.home, keepBlob: f.keepBlob, attachmentStore: store });
  const first = await exportThread(), firstRows = decode(f.portable(first));
  assert.equal(firstRows[2].payload.item.path, 'remote-codex-attachment:' + checksum(png));
  store.capture({ threadId: id, turnId: 'next-turn', item: { type: 'imageView', id: 'second-view', path: image }, home: f.home });
  fs.appendFileSync(thread.path, encode([view(3, 'second-view')]));
  const original = fs.readFileSync(thread.path); fs.unlinkSync(image);
  store = new CodexAttachmentStore(store.directory);
  const latest = await exportThread(), latestRows = decode(f.portable(latest));
  assert.equal(latestRows[2].payload.item.path, firstRows[2].payload.item.path);
  assert.equal(latestRows[3].payload.item.path, 'remote-codex-attachment:' + checksum(newer));
  assert.equal(await extendsCodexHistory({ manifest: latest, base: first, readBlob: f.readBlob }), true);
  assert.deepEqual(new Set(latest.attachments.map(image => image.hash)), new Set([checksum(png), checksum(newer)]));
  assert.deepEqual(fs.readFileSync(thread.path), original);
  assert.equal((await exportThread()).digest, latest.digest);
});

test('forked histories reuse the captured parent event and independently capture a child event at the same path', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'shared-screenshot.png'); fs.writeFileSync(image, png);
  const store = new CodexAttachmentStore(path.join(f.directory, 'event-cache')), parentId = randomUUID(), childId = randomUUID();
  const view = (ordinal, itemId) => ({ timestamp, type: 'event_msg', ordinal, payload: { type: 'item_completed', item: { type: 'ImageView', id: itemId, path: image } } });
  const inherited = [f.meta(parentId), view(1, 'parent-view')]; f.write(inherited, parentId);
  store.capture({ threadId: parentId, item: { type: 'imageView', id: 'parent-view', path: image }, home: f.home });
  const newer = Buffer.concat([png, Buffer.from('child screenshot')]); fs.writeFileSync(image, newer);
  store.capture({ threadId: childId, item: { type: 'imageView', id: 'child-view', path: image }, home: f.home });
  const thread = f.write([f.meta(childId, { history_base: { thread_id: parentId, end_ordinal_exclusive: 2, end_byte_offset: encode(inherited).length } }), view(3, 'child-view')]);
  const rows = decode(f.portable(await exportCodexHistory({ thread, home: f.home, keepBlob: f.keepBlob, attachmentStore: store })));
  assert.equal(rows[1].payload.item.path, 'remote-codex-attachment:' + checksum(png));
  assert.equal(rows[2].payload.item.path, 'remote-codex-attachment:' + checksum(newer));
});

test('an imported native alias retains copy-scoped attachments across a receiving-device export and retry', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'source.png'); fs.writeFileSync(image, png);
  const id = randomUUID(), thread = f.write([f.meta(id), { timestamp, type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', thread_id: id, item: { type: 'ImageView', id: 'portable-view', path: pathToFileURL(image).href } } }]);
  const manifest = await f.exportThread(thread), nativeId = randomUUID(), imported = await f.importManifest(manifest, { nativeId });
  const store = new CodexAttachmentStore(path.join(f.directory, 'receiving-events'));
  const importedThread = { ...imported, cwd: f.receiverCwd };
  const first = await exportCodexHistory({ thread: importedThread, logicalId: id, home: f.receiver, keepBlob: f.keepBlob, attachmentRoots: [path.join(f.cache, 'attachments')], attachmentStore: store });
  assert.deepEqual(store.get({ threadId: nativeId, itemId: 'portable-view' }).data, png);
  const rows = decode(fs.readFileSync(imported.path)), original = fs.readFileSync(imported.path), importedImage = new URL(rows[1].payload.item.path);
  fs.writeFileSync(importedImage, Buffer.concat([png, Buffer.from('overwritten receiver cache')]));
  const repeated = await exportCodexHistory({ thread: importedThread, logicalId: id, home: f.receiver, keepBlob: f.keepBlob, attachmentRoots: [path.join(f.cache, 'attachments')], attachmentStore: new CodexAttachmentStore(store.directory) });
  assert.equal(repeated.digest, first.digest); assert.deepEqual(repeated.attachments, first.attachments);
  assert.deepEqual(fs.readFileSync(imported.path), original);
});

test('selecting remote history cannot reuse a competing local attachment capture for the same logical item', async t => {
  const f = fixture(t), image = path.join(f.cwd, 'screenshot.png'), id = randomUUID(), itemId = 'same-logical-view';
  fs.writeFileSync(image, png);
  const store = new CodexAttachmentStore(path.join(f.directory, 'shared-store'));
  store.capture({ threadId: id, item: { type: 'imageView', id: itemId, path: image }, home: f.home });
  const remoteBytes = Buffer.concat([png, Buffer.from('remote history image')]); fs.writeFileSync(image, remoteBytes);
  const thread = f.write([f.meta(id), { timestamp, type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', thread_id: id, item: { type: 'ImageView', id: itemId, path: image } } }]);
  const remote = await f.exportThread(thread), nativeId = randomUUID(), imported = await f.importManifest(remote, { nativeId });
  const exportCopy = () => exportCodexHistory({ thread: { ...imported, cwd: f.receiverCwd }, logicalId: id, home: f.receiver, keepBlob: f.keepBlob, attachmentRoots: [path.join(f.cache, 'attachments')], attachmentStore: store });
  const first = await exportCopy();
  assert.deepEqual(first.attachments.map(({ hash, bytes }) => ({ hash, bytes })), remote.attachments.map(({ hash, bytes }) => ({ hash, bytes })));
  assert.deepEqual(store.get({ threadId: id, itemId }).data, png);
  assert.deepEqual(store.get({ threadId: nativeId, itemId }).data, remoteBytes);
  const selectedPath = new URL(decode(fs.readFileSync(imported.path))[1].payload.item.path);
  fs.writeFileSync(selectedPath, Buffer.concat([png, Buffer.from('later reused path')]));
  store.capture({ threadId: nativeId, item: { type: 'imageView', id: itemId, path: selectedPath.href }, home: f.receiver });
  assert.equal((await exportCopy()).digest, first.digest);
  assert.deepEqual((await exportCopy()).attachments, first.attachments);
});

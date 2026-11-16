const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createGzip, createGunzip } = require('node:zlib');
const { Readable } = require('node:stream');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { hash } = require('./sync-state.cjs');
const { CodexAttachmentStore, readCodexImage, imageExtension } = require('./codex-attachments.cjs');

const maxBytes = 512 * 1024 * 1024, chunkBytes = 4 * 1024 * 1024, maxImage = 20 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const token = 'remote-codex-attachment:';
const missingToken = 'remote-codex-missing-image:';
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function parse(line) {
  try { return JSON.parse(line); } catch { throw new Error('Conversation history contains an invalid record.'); }
}
async function* lines(stream) {
  let pending = [], length = 0, bytes = 0;
  for await (const part of stream) {
    let start = 0;
    while (start < part.length) {
      const end = part.indexOf(10, start), piece = part.subarray(start, end < 0 ? part.length : end);
      pending.push(piece); length += piece.length;
      if (length > 32 * 1024 * 1024) throw new Error('Conversation record exceeds 32 MB.');
      if (end < 0) break;
      bytes += length + 1;
      yield { line: Buffer.concat(pending, length).toString('utf8'), end: bytes };
      pending = []; length = 0; start = end + 1;
    }
  }
  if (length) throw new Error('Conversation history ends with an incomplete record.');
}
async function transformImages(value, image, selected = false, identity = null) {
  if (!value || typeof value !== 'object') return;
  if (['localImage', 'local_image', 'LocalImage', 'ImageView', 'imageView'].includes(value.type) && typeof value.path === 'string') {
    const view = ['ImageView', 'imageView'].includes(value.type);
    value.path = await image(value.path, view, selected, view && identity ? { ...identity, itemId: value.id || identity.itemId } : null);
  }
  if (value.type === 'input_image' && typeof value.image_url === 'string' && (value.image_url.startsWith('file://') || value.image_url.startsWith(token) || value.image_url.startsWith(missingToken))) value.image_url = await image(value.image_url, true, selected);
  if (value.type === 'user_message' && Array.isArray(value.local_images)) value.local_images = await Promise.all(value.local_images.map(file => image(file, false, selected)));
  for (const [key, child] of Object.entries(value)) if (key !== 'local_images') {
    if (Array.isArray(child)) { for (const part of child) await transformImages(part, image, selected, identity); }
    else if (child && typeof child === 'object') await transformImages(child, image, selected, identity);
  }
}
async function exportCodexHistory({ thread, logicalId = thread?.id, home, keepBlob, attachmentRoots = [], attachmentStore }) {
  if (!uuid.test(thread?.id) || !uuid.test(logicalId) || thread.ephemeral) throw new Error('This conversation cannot be exported.');
  home = await fs.promises.realpath(home);
  const roots = [];
  for (const name of ['sessions', 'archived_sessions']) {
    try {
      const root = await fs.promises.realpath(path.join(home, name));
      if (!inside(home, root)) throw new Error('Conversation storage escapes its home folder.');
      roots.push(root);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const checked = async file => {
    const real = await fs.promises.realpath(file), stat = await fs.promises.stat(real);
    if (!roots.some(root => inside(root, real)) || !stat.isFile() || stat.size > maxBytes) throw new Error('Conversation history is outside its storage or exceeds 512 MB.');
    return { file: real, stat };
  };
  const first = await checked(thread.path);
  const readMeta = async file => {
    for await (const { line } of lines(fs.createReadStream(file))) {
      const record = parse(line);
      if (record.type !== 'session_meta' || !uuid.test(record.payload?.id)) throw new Error('Conversation history identity does not match.');
      return record;
    }
    throw new Error('Conversation history is empty.');
  };
  const meta = await readMeta(first.file), seen = new Set(), sources = [], attachments = new Map(), missingImages = new Set();
  if (meta.payload.id !== thread.id) throw new Error('Conversation history identity does not match.');
  const images = async (file, _url, selected, identity) => {
    if (typeof file !== 'string') throw new Error('Invalid conversation image reference.');
    if (file.startsWith('file://')) file = fileURLToPath(file);
    let image;
    try {
      if (attachmentStore && identity?.itemId) {
        image = attachmentStore.get(identity);
        if (!image && identity.sourceThreadId !== identity.threadId) image = attachmentStore.get({ ...identity, threadId: identity.sourceThreadId });
      }
      image ||= readCodexImage(file, { home, cwd: thread.cwd, selected, attachmentRoots });
      if (attachmentStore && identity?.itemId) image = attachmentStore.remember(identity, image);
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const id = hash(file); missingImages.add(id); return missingToken + id;
    }
    const id = keepBlob(image.data);
    attachments.set(id, { hash: id, bytes: image.data.length, name: image.name });
    if (attachments.size > 500) throw new Error('Conversation has too many image attachments.');
    return token + id;
  };
  async function* records(file, boundary = null) {
    const source = await checked(file);
    if (seen.has(source.file) || seen.size >= 100) throw new Error('Conversation history has a cyclic or excessive base chain.');
    seen.add(source.file); sources.push(source);
    const head = await readMeta(source.file), base = head.payload.history_base;
    if (base) {
      if (!uuid.test(base.thread_id) || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0 || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset <= 0) throw new Error('Invalid conversation history boundary.');
      const matches = roots.flatMap(root => fs.globSync('**/*' + base.thread_id + '.jsonl', { cwd: root }).filter(file => !file.split(path.sep).includes('remote-codex-sync')).map(file => path.join(root, file)));
      if (matches.length !== 1) throw new Error('A linked conversation history file is missing or ambiguous.');
      yield* records(matches[0], base);
    }
    if (boundary && boundary.end_byte_offset > source.stat.size) throw new Error('Conversation history boundary exceeds its file.');
    let end = 0;
    const stream = fs.createReadStream(source.file, boundary ? { end: boundary.end_byte_offset - 1 } : { end: source.stat.size - 1 });
    for await (const record of lines(stream)) {
      end = record.end; const row = parse(record.line);
      if (row.type === 'session_meta') continue;
      if (boundary && (!Number.isSafeInteger(row.ordinal) || row.ordinal >= boundary.end_ordinal_exclusive)) throw new Error('Conversation history boundary does not match its records.');
      const selected = row.type === 'event_msg' && (row.payload?.type === 'user_message' || ['item_started', 'item_completed'].includes(row.payload?.type) && ['ImageView', 'imageView'].includes(row.payload.item?.type)) || row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user';
      const identity = { threadId: thread.id, sourceThreadId: boundary ? head.payload.id : thread.id, itemId: Number.isSafeInteger(row.ordinal) ? 'ordinal:' + row.ordinal : null };
      await transformImages(row, images, selected, identity); yield row;
    }
    if (boundary && end !== boundary.end_byte_offset) throw new Error('Conversation history boundary is incomplete.');
  }
  const checksum = createHash('sha256'); let bytes = 0, count = 0;
  async function* portable() {
    const header = structuredClone(meta); delete header.payload.history_base; header.ordinal = 0;
    header.payload.id = logicalId; header.payload.session_id = logicalId;
    for await (const record of (async function* () { yield header; yield* records(first.file); })()) {
      if (record.type === 'event_msg' && record.payload?.thread_id) record.payload.thread_id = logicalId;
      if (++count > 1000000) throw new Error('Conversation has too many history records.');
      const data = Buffer.from(JSON.stringify(record) + '\n'); bytes += data.length;
      if (bytes > maxBytes) throw new Error('Conversation history exceeds 512 MB.');
      checksum.update(data); yield data;
    }
  }
  const input = Readable.from(portable()), compressed = createGzip();
  input.on('error', error => compressed.destroy(error)); input.pipe(compressed);
  const chunks = []; let pending = Buffer.alloc(0), compressedBytes = 0;
  try { for await (const data of compressed) {
    compressedBytes += data.length;
    if (compressedBytes > maxBytes) throw new Error('Compressed conversation history exceeds 512 MB.');
    pending = Buffer.concat([pending, data]);
    while (pending.length >= chunkBytes) { const part = pending.subarray(0, chunkBytes); chunks.push({ hash: keepBlob(part), bytes: part.length }); pending = pending.subarray(chunkBytes); }
  } } finally { input.destroy(); compressed.destroy(); }
  if (pending.length) chunks.push({ hash: keepBlob(pending), bytes: pending.length });
  for (const source of sources) {
    const stat = await fs.promises.stat(source.file);
    if (stat.size !== source.stat.size || stat.mtimeMs !== source.stat.mtimeMs || stat.ino !== source.stat.ino) throw new Error('Conversation changed while exporting; it will be retried.');
  }
  return { format: 'codex-rollout-v1', id: logicalId, digest: checksum.digest('hex'), bytes, chunks, attachments: [...attachments.values()], ...(missingImages.size ? { missingImages: missingImages.size } : {}), blobs: [...new Map([...chunks, ...attachments.values()].map(blob => [blob.hash, { hash: blob.hash, bytes: blob.bytes }])).values()] };
}
async function importCodexHistory({ manifest, nativeId = manifest?.id, home, cwd, readBlob, directory }) {
  if (manifest?.format !== 'codex-rollout-v1' || !uuid.test(manifest.id) || !digest.test(manifest.digest) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > maxBytes || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 128 || !Array.isArray(manifest.attachments) || manifest.attachments.length > 500 || !path.isAbsolute(cwd)) throw new Error('Invalid shared conversation snapshot.');
  const blob = async (entry, maximum) => {
    if (!digest.test(entry?.hash) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maximum) throw new Error('Invalid conversation attachment identity or size.');
    const data = await readBlob(entry.hash);
    if (!Buffer.isBuffer(data) || data.length !== entry.bytes || hash(data) !== entry.hash) throw new Error('Conversation attachment checksum does not match.');
    return data;
  };
  if (!uuid.test(nativeId)) throw new Error('Invalid native conversation identity.');
  const attachmentPaths = new Map(); let attachmentBytes = 0;
  home = await fs.promises.realpath(home);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.promises.realpath(directory);
  const imageDirectory = path.join(directory, 'attachments');
  await fs.promises.mkdir(imageDirectory, { recursive: true, mode: 0o700 });
  if (await fs.promises.realpath(imageDirectory) !== imageDirectory) throw new Error('Conversation attachment storage contains a symlink.');
  for (const image of manifest.attachments) {
    const data = await blob(image, maxImage); attachmentBytes += data.length;
    if (attachmentBytes > maxBytes) throw new Error('Conversation image attachments exceed 512 MB.');
    const file = path.join(imageDirectory, image.hash + imageExtension(data));
    await fs.promises.writeFile(file, data, { flag: 'wx', mode: 0o600 }).catch(async error => { if (error.code !== 'EEXIST' || (await fs.promises.lstat(file)).isSymbolicLink() || hash(await fs.promises.readFile(file)) !== image.hash) throw new Error('Cached conversation image checksum does not match.'); });
    attachmentPaths.set(image.hash, file);
  }
  const timestamp = new Date().toISOString().slice(0, 19);
  let storage = home;
  for (const part of ['sessions', ...timestamp.slice(0, 10).split('-')]) {
    storage = path.join(storage, part);
    let stat;
    try {
      stat = await fs.promises.lstat(storage);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.promises.mkdir(storage, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      stat = await fs.promises.lstat(storage);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Conversation history storage contains a symlink or non-directory.');
  }
  const file = path.join(storage, 'rollout-' + timestamp.replaceAll(':', '-') + '-' + nativeId + '_' + randomUUID() + '.jsonl');
  const handle = await fs.promises.open(file + '.tmp', 'wx', 0o600);
  const checksum = createHash('sha256'); let bytes = 0, count = 0;
  const input = Readable.from((async function* () { for (const chunk of manifest.chunks) yield await blob(chunk, chunkBytes); })());
  const inflated = createGunzip(); input.on('error', error => inflated.destroy(error)); input.pipe(inflated);
  try {
    for await (const record of lines(inflated)) {
      const raw = Buffer.from(record.line + '\n'); bytes += raw.length;
      if (bytes > maxBytes || ++count > 1000000) throw new Error('Shared conversation exceeds its size limit.');
      checksum.update(raw); const row = parse(record.line);
      if (count === 1) {
        if (row.type !== 'session_meta' || row.payload?.id !== manifest.id || row.payload.history_base) throw new Error('Shared conversation identity or base does not match.');
        row.payload.cwd = cwd; row.payload.runtime_workspace_roots = [cwd];
        row.payload.id = nativeId; row.payload.session_id = nativeId;
      } else if (row.type === 'session_meta') throw new Error('Shared conversation has duplicate metadata.');
      if (row.type === 'event_msg' && row.payload?.thread_id) row.payload.thread_id = nativeId;
      await transformImages(row, async (reference, url) => {
        if (typeof reference === 'string' && reference.startsWith(missingToken) && digest.test(reference.slice(missingToken.length))) {
          const missing = path.join(imageDirectory, 'missing-' + reference.slice(missingToken.length) + '.png');
          return url ? pathToFileURL(missing).href : missing;
        }
        const result = typeof reference === 'string' && reference.startsWith(token) && attachmentPaths.get(reference.slice(token.length));
        if (!result) throw new Error('Shared conversation image was not included in the snapshot.');
        return url ? pathToFileURL(result).href : result;
      });
      await handle.writeFile(JSON.stringify(row) + '\n');
    }
    if (bytes !== manifest.bytes || checksum.digest('hex') !== manifest.digest) throw new Error('Shared conversation history checksum does not match.');
    await handle.sync(); await handle.close(); await fs.promises.rename(file + '.tmp', file);
    return { path: file, id: nativeId, logicalId: manifest.id };
  } catch (error) {
    input.destroy(); inflated.destroy(); await handle.close().catch(() => {}); await fs.promises.rm(file + '.tmp', { force: true });
    throw new Error(error.code ? 'Could not store shared conversation history.' : error.message);
  }
}
async function* historyRecords(manifest, readBlob) {
  const checksum = createHash('sha256'); let bytes = 0;
  const input = Readable.from((async function* () {
    for (const chunk of manifest.chunks) {
      if (!digest.test(chunk?.hash) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > chunkBytes) throw new Error('Invalid cached conversation chunk.');
      const data = await readBlob(chunk.hash);
      if (!Buffer.isBuffer(data) || data.length !== chunk.bytes || hash(data) !== chunk.hash) throw new Error('Cached conversation checksum does not match.');
      yield data;
    }
  })()), output = createGunzip();
  input.on('error', error => output.destroy(error)); input.pipe(output);
  try {
    for await (const { line, end } of lines(output)) {
      if (end > manifest.bytes) throw new Error('Cached conversation size does not match.');
      checksum.update(line + '\n'); bytes = end; yield line;
    }
    if (bytes !== manifest.bytes || checksum.digest('hex') !== manifest.digest) throw new Error('Cached conversation checksum does not match.');
  } finally { input.destroy(); output.destroy(); }
}
async function extendsCodexHistory({ manifest, base, readBlob, allowImageViewChanges = false }) {
  if (manifest?.format !== 'codex-rollout-v1' || base?.format !== manifest.format || !uuid.test(manifest.id) || base.id !== manifest.id || !digest.test(manifest.digest) || !digest.test(base.digest) || !Number.isSafeInteger(base.bytes) || base.bytes <= 0 || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < base.bytes || manifest.bytes > maxBytes || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 128) return false;
  if (allowImageViewChanges) {
    if (!Array.isArray(base.chunks) || !base.chunks.length || base.chunks.length > 128) return false;
    const attachment = (record, snapshot) => {
      const item = record.payload?.item, file = item?.path;
      return record.type === 'event_msg' && ['item_started', 'item_completed'].includes(record.payload.type) && item?.type === 'ImageView' && typeof file === 'string' && file.startsWith(token) && digest.test(file.slice(token.length)) && snapshot.attachments?.some(image => image.hash === file.slice(token.length));
    };
    const previous = historyRecords(base, readBlob);
    try {
      for await (const line of historyRecords(manifest, readBlob)) {
        const older = await previous.next();
        if (older.done || line === older.value) continue;
        const current = parse(line), original = parse(older.value);
        if (!attachment(current, manifest) || !attachment(original, base)) return false;
        current.payload.item.path = original.payload.item.path;
        if (JSON.stringify(current) !== older.value) return false;
      }
      return (await previous.next()).done;
    } finally { await previous.return(); }
  }
  const checksum = createHash('sha256'), prefix = createHash('sha256'); let bytes = 0;
  const input = Readable.from((async function* () {
    for (const chunk of manifest.chunks) {
      if (!digest.test(chunk?.hash) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > chunkBytes) throw new Error('Invalid cached conversation chunk.');
      const data = await readBlob(chunk.hash);
      if (!Buffer.isBuffer(data) || data.length !== chunk.bytes || hash(data) !== chunk.hash) throw new Error('Cached conversation checksum does not match.');
      yield data;
    }
  })()), output = createGunzip();
  input.on('error', error => output.destroy(error)); input.pipe(output);
  try {
    for await (const data of output) {
      if (bytes + data.length > manifest.bytes) return false;
      checksum.update(data);
      if (bytes < base.bytes) prefix.update(data.subarray(0, Math.min(data.length, base.bytes - bytes)));
      bytes += data.length;
    }
    return bytes === manifest.bytes && checksum.digest('hex') === manifest.digest && prefix.digest('hex') === base.digest;
  } finally { input.destroy(); output.destroy(); }
}
module.exports = { exportCodexHistory, importCodexHistory, extendsCodexHistory, CodexAttachmentStore };

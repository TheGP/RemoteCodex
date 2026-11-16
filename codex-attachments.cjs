const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { hash } = require('./sync-state.cjs');

const maxImage = 20 * 1024 * 1024;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f\x7f]/.test(value);
function imageExtension(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return '.jpg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return '.gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  throw new Error('Conversation attachment is not a supported image.');
}
function readCodexImage(file, { home, cwd, selected = false, attachmentRoots = [] }) {
  if (typeof file !== 'string' || !file || file.length > 8192 || /[\x00-\x1f\x7f]/.test(file)) throw new Error('Invalid conversation image reference.');
  if (file.startsWith('file://')) file = fileURLToPath(file);
  home = fs.realpathSync(home);
  const real = fs.realpathSync(file), workspace = !selected && cwd && fs.realpathSync(cwd);
  const cached = attachmentRoots.some(root => {
    try { return fs.realpathSync(root) === root && inside(root, real); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  });
  if (!selected && !cached && !inside(home, real) && (!workspace || !inside(workspace, real))) throw new Error('Conversation image is outside its allowed folders.');
  const relative = path.relative(home, real).split(path.sep);
  if (inside(home, real) && relative.length === 1 || relative.some(part => /^(?:auth|config|credentials|tokens)(?:[._-]|$)/i.test(part)) || /\.(?:sqlite|sqlite3|db|toml)$/i.test(real)) throw new Error('Account and configuration files cannot be conversation attachments.');
  const descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxImage) throw new Error('Conversation image exceeds 20 MB or is not a regular file.');
    const data = Buffer.alloc(before.size + 1); let length = 0, count;
    while (length < data.length && (count = fs.readSync(descriptor, data, length, data.length - length, null))) length += count;
    const after = fs.fstatSync(descriptor);
    if (length > maxImage || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Conversation image changed while being captured.');
    const bytes = data.subarray(0, length); imageExtension(bytes);
    return { data: bytes, name: path.basename(real) };
  } finally { fs.closeSync(descriptor); }
}
class CodexAttachmentStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  folder(name) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Conversation attachment storage contains a symlink.');
    const root = fs.realpathSync(this.directory), directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory) throw new Error('Conversation attachment storage contains a symlink.');
    return directory;
  }
  identity({ threadId, turnId = '', itemId }) {
    if (!validId(threadId) || !validId(itemId) || turnId !== '' && !validId(turnId)) throw new Error('Invalid conversation image identity.');
    return JSON.stringify([threadId, itemId]);
  }
  publish(directory, name, data) {
    const file = path.join(directory, name), temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    finally { fs.unlinkSync(temporary); }
    if (process.platform !== 'win32') {
      const folder = fs.openSync(directory, 'r');
      try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
    }
  }
  get(identity) {
    const key = this.identity(identity), file = path.join(this.folder('events'), hash(key) + '.json');
    let saved;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid captured conversation image.');
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (saved.identity !== key || !/^[a-f0-9]{64}$/.test(saved.hash) || !Number.isSafeInteger(saved.bytes) || saved.bytes <= 0 || saved.bytes > maxImage || !['.png', '.jpg', '.gif', '.webp'].includes(saved.extension) || typeof saved.name !== 'string') throw new Error('Invalid captured conversation image.');
    const blob = path.join(this.folder('blobs'), saved.hash + saved.extension);
    let data;
    try {
      const stat = fs.lstatSync(blob);
      if (!stat.isFile() || stat.size !== saved.bytes) throw new Error('Captured conversation image checksum does not match.');
      data = fs.readFileSync(blob);
    } catch (error) { if (error.code === 'ENOENT') throw new Error('Captured conversation image is missing.'); throw error; }
    if (hash(data) !== saved.hash || imageExtension(data) !== saved.extension) throw new Error('Captured conversation image checksum does not match.');
    return { data, name: saved.name };
  }
  remember(identity, image) {
    const previous = this.get(identity); if (previous) return previous;
    const key = this.identity(identity), id = hash(image.data), extension = imageExtension(image.data);
    if (image.data.length > maxImage) throw new Error('Conversation image exceeds 20 MB.');
    this.publish(this.folder('blobs'), id + extension, image.data);
    this.publish(this.folder('events'), hash(key) + '.json', JSON.stringify({ identity: key, hash: id, bytes: image.data.length, extension, name: image.name }));
    return this.get(identity);
  }
  capture({ threadId, turnId = '', item, ...options }) {
    if (!['ImageView', 'imageView'].includes(item?.type) || typeof item.path !== 'string' || !validId(item.id)) return null;
    const identity = { threadId, turnId, itemId: item.id }, previous = this.get(identity);
    return previous || this.remember(identity, readCodexImage(item.path, { ...options, selected: true }));
  }
}
module.exports = { CodexAttachmentStore, readCodexImage, imageExtension };

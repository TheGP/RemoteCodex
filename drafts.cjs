const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const hours = new Set([0, ...Array.from({ length: 24 }, (_, index) => index + 1), 48, 72, 96, 120, 144, 168]);
const hash = value => createHash('sha256').update(value).digest('hex');

function normalizeTarget(target) {
  if (!target || typeof target.machine !== 'string' || !target.machine.startsWith('access:') || target.machine.length > 500 || !['composer', 'edit-message', 'edit-queue', 'edit-schedule'].includes(target.kind) || typeof target.cwd !== 'string' || target.cwd.length > 4096 || target.cwd.includes('\0')) throw new Error('Invalid draft target.');
  for (const key of ['threadId', 'projectId', 'itemId']) if (target[key] != null && (typeof target[key] !== 'string' || !target[key] || target[key].length > 200)) throw new Error('Invalid draft target.');
  if (target.kind !== 'composer' && (!target.threadId || !target.itemId)) throw new Error('Invalid editor draft target.');
  return { machine: target.machine, kind: target.kind, cwd: target.cwd, threadId: target.threadId || null, projectId: target.projectId || null, itemId: target.itemId || null };
}
function draftKey(target) {
  const value = normalizeTarget(target);
  return JSON.stringify([value.machine, value.kind, value.threadId || [value.cwd, value.projectId], value.itemId]);
}

class DraftStore {
  constructor(directory) { this.directory = directory; this.lastTargets = new Map(); }
  list() {
    let files;
    try { files = fs.readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(file => /^[a-f0-9]{64}$/.test(file)).map(file => {
      let value;
      try { value = JSON.parse(fs.readFileSync(path.join(this.directory, file, 'draft.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (hash(draftKey(value.target)) !== file) throw new Error('Invalid saved draft identity.');
      return this.metadata(value.target);
    }).filter(Boolean);
  }
  folder(target) { return path.join(this.directory, hash(draftKey(target))); }
  write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  }
  parseMetadata(target, text) {
    const value = JSON.parse(text);
    if (value.version !== 1 || draftKey(value.target) !== draftKey(target) || typeof value.text !== 'string' || !Array.isArray(value.images)) throw new Error('Invalid saved draft.');
    return value;
  }
  metadata(target) {
    try { return this.parseMetadata(target, fs.readFileSync(path.join(this.folder(target), 'draft.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async indicators(machine, threadIds, onError = () => {}) {
    const pending = [];
    for (let offset = 0; offset < threadIds.length; offset += 100) {
      const present = await Promise.all(threadIds.slice(offset, offset + 100).map(async threadId => {
        const target = { machine, kind: 'composer', threadId, cwd: '' };
        try {
          const value = this.parseMetadata(target, await fs.promises.readFile(path.join(this.folder(target), 'draft.json'), 'utf8'));
          return value.text.trim() || value.images.length ? threadId : null;
        } catch (error) {
          if (error.code !== 'ENOENT') onError(error);
          return null;
        }
      }));
      pending.push(...present.filter(Boolean));
    }
    return pending;
  }
  remember(target) {
    target = normalizeTarget(target); const signature = JSON.stringify(target);
    if (this.lastTargets.get(target.machine) === signature) return;
    this.write(path.join(this.directory, `last-${hash(target.machine)}.json`), target); this.lastTargets.set(target.machine, signature);
  }
  read(target) {
    const value = this.metadata(target);
    if (!value) return null;
    return { ...value, images: value.images.map(image => {
      if (!image || !Object.hasOwn(mimeExtensions, image.mime) || !/^image-[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(image.file)) throw new Error('Invalid saved draft image.');
      const data = fs.readFileSync(path.join(this.folder(target), image.file));
      return { name: image.name, size: data.length, url: `data:${image.mime};base64,${data.toString('base64')}` };
    }) };
  }
  last(machine) {
    try {
      const target = normalizeTarget(JSON.parse(fs.readFileSync(path.join(this.directory, `last-${hash(machine)}.json`), 'utf8')));
      if (target.machine !== machine) throw new Error('Invalid draft machine.');
      const draft = this.read(target); return draft ? { target, draft } : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  save(target, patch) {
    target = normalizeTarget(target);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['text', 'images', 'hours', 'model', 'effort', 'mode', 'access', 'runAt'].includes(key))) throw new Error('Invalid draft change.');
    if ('runAt' in patch && (typeof patch.runAt !== 'string' || patch.runAt.length > 40 || patch.runAt && !Number.isFinite(Date.parse(patch.runAt)))) throw new Error('Invalid draft date.');
    if ('text' in patch && typeof patch.text !== 'string' || 'hours' in patch && !hours.has(patch.hours) || 'mode' in patch && !['default', 'plan'].includes(patch.mode) || 'access' in patch && !['read-only', 'workspace-write', 'danger-full-access'].includes(patch.access)) throw new Error('Invalid draft settings.');
    for (const key of ['model', 'effort']) if (key in patch && (typeof patch[key] !== 'string' || patch[key].length > 200)) throw new Error('Invalid draft settings.');
    const previous = this.metadata(target) || { version: 1, target, text: '', images: [] };
    const value = { ...previous, ...patch, target, updatedAt: Date.now() };
    const folder = this.folder(target);
    if ('images' in patch) {
      if (!Array.isArray(patch.images) || patch.images.length > 10) throw new Error('Invalid draft images.');
      let total = 0;
      value.images = patch.images.map(image => {
        const match = typeof image?.url === 'string' && image.url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/]+={0,2})$/);
        if (!match || typeof image.name !== 'string' || image.name.length > 500) throw new Error('Invalid draft image.');
        const data = Buffer.from(match[2], 'base64'); total += data.length;
        if (total > 20 * 1024 * 1024) throw new Error('Draft images exceed 20 MB.');
        const file = `image-${hash(data)}.${mimeExtensions[match[1]]}`;
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        if (!fs.existsSync(path.join(folder, file))) fs.writeFileSync(path.join(folder, file), data, { mode: 0o600 });
        return { name: image.name, size: data.length, mime: match[1], file };
      });
    }
    const empty = target.kind === 'composer' && !value.text && !value.images.length;
    if (empty) this.clear(target);
    else {
      this.write(path.join(folder, 'draft.json'), value);
      const used = new Set(value.images.map(image => image.file));
      for (const file of fs.readdirSync(folder)) if (/^image-[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(file) && !used.has(file)) {
        try { fs.unlinkSync(path.join(folder, file)); } catch (error) { if (error.code !== 'ENOENT') console.error('Could not remove old draft image:', error.message); }
      }
    }
    this.remember(target);
    return empty ? null : value;
  }
  clear(target) { fs.rmSync(this.folder(target), { recursive: true, force: true }); }
  move(source, target) {
    if (draftKey(source) === draftKey(target)) return;
    const saved = this.read(source);
    if (!saved) return;
    const patch = { text: saved.text, images: saved.images };
    for (const key of ['hours', 'model', 'effort', 'mode', 'access']) if (saved[key] !== undefined) patch[key] = saved[key];
    this.save(target, patch);
    this.clear(source);
  }
}

function registerDraftIpc(ipcMain, drafts, checkSender, onError = () => {}, changed = () => {}) {
  const autosaves = new WeakMap();
  const request = (operation, event, target, patch, expected, writeId, deferred = false) => {
    try {
      checkSender(event);
      let value, stale = false, write;
      if (deferred || writeId !== undefined) {
        if (operation !== 'save-draft' || target?.kind !== 'composer' || typeof writeId !== 'string' || !/^[a-f0-9-]{36}$/.test(writeId)) throw new Error('Invalid draft write.');
        const key = draftKey(target);
        if (!autosaves.has(event.sender)) autosaves.set(event.sender, { cancelled: new Set(), last: null });
        const writes = autosaves.get(event.sender);
        if (deferred) {
          if (writes.cancelled.delete(writeId)) return { value: false };
          write = writes.last = { id: writeId, key };
        } else if (writes.last?.id === writeId && writes.last.key === key) {
          expected = writes.last.expected ?? expected;
          writes.last = null;
        } else {
          // A forced save can arrive before the pending asynchronous write.
          writes.cancelled.add(writeId);
        }
      }
      if (['save-draft', 'clear-draft'].includes(operation) && expected !== undefined) {
        if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !['text', 'runAt', 'hours', 'model', 'effort', 'mode', 'access'].includes(key)) || !Object.hasOwn(expected, 'text') || Object.entries(expected).some(([key, value]) => value !== null && (key === 'hours' ? !hours.has(value) : typeof value !== 'string'))) throw new Error('Invalid editor draft baseline.');
        const previous = drafts.metadata(target);
        stale = Object.entries(expected).some(([key, value]) => (previous?.[key] ?? null) !== value);
      }
      if (operation === 'read-draft') { value = drafts.read(target); if (target.kind === 'composer') drafts.remember(target); }
      else if (operation === 'save-draft') {
        const saved = drafts.save(target, patch);
        if (deferred && write && expected) write.expected = Object.fromEntries(Object.keys(expected).map(key => [key, saved?.[key] ?? null]));
        value = true;
      }
      else if (operation === 'clear-draft') { drafts.clear(target); if (target.kind !== 'composer') drafts.remember({ ...target, kind: 'composer', itemId: null }); }
      else if (operation === 'move-draft') drafts.move(target, patch);
      else value = drafts.last(target);
      if (['save-draft', 'clear-draft', 'move-draft'].includes(operation)) {
        if (operation === 'move-draft') changed(patch);
        changed(target, stale);
      }
      return { value };
    } catch (error) { onError(error); return { error: error.message }; }
  };
  for (const operation of ['read-draft', 'save-draft', 'clear-draft', 'last-draft', 'move-draft']) ipcMain.on(operation, (event, ...args) => {
    event.returnValue = request(operation, event, ...args);
  });
  ipcMain.handle('autosave-draft', (event, target, patch, expected, writeId) => request('save-draft', event, target, patch, expected, writeId, true));
  ipcMain.handle('draft-indicators', (event, machine, ids) => {
    checkSender(event);
    if (typeof machine !== 'string' || !machine.startsWith('access:') || machine.length > 500 || !Array.isArray(ids)
        || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid draft indicators.');
    return drafts.indicators(machine, ids, onError);
  });
}

module.exports = { DraftStore, draftKey, registerDraftIpc };

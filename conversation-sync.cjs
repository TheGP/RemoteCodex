const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { stateKey, hash, blobGraceMs } = require('./sync-state.cjs');
const { writePrivate } = require('./shared-schedules.cjs');

class ConversationSync {
  constructor({ directory, shared, apply, changed = () => {}, log = () => {} }) {
    Object.assign(this, { directory, shared, apply, changed, log });
    this.namespace = null; this.running = false; this.error = null;
  }
  load() {
    if (this.namespace === this.shared.key) return;
    if (this.state?.pending.length) throw new Error('Finish syncing conversation changes before choosing another server or folder.');
    this.namespace = this.shared.key;
    this.file = path.join(this.directory, hash(this.namespace) + '.json');
    this.state = { version: 1, cursor: 0, entries: {}, pending: [], conflicts: {}, bindings: {}, seeded: false };
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.pending) || !value.entries || !value.conflicts || !value.bindings) throw new Error('Invalid saved conversation sync state.');
      this.state = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    delete this.state.blobs;
    try {
      const outbox = JSON.parse(fs.readFileSync(this.file + '.outbox', 'utf8'));
      if (!Number.isSafeInteger(outbox.sequence) || !Array.isArray(outbox.pending) || !outbox.conflicts) throw new Error('Invalid saved conversation outbox.');
      if (outbox.sequence > (this.state.sequence || 0)) Object.assign(this.state, outbox);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() {
    this.dirty = true; this.state.sequence = (this.state.sequence || 0) + 1;
    writePrivate(this.file, this.state); this.dirty = false;
    try { fs.unlinkSync(this.file + '.outbox'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  savePending() {
    this.dirty = true; this.state.sequence = (this.state.sequence || 0) + 1;
    writePrivate(this.file + '.outbox', { sequence: this.state.sequence, pending: this.state.pending, conflicts: this.state.conflicts });
    this.dirty = false;
  }
  pending() { this.load(); return this.state.pending.length > 0; }
  entries(kind, machine) {
    this.load(); return Object.values(this.state.entries).filter(entry => entry.kind === kind && (!machine || entry.machine === machine) && entry.value !== null);
  }
  canCapture() {
    this.load();
    return this.shared.enabled || fs.existsSync(this.file) || fs.existsSync(this.file + '.outbox');
  }
  capture(kind, machine, id, value, seed = false, observedTurn, stale = false) {
    if (!this.canCapture()) return;
    this.load();
    const key = stateKey(kind, machine, id), current = this.state.entries[key];
    const previous = this.state.pending.findLast(op => op.key === key);
    if (seed && (current || previous) || !previous && isDeepStrictEqual(current?.value ?? null, value)) return;
    const op = { kind, machine, id, key, opId: randomUUID(), base: previous ? null : current?.revision || 0, value: structuredClone(value), seed, ...(observedTurn ? { observedTurn } : {}) };
    if (stale || previous?.stale) op.stale = true;
    if (previous && !previous.sent) {
      op.base = previous.base; if (previous.parent) op.parent = previous.parent;
      this.state.pending[this.state.pending.indexOf(previous)] = op;
    } else { if (previous) op.parent = previous.opId; this.state.pending.push(op); }
    this.savePending(); this.soon();
  }
  soon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(error => this.failed(error)), 500); this.timer.unref();
  }
  failed(error) { this.error = error.message; this.log('conversation.sync.failed', { error: error.message }); this.changed(); }
  blobFile(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid draft attachment identity.');
    return path.join(this.directory, 'blobs', id);
  }
  keepBlob(data) {
    const id = hash(data), file = this.blobFile(id);
    if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== id) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(file + '.tmp', 'w', 0o600);
      try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(file + '.tmp', file);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    }
    return id;
  }
  pruneBlobs(now = Date.now()) {
    if (this.nextBlobGc && now < this.nextBlobGc) return;
    if (!fs.existsSync(this.directory)) { this.nextBlobGc = now + blobGraceMs; return; }
    const refs = new Set();
    const remember = value => { for (const image of value?.images || []) refs.add(image.hash); };
    const rememberState = state => {
      for (const entry of Object.values(state.entries || {})) remember(entry.value);
      for (const op of state.pending || []) remember(op.value);
      for (const conflict of Object.values(state.conflicts || {})) remember(conflict.remote?.value);
    };
    rememberState(this.state);
    for (const file of fs.readdirSync(this.directory)) if (/^[a-f0-9]{64}\.json(?:\.outbox)?$/.test(file)) rememberState(JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8')));
    const directory = path.join(this.directory, 'blobs');
    if (fs.existsSync(directory)) for (const file of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}(?:\.tmp)?$/.test(file) || refs.has(file.slice(0, 64))) continue;
      const target = path.join(directory, file), stat = fs.lstatSync(target);
      if (stat.isFile() && stat.mtimeMs < now - blobGraceMs) fs.unlinkSync(target);
    }
    this.nextBlobGc = now + blobGraceMs;
  }
  async images(value, download = false) {
    const result = []; let bytes = 0;
    if (!Array.isArray(value?.images || []) || value?.images?.length > 10) throw new Error('Invalid shared draft attachments.');
    for (const image of value?.images || []) {
      const file = this.blobFile(image.hash);
      if (download && !fs.existsSync(file)) {
        const blob = await this.shared.bridge.call('blob-get', { hash: image.hash });
        const data = Buffer.from(blob.data, 'base64');
        if (data.length > 20 * 1024 * 1024 || hash(data) !== image.hash) throw new Error('Shared attachment checksum does not match.');
        this.keepBlob(data);
      }
      const data = fs.readFileSync(file);
      if (hash(data) !== image.hash) { fs.unlinkSync(file); throw new Error('Cached draft attachment checksum does not match.'); }
      bytes += data.length;
      if (bytes > 20 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime)) throw new Error('Shared draft attachments exceed their size or type limits.');
      result.push({ name: image.name, url: `data:${image.mime};base64,${data.toString('base64')}` });
    }
    return result;
  }
  async applyEntry(entry) {
    if ((this.state.entries[entry.key]?.revision || 0) > entry.revision) return false;
    const pending = this.state.pending.some(op => op.key === entry.key);
    if (this.state.conflicts[entry.key]) this.state.conflicts[entry.key] = { remote: entry };
    if (pending || this.state.conflicts[entry.key]) { this.state.entries[entry.key] = entry; return false; }
    const applied = await this.apply(entry, this);
    if ((this.state.entries[entry.key]?.revision || 0) <= entry.revision) this.state.entries[entry.key] = entry;
    return applied;
  }
  async tick() {
    if (!this.shared.enabled || this.running) return;
    this.load(); this.running = true;
    const namespace = this.namespace;
    try {
      if (this.dirty) this.save();
      await this.shared.online();
      if (namespace !== this.shared.key) throw new Error('Conversation sync destination changed.');
      let changed = false;
      const operations = this.state.pending.filter(op => Number.isSafeInteger(op.base) && !this.state.conflicts[op.key]).slice(0, 50);
      if (operations.length) {
        for (const op of operations) op.sent = true;
        this.save();
        const hashes = [...new Set(operations.flatMap(op => (op.value?.images || []).map(image => image.hash)))];
        if (hashes.length) {
          const { missing } = await this.shared.bridge.call('blob-prepare', { hashes });
          for (const id of missing) await this.shared.bridge.call('blob-put', { hash: id, data: fs.readFileSync(this.blobFile(id)).toString('base64') });
        }
        this.save();
        const results = await this.shared.bridge.call('state-push', { operations });
        for (const result of results) {
          const op = this.state.pending.find(op => op.opId === result.opId);
          if (!op) continue;
          if (result.conflict || result.seeded && ['draft', 'shortcuts'].includes(op.kind) && !isDeepStrictEqual(op.value, result.current?.value)) {
            if (['unread', 'completion'].includes(op.kind)) {
              this.state.pending = this.state.pending.filter(item => item !== op);
              for (const next of this.state.pending) if (next.parent === op.opId) { next.base = result.current?.revision || 0; delete next.parent; }
              if (result.current) await this.applyEntry(result.current);
            } else {
              this.state.conflicts[op.key] = { remote: result.current };
              if (result.current?.value?.images?.length) await this.images(result.current.value, true);
            }
          } else {
            this.state.pending = this.state.pending.filter(item => item !== op);
            for (const next of this.state.pending) if (next.parent === op.opId) { next.base = result.revision; delete next.parent; }
            if (result.current) await this.applyEntry(result.current);
          }
          changed = true;
        }
        this.save();
      }
      let more;
      do {
        const page = await this.shared.bridge.call('state-pull', { cursor: this.state.cursor });
        for (const entry of page.entries) { await this.applyEntry(entry); changed = true; }
        if (page.cursor !== this.state.cursor) { this.state.cursor = page.cursor; this.save(); }
        more = page.more;
      } while (more);
      if (this.dirty) this.save();
      const recovered = Boolean(this.error); this.error = null;
      try { this.pruneBlobs(); } catch (error) { this.log('conversation.blob-cleanup.failed', { error: error.message }); }
      if (changed || recovered) this.changed();
      if (this.state.pending.some(op => Number.isSafeInteger(op.base) && !this.state.conflicts[op.key])) this.soon();
    } finally { this.running = false; }
  }
  async resolve(key, choice, version) {
    this.load(); const saved = this.state.conflicts[key];
    if (!saved || !['local', 'remote'].includes(choice)) throw new Error('This draft conflict is no longer available.');
    const conflict = saved.remote;
    const pending = this.state.pending.filter(op => op.key === key), latest = pending.at(-1);
    if (!latest) throw new Error('Local draft was not found.');
    if (version && version !== JSON.stringify([conflict?.revision || 0, latest.opId])) throw new Error('The versions changed. Review the updated conflict before choosing.');
    this.state.pending = this.state.pending.filter(op => op.key !== key); delete this.state.conflicts[key];
    if (conflict) this.state.entries[key] = conflict; else delete this.state.entries[key];
    try {
      if (choice === 'local') this.capture(latest.kind, latest.machine, latest.id, latest.value);
      else {
        this.save();
        await this.applyEntry(conflict || { key, kind: latest.kind, machine: latest.machine, id: latest.id, value: null, revision: 0 });
      }
    } catch (error) {
      this.state.pending = [...pending, ...this.state.pending.filter(op => op.key !== key || !pending.some(previous => previous.opId === op.opId))];
      this.state.conflicts[key] = saved; this.save(); throw error;
    }
    this.save(); this.changed(); this.soon();
  }
  conflicts() {
    this.load(); return Object.entries(this.state.conflicts).map(([key, conflict]) => {
      const latest = this.state.pending.findLast(op => op.key === key);
      return { key, remote: conflict.remote, local: latest?.value, version: JSON.stringify([conflict.remote?.revision || 0, latest?.opId]) };
    });
  }
  async hydrate() {
    this.load(); for (const entry of Object.values(this.state.entries)) await this.applyEntry(entry);
    this.changed();
  }
  close() { clearTimeout(this.timer); }
}
module.exports = { ConversationSync };

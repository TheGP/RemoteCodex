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
    if (this.normalizeQueue()) this.savePending();
  }
  normalizeQueue() {
    const before = JSON.stringify(this.state.pending), ids = new Map(), roots = new Map();
    this.state.pending = this.state.pending.map(op => op && typeof op === 'object' && !Array.isArray(op) ? op : { original: op });
    const failures = new Map();
    for (const op of this.state.pending) {
      try {
        const key = stateKey(op.kind, op.machine, op.id);
        if (!op.key) op.key = key;
        if (op.key !== key || typeof op.opId !== 'string' || !op.opId || op.opId.length > 1000 || /[\x00-\x1f\x7f]/.test(op.opId) || op.value === undefined) throw new Error('Invalid saved conversation edit.');
        const lists = [op.value?.images, op.value?.blobs];
        if (lists.some(list => list !== undefined && !Array.isArray(list)) || lists.flatMap(list => list || []).some(blob => !blob || typeof blob.hash !== 'string' || !/^[a-f0-9]{64}$/.test(blob.hash))) throw new Error('Invalid saved conversation attachments.');
        if (op.blobError) {
          try { if (hash(fs.readFileSync(this.blobFile(op.blobError))) === op.blobError) { delete op.error; delete op.blobError; } } catch {}
        }
        if (ids.has(op.opId)) { failures.set(ids.get(op.opId), 'Duplicate saved edit identity.'); throw new Error('Duplicate saved edit identity.'); }
        ids.set(op.opId, op);
      } catch (error) { failures.set(op, error.message); }
      if (!op.parent && op.key) {
        if (roots.has(op.key)) failures.set(op, 'Saved edits have no verified parent link.'); else roots.set(op.key, op);
      }
    }
    const check = (op, seen = new Set()) => {
      if (failures.has(op)) return failures.get(op);
      if (seen.has(op)) return 'Saved edits have a cyclic parent link.';
      if (seen.size >= 1000) return 'Saved edit chain is too long to verify.';
      if (op.error) return op.error;
      if (!op.parent) return Number.isSafeInteger(op.base) && op.base >= 0 ? null : 'Saved edit has no verified server revision.';
      const parent = ids.get(op.parent);
      if (!parent || parent.key !== op.key) return 'Saved edit’s parent is missing or belongs to another conversation.';
      op.base = null;
      seen.add(op); return check(parent, seen);
    };
    for (const op of this.state.pending) {
      const failure = check(op);
      if (failure) op.invalid = failure; else delete op.invalid;
    }
    return before !== JSON.stringify(this.state.pending);
  }
  queueErrors() {
    this.load(); return this.state.pending.filter(op => op.invalid || op.error).map(op => ({ key: op.key, kind: op.kind, machine: op.machine, id: op.id, message: op.invalid || op.error }));
  }
  save(state = this.state, file = this.file) {
    if (state === this.state) this.dirty = true;
    state.sequence = (state.sequence || 0) + 1;
    writePrivate(file, state);
    if (state === this.state) this.dirty = false;
    try { fs.unlinkSync(file + '.outbox'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  savePending() {
    const dirty = this.dirty;
    this.dirty = true; this.state.sequence = (this.state.sequence || 0) + 1;
    writePrivate(this.file + '.outbox', { sequence: this.state.sequence, pending: this.state.pending, conflicts: this.state.conflicts });
    this.dirty = dirty;
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
    if (previous && (!previous.sent || previous.error)) {
      op.base = previous.base; if (previous.parent) op.parent = previous.parent;
      this.state.pending[this.state.pending.indexOf(previous)] = op;
    } else { if (previous) op.parent = previous.opId; this.state.pending.push(op); }
    this.savePending(); this.soon();
  }
  soon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(error => this.failed(error)), 500); this.timer.unref();
  }
  failed(error) { if (error.code === 'SYNC_DESTINATION_CHANGED') return; this.error = error.message; this.log('conversation.sync.failed', { error: error.message }); this.changed(); }
  checkState(state, namespace) {
    if (state !== this.state || namespace !== this.namespace || namespace !== this.shared.key) throw Object.assign(new Error('Conversation sync destination changed.'), { code: 'SYNC_DESTINATION_CHANGED' });
  }
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
    const remember = value => { for (const image of [...value?.images || [], ...value?.blobs || []]) refs.add(image.hash); };
    const rememberState = state => {
      for (const entry of Object.values(state.entries || {})) remember(entry.value);
      for (const op of state.pending || []) remember(op.value);
      for (const conflict of Object.values(state.conflicts || {})) remember(conflict.remote?.value);
      for (const record of Object.values(state.localHistory || {})) for (const snapshot of record.preservedSnapshots || []) remember(snapshot.manifest);
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
    const state = this.state, namespace = this.namespace;
    const result = []; let bytes = 0;
    if (!Array.isArray(value?.images || []) || value?.images?.length > 10) throw new Error('Invalid shared draft attachments.');
    for (const image of value?.images || []) {
      const file = this.blobFile(image.hash);
      if (download && !fs.existsSync(file)) {
        const blob = await this.shared.bridge.call('blob-get', { hash: image.hash });
        this.checkState(state, namespace);
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
    const state = this.state, namespace = this.namespace;
    this.checkState(state, namespace);
    if ((state.entries[entry.key]?.revision || 0) > entry.revision) return false;
    const pending = state.pending.some(op => op.key === entry.key);
    if (state.conflicts[entry.key]) state.conflicts[entry.key] = { remote: entry };
    if (pending || state.conflicts[entry.key]) { state.entries[entry.key] = entry; return false; }
    const applied = await this.apply(entry, this);
    this.checkState(state, namespace);
    if ((state.entries[entry.key]?.revision || 0) <= entry.revision) state.entries[entry.key] = entry;
    return applied;
  }
  async tick() {
    if (!this.shared.enabled || this.running) return;
    this.load(); this.running = true;
    const namespace = this.namespace, state = this.state;
    const current = () => this.checkState(state, namespace);
    try {
      if (this.dirty) this.save();
      await this.shared.online();
      current();
      let changed = false;
      if (this.normalizeQueue()) this.savePending();
      const ready = () => this.state.pending.filter(op => !op.parent && !op.invalid && !op.error && Number.isSafeInteger(op.base) && !this.state.conflicts[op.key]);
      const attachments = op => [...op.value?.images || [], ...op.value?.blobs || []];
      const small = () => ready().filter(op => op.kind !== 'history' && !attachments(op).length).slice(0, 50);
      const push = async operations => {
        current();
        if (!operations.length) return;
        for (const op of operations) op.sent = true;
        this.save();
        const results = await this.shared.bridge.call('state-push', { operations, isolateErrors: true });
        current();
        for (const result of results) {
          const op = this.state.pending.find(op => op.opId === result.opId);
          if (!op) continue;
          if (result.error) { op.error = result.error; changed = true; continue; }
          if (result.conflict || result.seeded && ['draft', 'shortcuts', 'history', 'note'].includes(op.kind) && !isDeepStrictEqual(op.value, result.current?.value)) {
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
          current();
          changed = true;
        }
        this.save();
      };
      const pull = async () => {
        let more;
        do {
          current();
          const page = await this.shared.bridge.call('state-pull', { cursor: this.state.cursor });
          current();
          for (const entry of page.entries) { await this.applyEntry(entry); current(); changed = true; }
          if (page.cursor !== this.state.cursor) { this.state.cursor = page.cursor; this.save(); }
          more = page.more;
        } while (more);
      };
      await push(small()); await pull();
      let uploaded = 0;
      for (const op of ready().filter(op => op.kind === 'history' || attachments(op).length).slice(0, 5)) {
        if (!this.state.pending.includes(op) || this.state.conflicts[op.key]) continue;
        op.sent = true; this.save();
        const hashes = [...new Set(attachments(op).map(image => image.hash))];
        let unavailable = false, yielded = false;
        for (let offset = 0; offset < hashes.length; offset += 500) {
          const { missing } = await this.shared.bridge.call('blob-prepare', { hashes: hashes.slice(offset, offset + 500) });
          current();
          for (const id of missing) {
            if (uploaded >= 4) { yielded = true; break; }
            let data;
            try {
              data = fs.readFileSync(this.blobFile(id));
              if (hash(data) !== id) throw new Error('Cached conversation attachment checksum does not match.');
            } catch (error) { op.error = error.message; op.blobError = id; changed = unavailable = true; this.save(); break; }
            await this.shared.bridge.call('blob-put', { hash: id, data: data.toString('base64') });
            current();
            uploaded++;
            await push(small()); await pull();
          }
          if (unavailable || yielded) break;
        }
        if (!unavailable && !yielded) await push([op]);
        await push(small()); await pull();
        if (yielded) break;
      }
      if (this.dirty) this.save();
      const recovered = Boolean(this.error); this.error = null;
      try { this.pruneBlobs(); } catch (error) { this.log('conversation.blob-cleanup.failed', { error: error.message }); }
      if (changed || recovered) this.changed();
      if (ready().length) this.soon();
    } finally { this.running = false; }
  }
  async resolve(key, choice, version, afterRemote) {
    this.load(); const state = this.state, namespace = this.namespace, file = this.file, saved = state.conflicts[key];
    const current = () => this.checkState(state, namespace);
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
        current();
        if (afterRemote) await afterRemote();
        current();
      }
    } catch (error) {
      state.pending = [...pending, ...state.pending.filter(op => op.key !== key || !pending.some(previous => previous.opId === op.opId))];
      state.conflicts[key] = saved; this.save(state, file); throw error;
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
    this.load(); const state = this.state, namespace = this.namespace;
    for (const entry of Object.values(state.entries)) { await this.applyEntry(entry); this.checkState(state, namespace); }
    this.changed();
  }
  close() { clearTimeout(this.timer); }
}
module.exports = { ConversationSync };

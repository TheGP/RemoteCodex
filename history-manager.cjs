const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { exportCodexHistory, importCodexHistory, extendsCodexHistory, CodexAttachmentStore } = require('./codex-history.cjs');
const { stateKey, hash } = require('./sync-state.cjs');

class HistoryManager {
  constructor(state) { this.state = state; this.queue = new Map(); this.owners = new Map(); this.importing = new Map(); this.starting = new Set(); this.completionThreads = new Map(); this.runs = new Map(); this.completedTurns = new Map(); this.errors = new Map(); this.repairAttempts = new Map(); this.forced = new Set(); }
  get attachmentStore() { return this.attachments ||= new CodexAttachmentStore(path.join(this.state.sync.directory, 'attachment-events')); }
  captureAttachment(message) {
    if ((message.provider || 'codex') !== 'codex' || this.state.options().mode !== 'local') return;
    const { threadId, turnId, item } = message.params || {};
    if (threadId && ['item/started', 'item/completed'].includes(message.method) && ['imageView', 'ImageView'].includes(item?.type)) this.attachmentStore.capture({ threadId: this.record(threadId)?.nativeId || threadId, turnId, item, home: this.home });
  }
  get enabled() { return this.state.shared.enabled && this.state.connection.ready && (!this.state.connection.describe || this.state.connection.describe('codex').connected) && this.state.options().mode === 'local' && this.state.connection.supports('thread/list', 'codex'); }
  get home() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }
  get nativeSession() { return this.state.connection.connections?.get('codex')?.session || this.state.connection.session; }
  context() {
    const { sync, shared } = this.state; sync.load();
    const key = JSON.stringify([shared.key, this.state.machine()]);
    if (this.key !== key) { this.key = key; this.owners.clear(); this.queue.clear(); this.errors.clear(); this.repairAttempts.clear(); this.forced.clear(); this.cursor = null; this.scanned = false;
      for (const op of sync.state.pending) if (op.kind === 'history' && op.machine === this.state.machine()) this.queue.set(op.id, { id: op.id }); }
    sync.state.localHistory ||= {};
    if (this.aliasSession !== this.state.connection.session || this.aliasNativeSession !== this.nativeSession || this.aliasKey !== key) {
      this.starting.clear(); this.runs.clear(); this.completionThreads.clear(); this.completedTurns.clear();
      this.state.connection.setThreadAliases?.(sync.state.localHistory);
      this.aliasSession = this.state.connection.session; this.aliasNativeSession = this.nativeSession; this.aliasKey = key;
    }
    return { key, machine: this.state.machine(), namespace: shared.key, session: this.state.connection.session, nativeSession: this.nativeSession };
  }
  current(context) { return this.enabled && context.namespace === this.state.shared.key && context.machine === this.state.machine() && context.session === this.state.connection.session && context.nativeSession === this.nativeSession; }
  record(id) { if (this.state.options().mode !== 'local') return null; this.context(); return this.state.sync.state.localHistory[id]; }
  restore() { if (this.state.options().mode === 'local') this.context(); else this.state.connection.setThreadAliases?.({}); }
  manifest(id) { return this.state.catalog('history', id); }
  observe(thread) {
    if (!this.enabled || !thread?.id || thread.remoteOnly || thread.provider && thread.provider !== 'codex' || thread.id.startsWith('agent:') || thread.ephemeral) return;
    this.context();
    const failure = this.errors.get(thread.id);
    if (failure && failure.retryAt > Date.now()) {
      if ((!thread.path || thread.path === failure.path) && this.stamp(failure.path) === failure.stamp) return;
      failure.retryAt = 0;
    }
    this.queue.set(thread.id, thread);
  }
  stamp(file) {
    if (typeof file !== 'string' || !file) return null;
    try { const stat = fs.statSync(file); return JSON.stringify([file, stat.size, stat.mtimeMs, stat.ino]); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async refresh() {
    if (!this.enabled) return;
    const context = this.context(), { shared } = this.state;
    await shared.online();
    const result = await shared.bridge.call('history-owners', { machine: context.machine });
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    const changed = JSON.stringify([...this.owners.values()]) !== JSON.stringify(result.owners);
    this.owners = new Map(result.owners.map(owner => [owner.id, owner]));
    if (changed) this.state.changed();
  }
  async ownership(id, method = 'history-claim') {
    const context = this.context(), { shared } = this.state;
    await shared.online();
    const owner = await shared.bridge.call(method, { machine: context.machine, id, name: os.hostname().slice(0, 100) || 'Computer' });
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    this.owners.set(id, owner); return owner;
  }
  async request(id) {
    if (!this.enabled || typeof id !== 'string' || id.startsWith('agent:')) throw new Error('Conversation ownership is not available for this coding agent.');
    await this.ownership(id, 'history-request'); await this.state.sync.tick();
    this.state.changed(); return this.status();
  }
  hasPendingHistory(id, epoch) {
    const record = this.record(id), { sync } = this.state;
    if (!record?.digest) return false;
    const key = stateKey('history', this.state.machine(), id), entry = sync.state.entries[key];
    if (sync.state.conflicts[key]) return false;
    let op = sync.state.pending.findLast(op => op.key === key && op.value?.digest === record.digest && op.value.epoch === epoch);
    const seen = new Set();
    while (op && op.key === key && op.value?.epoch === epoch && !seen.has(op.opId)) {
      if (entry?.value?.digest === op.value.digest && entry.value.epoch === epoch) return true;
      if (!op.parent) return Number.isSafeInteger(op.base) && op.base === (entry?.revision || 0);
      seen.add(op.opId); op = sync.state.pending.find(parent => parent.opId === op.parent);
    }
    return false;
  }
  async repairPendingHistory(id, epoch) {
    const context = this.context(), { sync } = this.state, record = this.record(id);
    const key = stateKey('history', context.machine, id), catalog = sync.state.entries[key], conflict = sync.state.conflicts[key];
    const entry = conflict?.remote || catalog;
    if (!record || entry?.key !== key || entry.value?.id !== id || entry.value.epoch !== epoch) return false;
    let root = sync.state.pending.findLast(op => op.key === key && op.value?.digest === record.digest && op.value.epoch === epoch);
    const seen = new Set();
    while (root && root.key === key && root.value?.epoch === epoch && !seen.has(root.opId)) {
      seen.add(root.opId);
      if (!root.parent) break;
      root = sync.state.pending.find(op => op.opId === root.parent);
    }
    if (!root || root.parent || root.key !== key || root.value?.epoch !== epoch || root.value.id !== id || !Number.isSafeInteger(root.base) || root.base < 0 || root.base === entry.revision && !conflict) return false;
    const value = root.value, base = entry.value;
    const ancestry = { manifest: value, base, readBlob: id => fs.promises.readFile(sync.blobFile(id)) };
    const exact = await extendsCodexHistory(ancestry);
    if (!exact && !await extendsCodexHistory({ ...ancestry, allowImageViewChanges: true })) return false;
    if (!this.current(context) || this.record(id) !== record || root.value !== value || entry.value !== base || sync.state.entries[key] !== catalog || !sync.state.pending.includes(root) || sync.state.conflicts[key] !== conflict) return false;
    if (!exact) {
      // Reused screenshot paths can change old ImageView bytes. Keep both fully
      // verified snapshots before repairing their otherwise identical ancestry.
      const snapshots = record.preservedSnapshots || [];
      for (const snapshot of [{ revision: entry.revision, manifest: base }, { manifest: value }]) {
        if (!snapshots.some(saved => saved.manifest.digest === snapshot.manifest.digest)) snapshots.push(structuredClone(snapshot));
      }
      record.preservedSnapshots = snapshots;
    }
    root.base = entry.revision;
    if (conflict || !exact) { sync.state.entries[key] = entry; delete sync.state.conflicts[key]; sync.save(); }
    else sync.savePending();
    this.state.sync.log('conversation.history.recovered', { threadId: id, phase: 'pending-history-base' });
    return true;
  }
  hasAuthority(id, owner = this.owners.get(id)) {
    const record = this.record(id), authority = record?.authority;
    return Boolean(owner?.owner === this.state.shared.state.device && authority?.device === owner.owner && authority.epoch === owner.epoch && authority.nativeId === (record.nativeId || id) && authority.home === this.home);
  }
  async refreshManifest(id) {
    const context = this.context(), { sync } = this.state;
    await this.state.shared.online();
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    const entry = await this.state.shared.bridge.call('state-get', { kind: 'history', machine: context.machine, id });
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    if (entry) {
      if (entry.key !== stateKey('history', context.machine, id) || entry.kind !== 'history' || entry.id !== id || entry.machine !== context.machine) throw new Error('Shared conversation identity does not match.');
      await sync.applyEntry(entry); sync.save();
    }
    return entry?.value || null;
  }
  async authorizeLocal(id, owner) {
    if (this.hasAuthority(id, owner)) return;
    const context = this.context(), { sync } = this.state;
    let record = this.record(id);
    const nativeId = record?.nativeId || id;
    const original = owner.epoch === 1 && !record?.nativeId;
    const manifest = original ? null : await this.refreshManifest(id);
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    let native;
    try { native = (await this.state.connection.call('thread/read', { threadId: id, includeTurns: false })).thread; }
    catch (error) { if (!/not found|does not exist|no such|unknown thread|no rollout|thread not loaded/i.test(error.message)) throw error; }
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    record = this.record(id);
    if ((record?.nativeId || id) !== nativeId) throw new Error('The local conversation copy changed. Reopen it before sending.');
    const stamp = native?.path && this.stamp(native.path);
    const loaded = manifest && record?.digest === manifest.digest && record.path === native?.path && stamp && stamp === record.stamp;
    if (!stamp || !original && !loaded) throw Object.assign(new Error('Load the latest shared history on this computer before taking over. Use “Load latest messages”.'), { code: 'HISTORY_NOT_LOADED' });
    sync.state.localHistory[id] = { ...record, path: native.path, authority: { device: owner.owner, epoch: owner.epoch, nativeId, home: this.home } };
    sync.save(); this.state.changed();
  }
  async verify(id, stop = false) {
    if (!this.enabled || id.startsWith('agent:')) return;
    if (this.importing.has(id)) await this.importing.get(id);
    const owner = await this.ownership(id), context = this.context();
    if (stop && owner.owner === this.state.shared.state.device) return;
    await this.state.shared.bridge.call('history-verify', { machine: context.machine, id, epoch: owner.epoch });
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    await this.authorizeLocal(id, owner);
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
  }
  async begin(id) {
    if (!this.enabled || id.startsWith('agent:')) return null;
    const reservation = { ...this.context(), id };
    const ending = this.runs.get(id)?.ending;
    if (ending) {
      this.state.sync.log('conversation.history.waiting', { threadId: id, phase: 'previous-run-ending' });
      await ending;
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
    }
    if (this.runs.has(id) && !this.starting.has(id)) {
      const owner = await this.ownership(id);
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
      if (owner.owner === this.state.shared.state.device) await this.recover(id, owner);
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
    }
    if (this.starting.has(id) || this.runs.has(id)) throw new Error('This conversation already has a running task.');
    this.runs.set(id, reservation); this.starting.add(id);
    try {
      await this.verify(id);
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
      const owner = this.owners.get(id);
      if (owner.busy && !await this.recover(id, owner)) throw new Error('This conversation already has a running task.');
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
      const result = await this.state.shared.bridge.call('history-begin', { machine: reservation.machine, id, epoch: owner.epoch });
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
      Object.assign(reservation, { epoch: owner.epoch, runToken: result.run_token });
      this.owners.set(id, result); return reservation;
    } catch (error) {
      if (this.runs.get(id) === reservation) { this.starting.delete(id); this.runs.delete(id); }
      throw error;
    }
  }
  async started(id, reservation, result) {
    if (!reservation || !this.current(reservation) || this.runs.get(id) !== reservation) return;
    reservation.threadId = result.reviewThreadId || id;
    reservation.turnId = result.turn?.id;
    if (reservation.threadId !== id) this.completionThreads.set(reservation.threadId, id);
    this.starting.delete(id);
    const key = JSON.stringify([reservation.threadId, reservation.turnId]);
    if (reservation.turnId && (this.completedTurns.has(key) || ['completed', 'failed', 'interrupted'].includes(result.turn?.status))) {
      this.completedTurns.delete(key); await this.end(id, reservation);
    }
  }
  async completed(params) {
    if (!this.enabled || !params?.threadId || !params.turn?.id) return;
    this.context();
    const id = this.completionThreads.get(params.threadId) || params.threadId;
    const reservation = this.runs.get(id);
    if (reservation?.threadId === params.threadId && reservation.turnId === params.turn.id) return this.end(id, reservation);
    this.completedTurns.set(JSON.stringify([params.threadId, params.turn.id]), true);
    if (this.completedTurns.size > 500) this.completedTurns.delete(this.completedTurns.keys().next().value);
    this.queue.set(id, { id });
  }
  uncertain(id, reservation) {
    if (this.runs.get(id) === reservation) { this.starting.delete(id); this.queue.set(id, { id }); }
  }
  async end(id, reservation) {
    if (!this.enabled || id.startsWith('agent:') || !reservation || !this.current(reservation)) return;
    if (reservation.ending) return reservation.ending;
    const ending = (async () => {
      const result = await this.state.shared.bridge.call('history-end', { machine: reservation.machine, id, epoch: reservation.epoch, runToken: reservation.runToken });
      if (!this.current(reservation)) return;
      const active = this.runs.get(id);
      if (active === reservation || reservation.runToken && active?.runToken === reservation.runToken) {
        this.runs.delete(id); this.starting.delete(id);
        if (active.threadId !== id) this.completionThreads.delete(active.threadId);
      }
      // An older completion must not overwrite the cached state of a newer run.
      if (!this.runs.has(id) || this.runs.get(id).runToken === result.run_token) this.owners.set(id, result);
      this.queue.set(id, { id }); this.state.changed();
      return result;
    })();
    reservation.ending = ending;
    try { return await ending; }
    finally { if (reservation.ending === ending) delete reservation.ending; }
  }
  async recover(id, owner) {
    const context = this.context(), run = this.runs.get(id);
    const latest = await this.state.connection.call('thread/turns/list', { threadId: run?.threadId || id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!this.current(context) || this.runs.get(id) !== run || latest.data.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status)) || run?.turnId && !latest.data.some(turn => turn.id === run.turnId)) return false;
    const fresh = (await this.state.connection.call('thread/read', { threadId: run?.threadId || id, includeTurns: false })).thread;
    if (!this.current(context) || this.runs.get(id) !== run || !['idle', 'notLoaded'].includes(fresh.status?.type)) return false;
    const result = await this.end(id, { ...context, epoch: owner.epoch, runToken: owner.run_token });
    if (!this.current(context) || !result || result.busy) return false;
    if (this.runs.get(id) === run) {
      if (run?.runToken) {
        this.runs.delete(id); this.starting.delete(id);
        if (run.threadId !== id) this.completionThreads.delete(run.threadId);
      }
      this.owners.set(id, result);
    }
    this.state.sync.log('conversation.history.recovered', { threadId: id, phase: 'stale-busy' });
    return true;
  }
  canRun(id) {
    if (!this.enabled || id.startsWith('agent:')) return true;
    const owner = this.owners.get(id), record = this.record(id);
    return Boolean(owner?.owner === this.state.shared.state.device && !owner.requested && (this.hasAuthority(id, owner) || owner.epoch === 1 && record?.path && !record.nativeId && this.stamp(record.path)));
  }
  retry(id) {
    this.errors.delete(id); this.repairAttempts.delete(id); this.forced.add(id); this.queue.set(id, { id }); this.state.changed();
  }
  async export(thread, owner) {
    const context = this.context(), { connection, sync, shared } = this.state;
    if (this.importing.has(thread.id)) { this.queue.set(thread.id, thread); return false; }
    if (owner.epoch > 1 && !this.hasAuthority(thread.id, owner)) {
      try { await this.authorizeLocal(thread.id, owner); }
      catch (error) { if (error.code === 'HISTORY_NOT_LOADED') return false; throw error; }
      if (!this.current(context)) return;
    }
    const { thread: native } = await connection.call('thread/read', { threadId: thread.id, includeTurns: false });
    if (!this.current(context)) return;
    if (native.status?.type === 'active' || native.ephemeral || !native.path) { this.queue.set(thread.id, native); return; }
    const stamp = this.stamp(native.path), previous = this.record(thread.id);
    if (!this.forced.has(thread.id) && stamp && stamp === previous?.stamp && this.manifest(thread.id)?.epoch === owner.epoch) return;
    let value;
    try { value = await exportCodexHistory({ thread: { ...native, id: previous?.nativeId || native.id }, logicalId: thread.id, home: this.home, attachmentRoots: [path.join(sync.directory, 'histories', hash(context.key), 'attachments')], attachmentStore: this.attachmentStore, keepBlob: data => sync.keepBlob(data) }); }
    catch (error) {
      if (this.current(context)) {
        const failure = this.errors.get(thread.id);
        this.errors.set(thread.id, { message: error.message, path: native.path, stamp, retryAt: Date.now() + 60000 });
        this.state.sync.log('conversation.history.failed', { threadId: thread.id, error: error.message });
        if (failure?.message !== error.message) this.state.changed();
      }
      return false;
    }
    if (!this.current(context)) return;
    this.forced.delete(thread.id);
    if (this.errors.delete(thread.id)) this.state.changed();
    const entry = sync.state.entries[stateKey('history', context.machine, thread.id)];
    sync.state.localHistory[thread.id] = { ...previous, path: native.path, stamp, digest: value.digest, revision: previous?.revision || 0 };
    const queued = sync.state.pending.some(op => op.key === stateKey('history', context.machine, thread.id));
    sync.capture('history', context.machine, thread.id, { ...value, epoch: owner.epoch });
    const pending = sync.state.pending.findLast(op => op.key === stateKey('history', context.machine, thread.id));
    if (!queued && pending && !pending.parent && previous?.digest && entry?.value?.digest !== previous.digest) { pending.base = previous.revision || 0; sync.savePending(); }
    sync.save();
  }
  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const context = this.context(); let progress = 0;
    try {
      await this.refresh();
      for (const [id, failure] of this.errors) if (failure.retryAt <= Date.now() || this.stamp(failure.path) !== failure.stamp) this.queue.set(id, { id });
      for (const owner of this.owners.values()) if (owner.owner === this.state.shared.state.device) {
        const local = this.record(owner.id);
        if (owner.busy || local && (this.manifest(owner.id)?.epoch !== owner.epoch || this.stamp(local.path) !== local.stamp)) this.queue.set(owner.id, { id: owner.id });
      }
      for (const owner of this.owners.values()) if (owner.owner === this.state.shared.state.device && owner.requested) { this.queue.delete(owner.id); this.queue = new Map([[owner.id, { id: owner.id }], ...this.queue]); }
      if (!this.scanned || !this.queue.size) {
        const page = await this.state.connection.call('thread/list', { provider: 'codex', limit: 50, cursor: this.cursor, sortKey: 'updated_at' });
        if (!this.current(context)) return;
        for (const thread of page.data) this.state.captureThread(thread);
        this.cursor = page.nextCursor; this.scanned = !this.cursor;
      }
      const ready = [...this.queue].filter(([id]) => { const failure = this.errors.get(id); return !failure || failure.retryAt <= Date.now() || this.stamp(failure.path) !== failure.stamp; });
      for (const [id, thread] of ready.slice(0, 5)) {
        if (!this.current(context)) return;
        this.queue.delete(id);
        const owner = this.owners.get(id) || await this.ownership(id);
        if (owner.owner !== this.state.shared.state.device) { progress++; continue; }
        if (this.starting.has(id)) { this.queue.set(id, thread); continue; }
        if (owner.busy && !await this.recover(id, owner)) { this.queue.set(id, thread); continue; }
        if (!this.current(context)) return;
        if (this.state.sync.state.pending.some(op => op.kind === 'history' && op.id === id) && !this.hasPendingHistory(id, owner.epoch)) {
          const signature = JSON.stringify([this.record(id)?.digest, this.state.sync.state.entries[stateKey('history', context.machine, id)]?.revision, this.state.sync.state.conflicts[stateKey('history', context.machine, id)]?.remote?.revision]);
          if (this.repairAttempts.get(id) !== signature) {
            this.repairAttempts.set(id, signature);
            try { await this.repairPendingHistory(id, owner.epoch); }
            catch (error) { this.state.sync.log('conversation.history.repair.failed', { threadId: id, error: error.message }); }
            if (!this.current(context)) return;
          }
        }
        if (await this.export(thread, owner) === false) { progress++; continue; }
        if (!this.current(context)) return;
        if (!this.queue.has(id)) progress++;
        await this.state.sync.tick();
        if (!this.current(context)) return;
        const record = this.record(id), manifest = this.manifest(id);
        if (record?.digest && manifest?.digest === record.digest) {
          record.revision = this.state.sync.state.entries[stateKey('history', context.machine, id)].revision;
          this.state.sync.save();
        }
        if (owner.requested && !this.queue.has(id) && !this.state.historyBlocked?.(id) && !this.state.sync.state.pending.some(op => op.kind === 'history' && op.id === id) && !this.state.sync.state.conflicts[stateKey('history', context.machine, id)] && record?.digest === manifest?.digest) {
          if (this.state.connection.supports('thread/goal/get', 'codex')) {
            const { goal } = await this.state.connection.call('thread/goal/get', { threadId: id });
            if (!this.current(context)) return;
            if (goal?.status === 'active') { this.observe(thread); continue; }
          }
          const fresh = (await this.state.connection.call('thread/read', { threadId: id, includeTurns: false })).thread;
          if (!this.current(context)) return;
          if (fresh.status?.type === 'active' || fresh.path !== record.path || this.stamp(fresh.path) !== record.stamp || this.state.historyBlocked?.(id) || this.starting.has(id)) { this.observe(fresh); continue; }
          const next = await this.state.shared.bridge.call('history-release', { machine: context.machine, id, epoch: owner.epoch, digest: manifest.digest });
          if (!this.current(context)) return;
          this.owners.set(id, next); this.state.changed();
        }
      }
    } finally {
      this.running = false;
      if (this.background && this.current(context) && progress && (this.queue.size || !this.scanned)) {
        clearTimeout(this.timer); this.timer = setTimeout(() => this.state.tick().catch(error => this.state.sync.failed(error)), 1000); this.timer.unref();
      }
    }
  }
  async read(id, { refresh = false } = {}) {
    if (!this.enabled || id.startsWith('agent:')) return;
    const record = this.record(id);
    if (!refresh && record?.path && this.stamp(record.path) !== null) return;
    if (this.importing.has(id)) {
      const pending = this.importing.get(id);
      if (!refresh) return pending;
      await pending; return this.read(id, { refresh: true });
    }
    const context = this.context();
    const operation = (async () => {
      if (!refresh) {
        let native;
        try { native = (await this.state.connection.call('thread/read', { threadId: id, includeTurns: false })).thread; }
        catch (error) { if (!/not found|does not exist|no such|unknown thread|no rollout|thread not loaded/i.test(error.message)) throw error; }
        if (!this.current(context)) throw new Error('Conversation sync connection changed.');
        if (native?.path && this.stamp(native.path) !== null) return;
      }
      return this.import(id);
    })().finally(() => { if (this.importing.get(id) === operation) this.importing.delete(id); });
    this.importing.set(id, operation); return operation;
  }
  async useRemote(id, resolve) {
    if (this.importing.has(id)) throw new Error('Wait for this conversation to finish loading.');
    const context = this.context();
    const operation = (async () => {
      let native;
      try { native = (await this.state.connection.call('thread/read', { threadId: id, includeTurns: false })).thread; }
      catch (error) { if (!/not found|does not exist|no such|unknown thread|no rollout|thread not loaded/i.test(error.message)) throw error; }
      if (!this.current(context)) throw new Error('Conversation sync connection changed.');
      if (native?.status?.type === 'active' || this.starting.has(id) || this.runs.has(id)) throw new Error('Stop this conversation’s task before using another history version.');
      await resolve(() => this.import(id, { preserveLocal: true }));
      if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    })().finally(() => { if (this.importing.get(id) === operation) this.importing.delete(id); });
    this.importing.set(id, operation); return operation;
  }
  async import(id, { preserveLocal = false } = {}) {
    const context = this.context(), { sync, connection } = this.state;
    const manifest = await this.refreshManifest(id), previous = this.record(id);
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    if (!manifest || previous?.digest === manifest.digest && this.stamp(previous.path) !== null && this.stamp(previous.path) === previous.stamp) return;
    if (sync.state.pending.some(op => op.kind === 'history' && op.id === id) || sync.state.conflicts[stateKey('history', context.machine, id)]) throw new Error('Finish syncing this conversation’s history before loading another version.');
    let native;
    try { native = (await connection.call('thread/read', { threadId: id, includeTurns: false })).thread; }
    catch (error) { if (!/not found|does not exist|no such|unknown thread|no rollout|thread not loaded/i.test(error.message)) throw error; }
    if (native?.status?.type === 'active') { if (preserveLocal) throw new Error('Stop this conversation’s task before using another history version.'); return; }
    const nativeStamp = native?.path && this.stamp(native.path);
    if (!preserveLocal && !previous?.digest && nativeStamp) {
      const local = await exportCodexHistory({ thread: native, logicalId: id, home: this.home, attachmentStore: this.attachmentStore, keepBlob: data => sync.keepBlob(data) });
      if (!this.current(context)) throw new Error('Conversation sync connection changed.');
      if (local.digest !== manifest.digest) throw new Error('This computer has unsynced conversation messages. Its local history was kept; sync or preserve it before loading another version.');
    }
    if (!preserveLocal && previous && this.stamp(previous.path) !== null && this.stamp(previous.path) !== previous.stamp) {
      this.observe(native); throw new Error('This computer has unsynced conversation messages. Keep its local version or finish syncing it before loading another version.');
    }
    const project = this.state.catalog('thread', id)?.project, binding = project && this.state.binding(project);
    const cwd = binding?.root || previous?.workspace || this.state.options().localCwd;
    const directory = path.join(sync.directory, 'histories', hash(context.key));
    const imported = await importCodexHistory({ manifest, nativeId: connection.setThreadAliases ? randomUUID() : manifest.id, home: this.home, cwd, directory, readBlob: async key => {
      const file = sync.blobFile(key);
      if (fs.existsSync(file)) return fs.promises.readFile(file);
      const result = await this.state.shared.bridge.call('blob-get', { hash: key });
      const data = Buffer.from(result.data, 'base64');
      if (data.length > 20 * 1024 * 1024 || hash(data) !== key) throw new Error('Shared conversation attachment checksum does not match.');
      sync.keepBlob(data); return data;
    } });
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    const currentBinding = project && this.state.binding(project);
    if ((currentBinding?.root || this.record(id)?.workspace || this.state.options().localCwd) !== cwd || currentBinding?.nativeId !== binding?.nativeId) throw new Error('Project folder changed while loading conversation history.');
    if (native) {
      const fresh = (await connection.call('thread/read', { threadId: id, includeTurns: false })).thread;
      if (!this.current(context) || fresh.status?.type === 'active' || fresh.path !== native.path || this.stamp(fresh.path) !== nativeStamp || this.starting.has(id)) throw new Error('Conversation changed while loading synced history. Try again after its task finishes.');
    }
    let goalsEnabled;
    if (connection.supports('experimentalFeature/list', 'codex')) {
      const features = await connection.call('experimentalFeature/list', { limit: 100 });
      goalsEnabled = features.data.find(feature => feature.name === 'goals')?.enabled;
      if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    }
    let result;
    try { result = await connection.call('thread/resume', { threadId: imported.id, path: imported.path, cwd, runtimeWorkspaceRoots: [cwd], excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only', config: { 'features.goals': false } }); }
    catch { throw new Error('Codex could not open the synced conversation. Its original history was kept.'); }
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    if (result.thread.id !== imported.id) throw new Error('Imported conversation identity does not match.');
    if (native && imported.id !== id) {
      const fresh = (await connection.call('thread/read', { threadId: id, includeTurns: false })).thread;
      if (!this.current(context) || fresh.status?.type === 'active' || fresh.path !== native.path || this.stamp(fresh.path) !== nativeStamp) throw new Error('Conversation changed while loading shared history; its local history was kept.');
      await connection.call('thread/unsubscribe', { threadId: id });
    } else if (native && this.stamp(native.path) !== nativeStamp) throw new Error('Conversation changed while loading shared history; its local history was kept.');
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    sync.state.localHistory[id] = { ...previous, authority: null, nativeId: imported.id, retiredNativeIds: [...new Set([...previous?.retiredNativeIds || [], previous?.nativeId || id])], path: result.thread.path || imported.path, stamp: this.stamp(result.thread.path || imported.path), digest: manifest.digest, revision: sync.state.entries[stateKey('history', context.machine, id)].revision, ...(typeof goalsEnabled === 'boolean' ? { goalsEnabled } : {}), ...(native?.path ? { previousPath: native.path } : {}) };
    this.errors.delete(id);
    sync.save(); connection.setThreadAliases?.(sync.state.localHistory); this.state.changed();
  }
  status() {
    if (!this.enabled) return [];
    this.context();
    return [...this.owners.values()].map(owner => {
      const record = this.record(owner.id), manifest = this.manifest(owner.id), owned = owner.owner === this.state.shared.state.device;
      const local = owned && (this.hasAuthority(owner.id, owner) || owner.epoch === 1 && !record?.nativeId);
      const pending = this.state.sync.state.pending.some(op => op.kind === 'history' && op.machine === this.state.machine() && op.id === owner.id);
      return { id: owner.id, name: owner.name, owned, requested: Boolean(owner.requested), waiting: owner.requested === this.state.shared.state.device, busy: Boolean(owner.busy), localAvailable: local, syncPending: owned && pending, needsHistory: owned && !local, updatesAvailable: Boolean(manifest && !local && (owned || manifest.digest !== record?.digest)) };
    });
  }
  decorate(thread) {
    if (!this.enabled || !this.record(thread.id)) return thread;
    const saved = this.state.catalog('thread', thread.id), binding = saved?.project && this.state.binding(saved.project);
    const local = this.record(thread.id);
    return { ...thread, name: thread.name || saved?.name, cwd: binding?.root || local.workspace || (!local.nativeId ? thread.cwd : null) || this.state.options().localCwd, projectId: !local.nativeId && Object.hasOwn(thread, 'projectId') ? thread.projectId : binding?.nativeId || (saved?.project ? 'sync-project:' + saved.project : null), needsFolder: Boolean(saved?.project && !binding) };
  }
  close() { clearTimeout(this.timer); }
}
module.exports = { HistoryManager };

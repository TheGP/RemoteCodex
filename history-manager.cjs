const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { exportCodexHistory, importCodexHistory } = require('./codex-history.cjs');
const { stateKey, hash } = require('./sync-state.cjs');

class HistoryManager {
  constructor(state) { this.state = state; this.queue = new Map(); this.owners = new Map(); this.importing = new Map(); this.starting = new Set(); this.completionThreads = new Map(); this.runs = new Map(); this.completedTurns = new Map(); }
  get enabled() { return this.state.shared.enabled && this.state.connection.ready && (!this.state.connection.describe || this.state.connection.describe('codex').connected) && this.state.options().mode === 'local' && this.state.connection.supports('thread/list', 'codex'); }
  get home() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }
  get nativeSession() { return this.state.connection.connections?.get('codex')?.session || this.state.connection.session; }
  context() {
    const { sync, shared } = this.state; sync.load();
    const key = JSON.stringify([shared.key, this.state.machine()]);
    if (this.key !== key) { this.key = key; this.owners.clear(); this.queue.clear(); this.cursor = null; this.scanned = false; }
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
    this.context(); this.queue.set(thread.id, thread);
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
  async verify(id, stop = false) {
    if (!this.enabled || id.startsWith('agent:')) return;
    if (this.importing.has(id)) await this.importing.get(id);
    const owner = await this.ownership(id), context = this.context();
    if (stop && owner.owner === this.state.shared.state.device) return;
    await this.state.shared.bridge.call('history-verify', { machine: context.machine, id, epoch: owner.epoch });
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    const manifest = this.manifest(id), record = this.record(id);
    if (manifest && manifest.digest !== record?.digest) throw new Error('Open this conversation to load its synced history before sending messages.');
    if (this.state.sync.state.conflicts[stateKey('history', context.machine, id)]) throw new Error('Resolve this conversation’s history conflict before sending messages.');
  }
  async begin(id) {
    if (!this.enabled || id.startsWith('agent:')) return null;
    const reservation = { ...this.context(), id };
    if (this.starting.has(id) || this.runs.has(id)) throw new Error('This conversation already has a running task.');
    this.runs.set(id, reservation); this.starting.add(id);
    try {
      await this.verify(id);
      if (!this.current(reservation)) throw new Error('Conversation sync connection changed.');
      const owner = this.owners.get(id);
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
  }
  canRun(id) {
    if (!this.enabled || id.startsWith('agent:')) return true;
    const owner = this.owners.get(id), record = this.record(id), manifest = this.manifest(id);
    return Boolean(owner?.owner === this.state.shared.state.device && !owner.requested && (!manifest || manifest.digest === record?.digest));
  }
  async export(thread, owner) {
    const context = this.context(), { connection, sync, shared } = this.state;
    const { thread: native } = await connection.call('thread/read', { threadId: thread.id, includeTurns: false });
    if (!this.current(context)) return;
    if (native.status?.type === 'active' || native.ephemeral || !native.path) { this.queue.set(thread.id, native); return; }
    const stamp = this.stamp(native.path), previous = this.record(thread.id);
    if (stamp && stamp === previous?.stamp && this.manifest(thread.id)?.epoch === owner.epoch) return;
    const value = await exportCodexHistory({ thread: { ...native, id: previous?.nativeId || native.id }, logicalId: thread.id, home: this.home, attachmentRoots: [path.join(sync.directory, 'histories', hash(context.key), 'attachments')], keepBlob: data => sync.keepBlob(data) });
    if (!this.current(context)) return;
    const entry = sync.state.entries[stateKey('history', context.machine, thread.id)];
    sync.state.localHistory[thread.id] = { ...previous, path: native.path, stamp, digest: value.digest, revision: previous?.revision || 0 };
    sync.capture('history', context.machine, thread.id, { ...value, epoch: owner.epoch });
    const pending = sync.state.pending.findLast(op => op.key === stateKey('history', context.machine, thread.id));
    if (pending && previous && entry?.value?.digest !== previous.digest) { pending.base = previous.revision || 0; sync.savePending(); }
    sync.save();
  }
  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const context = this.context(); let progress = 0;
    try {
      await this.refresh();
      for (const owner of this.owners.values()) if (owner.owner === this.state.shared.state.device) {
        const local = this.record(owner.id);
        if (local && (this.manifest(owner.id)?.epoch !== owner.epoch || this.stamp(local.path) !== local.stamp)) this.queue.set(owner.id, { id: owner.id });
      }
      for (const owner of this.owners.values()) if (owner.owner === this.state.shared.state.device && owner.requested) { this.queue.delete(owner.id); this.queue = new Map([[owner.id, { id: owner.id }], ...this.queue]); }
      if (!this.scanned || !this.queue.size) {
        const page = await this.state.connection.call('thread/list', { provider: 'codex', limit: 50, cursor: this.cursor, sortKey: 'updated_at' });
        if (!this.current(context)) return;
        for (const thread of page.data) this.state.captureThread(thread);
        this.cursor = page.nextCursor; this.scanned = !this.cursor;
      }
      for (const [id, thread] of [...this.queue].slice(0, 5)) {
        if (!this.current(context)) return;
        this.queue.delete(id);
        const owner = this.owners.get(id) || await this.ownership(id);
        if (owner.owner !== this.state.shared.state.device) { progress++; continue; }
        if (this.starting.has(id)) { this.queue.set(id, thread); continue; }
        if (owner.busy) {
          const latest = await this.state.connection.call('thread/turns/list', { threadId: this.runs.get(id)?.threadId || id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
          if (!this.current(context)) return;
          const run = this.runs.get(id);
          if (latest.data.some(turn => turn.status === 'inProgress') || run?.turnId && !latest.data.some(turn => turn.id === run.turnId)) { this.queue.set(id, thread); continue; }
          const fresh = (await this.state.connection.call('thread/read', { threadId: run?.threadId || id, includeTurns: false })).thread;
          if (!this.current(context)) return;
          if (fresh.status?.type === 'active' || this.starting.has(id)) { this.queue.set(id, thread); continue; }
          await this.end(id, { ...context, epoch: owner.epoch, runToken: owner.run_token });
          if (!this.current(context)) return;
        }
        await this.export(thread, owner);
        if (!this.current(context)) return;
        if (!this.queue.has(id)) progress++;
        await this.state.sync.tick();
        if (!this.current(context)) return;
        const record = this.record(id), manifest = this.manifest(id);
        if (record && manifest?.digest === record.digest) {
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
  async read(id) {
    if (!this.enabled || id.startsWith('agent:')) return;
    if (this.importing.has(id)) return this.importing.get(id);
    const operation = this.import(id).finally(() => { if (this.importing.get(id) === operation) this.importing.delete(id); });
    this.importing.set(id, operation); return operation;
  }
  async import(id) {
    const context = this.context(), { sync, connection } = this.state;
    await sync.tick();
    if (!this.current(context)) throw new Error('Conversation sync connection changed.');
    const manifest = this.manifest(id), previous = this.record(id);
    if (!manifest || previous?.digest === manifest.digest && this.stamp(previous.path) !== null) return;
    if (sync.state.pending.some(op => op.kind === 'history' && op.id === id) || sync.state.conflicts[stateKey('history', context.machine, id)]) throw new Error('Finish syncing this conversation’s history before loading another version.');
    let native;
    try { native = (await connection.call('thread/read', { threadId: id, includeTurns: false })).thread; }
    catch (error) { if (!/not found|does not exist|no such|unknown thread|no rollout|thread not loaded/i.test(error.message)) throw error; }
    if (native?.status?.type === 'active') return;
    const nativeStamp = native?.path && this.stamp(native.path);
    if (!previous?.digest && nativeStamp) {
      const local = await exportCodexHistory({ thread: native, logicalId: id, home: this.home, keepBlob: data => sync.keepBlob(data) });
      if (!this.current(context)) throw new Error('Conversation sync connection changed.');
      if (local.digest !== manifest.digest) throw new Error('This computer has unsynced conversation messages. Its local history was kept; sync or preserve it before loading another version.');
    }
    if (previous && this.stamp(previous.path) !== null && this.stamp(previous.path) !== previous.stamp) {
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
    if (native) await connection.call('thread/unsubscribe', { threadId: id });
    sync.state.localHistory[id] = { ...previous, nativeId: imported.id, retiredNativeIds: [...new Set([...previous?.retiredNativeIds || [], previous?.nativeId || id])], path: result.thread.path || imported.path, stamp: this.stamp(result.thread.path || imported.path), digest: manifest.digest, revision: sync.state.entries[stateKey('history', context.machine, id)].revision, ...(typeof goalsEnabled === 'boolean' ? { goalsEnabled } : {}), ...(native?.path ? { previousPath: native.path } : {}) };
    sync.save(); connection.setThreadAliases?.(sync.state.localHistory); this.state.changed();
  }
  status() {
    if (!this.enabled) return [];
    this.context();
    return [...this.owners.values()].map(owner => ({ id: owner.id, name: owner.name, owned: owner.owner === this.state.shared.state.device, requested: Boolean(owner.requested), waiting: owner.requested === this.state.shared.state.device, busy: Boolean(owner.busy), updatesAvailable: Boolean(this.manifest(owner.id) && this.manifest(owner.id).digest !== this.record(owner.id)?.digest) }));
  }
  decorate(thread) {
    if (!this.enabled || !this.record(thread.id)) return thread;
    const saved = this.state.catalog('thread', thread.id), binding = saved?.project && this.state.binding(saved.project);
    const local = this.record(thread.id);
    return { ...thread, name: thread.name || saved?.name, cwd: binding?.root || local.workspace || (!local.nativeId ? thread.cwd : null) || this.state.options().localCwd, projectId: binding?.nativeId || (saved?.project ? 'sync-project:' + saved.project : null), needsFolder: Boolean(saved?.project && !binding) };
  }
  close() { clearTimeout(this.timer); }
}
module.exports = { HistoryManager };

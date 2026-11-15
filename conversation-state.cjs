const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ConversationSync } = require('./conversation-sync.cjs');
const { stateKey, hash } = require('./sync-state.cjs');
const { agentTarget, agentId } = require('./agent-pool.cjs');

class ConversationState {
  constructor({ directory, shared, pins, drafts, preferences, machine, options, connection, changed, log }) {
    Object.assign(this, { shared, pins, drafts, preferences, machine, options, connection, changed });
    this.sync = new ConversationSync({ directory, shared, apply: entry => this.apply(entry), changed, log });
    this.nativeProjects = new Map();
  }
  binding(id, machine = this.machine()) {
    this.sync.load(); return this.sync.state.bindings[JSON.stringify([machine, id])];
  }
  projectId(nativeId, machine = this.machine()) {
    this.sync.load();
    if (nativeId?.includes('sync-project:')) return agentTarget(nativeId, 'project').value.slice('sync-project:'.length);
    return Object.entries(this.sync.state.bindings).find(([key, value]) => JSON.parse(key)[0] === machine && value.nativeId === nativeId)?.[1].id;
  }
  catalog(kind, id, machine = this.machine()) { this.sync.load(); return this.sync.state.entries[stateKey(kind, machine, id)]?.value; }
  captureProject(project, update = false) {
    if (!project?.id || !project.roots?.[0]?.path || !this.shared.enabled && (!update || !this.sync.canCapture())) return project;
    this.sync.load();
    const machine = this.machine(), provider = project.provider || agentTarget(project.id, 'project').provider;
    const id = this.projectId(project.id) || randomUUID();
    const key = JSON.stringify([machine, id]), binding = { id, nativeId: project.id, root: project.roots[0].path, provider };
    if (JSON.stringify(this.sync.state.bindings[key]) !== JSON.stringify(binding)) { this.sync.state.bindings[key] = binding; this.sync.save(); }
    const record = { name: project.name, provider };
    if (update || !this.catalog('project', id)) this.sync.capture('project', machine, id, record, !update);
    this.nativeProjects.set(project.id, project);
    const pending = this.sync.state.pending.findLast(op => op.key === stateKey('project', machine, id));
    return { ...project, sharedId: id, name: pending?.value?.name || this.catalog('project', id)?.name || project.name };
  }
  projects(data) {
    if (!this.shared.enabled) return data;
    const mapped = data.map(project => this.captureProject(project));
    for (const entry of this.sync.entries('project', this.machine())) {
      const binding = this.binding(entry.id);
      if (binding && this.nativeProjects.has(binding.nativeId)) continue;
      mapped.push({ id: agentId(entry.value.provider, 'project', 'sync-project:' + entry.id), sharedId: entry.id, provider: entry.value.provider, name: entry.value.name, roots: [], needsFolder: true });
    }
    return mapped;
  }
  captureThread(thread) {
    if (!this.shared.enabled || !thread?.id || thread.remoteOnly) return thread;
    const previous = this.catalog('thread', thread.id);
    const project = Object.hasOwn(thread, 'projectId') ? this.projectId(thread.projectId) || null : previous?.project || null;
    if (previous && previous.updatedAt > (thread.updatedAt || 0)) return thread;
    const value = { id: thread.id, name: thread.name || null, preview: (thread.preview || '').slice(0, 500), createdAt: thread.createdAt || 0, updatedAt: thread.updatedAt || 0, provider: thread.provider || agentTarget(thread.id, 'thread').provider, project };
    const key = stateKey('thread', this.machine(), thread.id);
    const pending = this.sync.state.pending.findLast(op => op.key === key);
    if (JSON.stringify(pending?.value || previous) !== JSON.stringify(value)) this.sync.capture('thread', this.machine(), thread.id, value);
    return thread;
  }
  threads(data, projectId, search = '') {
    if (!this.shared.enabled) return data;
    data.forEach(thread => this.captureThread(thread));
    const ids = new Set(data.map(thread => thread.id));
    for (const { id, value } of this.sync.entries('thread', this.machine())) {
      if (ids.has(id)) continue;
      const binding = value.project && this.binding(value.project);
      const localProject = value.project ? binding?.nativeId || agentId(value.provider, 'project', 'sync-project:' + value.project) : null;
      if ((localProject || null) !== (projectId || null) || search && !(value.name || value.preview).toLowerCase().includes(search.toLowerCase())) continue;
      data.push({ ...value, id, projectId: localProject, cwd: binding?.root || '', sharedProject: value.project, needsFolder: Boolean(value.project && !binding), remoteOnly: true, status: { type: 'notLoaded' } });
    }
    return data;
  }
  async bind(id, root) {
    const machine = this.machine(), session = this.connection.session, record = this.catalog('project', id);
    if (!record || typeof root !== 'string' || root.length > 4096 || !path.posix.isAbsolute(root) && !path.win32.isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw new Error('Choose an existing absolute project folder.');
    const current = () => { if (machine !== this.machine() || session !== this.connection.session) throw new Error('Connection changed. Choose the project folder again.'); };
    await this.connection.call('fs/readDirectory', { path: root }, undefined, { provider: record.provider }); current();
    let project = [...this.nativeProjects.values()].find(item => item.roots.some(item => item.path.replace(/[\\/]+$/, '') === root.replace(/[\\/]+$/, '')) && (item.provider || 'codex') === record.provider);
    if (!project) {
      const result = await this.connection.call('project/create', { provider: record.provider, name: record.name, roots: [{ path: root }], idempotencyKey: hash(JSON.stringify([id, root])) }); current(); project = result.project;
    }
    const other = this.projectId(project.id);
    if (other && other !== id) {
      delete this.sync.state.bindings[JSON.stringify([machine, other])];
      for (const entry of this.sync.entries('thread', machine)) if (entry.value.project === other) this.sync.capture('thread', machine, entry.id, { ...entry.value, project: id });
      this.sync.capture('project', machine, other, null);
    }
    this.sync.state.bindings[JSON.stringify([machine, id])] = { id, nativeId: project.id, root, provider: record.provider };
    this.nativeProjects.set(project.id, project); this.sync.save();
    await this.sync.hydrate(); this.changed(); return { ...project, sharedId: id };
  }
  threadBinding(threadId) {
    const record = this.shared.enabled && this.catalog('thread', threadId);
    if (!record?.project) return null;
    const binding = this.binding(record.project);
    if (!binding) throw new Error('Choose this shared project’s folder on this computer before running messages.');
    return binding;
  }
  async scheduledTask(task) {
    if (this.activeNamespace !== this.shared.key || this.activeMachine !== this.machine() || this.activeSession !== this.connection.session) return null;
    const record = this.catalog('thread', task.threadId, task.machine);
    const project = record?.project || this.projectId(task.message?.thread.projectId, task.machine);
    if (!project) return task.message?.thread.projectId || !record && task.originDevice !== this.shared.state.device ? null : task;
    const binding = this.binding(project, task.machine);
    if (!binding) return null;
    await this.connection.call('fs/readDirectory', { path: binding.root }, undefined, { provider: binding.provider });
    const value = structuredClone(task); value.sourceCwd = task.cwd; value.cwd = binding.root;
    if (value.message) {
      const message = value.message;
      message.thread = { ...message.thread, cwd: binding.root, projectId: binding.nativeId };
      if (message.turnSettings.sandboxPolicy?.type === 'workspaceWrite') message.turnSettings.sandboxPolicy.writableRoots = [binding.root];
      if (binding.provider === 'codex') message.turnSettings.cwd = binding.root;
      if (task.cwd !== binding.root && message.input.some(part => !['text', 'image', 'skill'].includes(part.type))) throw new Error('This scheduled attachment needs to be reattached on this computer.');
      if (message.input.some(part => part.type === 'skill')) {
        const result = await this.connection.call('skills/list', { cwds: [binding.root] }, undefined, { provider: binding.provider });
        const skills = result.data.flatMap(entry => entry.skills || []);
        message.input = message.input.map(part => {
          if (part.type !== 'skill') return part;
          const skill = skills.find(skill => skill.name === part.name && skill.enabled !== false);
          if (!skill) throw new Error(`Install the scheduled skill on this computer: ${part.name}`);
          return { ...part, path: skill.path };
        });
      }
    }
    return value;
  }
  draftIdentity(target) {
    const project = this.projectId(target.projectId, target.machine) || (target.threadId && this.catalog('thread', target.threadId, target.machine)?.project) || null;
    const id = JSON.stringify([target.kind, target.threadId || (project ? ['project', project] : ['folder', hash(target.cwd)]), target.itemId || null]);
    return { id, project };
  }
  captureDraft(target, seed = false, stale = false) {
    if (!this.sync.canCapture()) return;
    const { id, project } = this.draftIdentity(target), metadata = this.drafts.metadata(target);
    let value = null;
    if (metadata) {
      const images = metadata.images.map(image => ({ name: image.name, mime: image.mime, hash: this.sync.keepBlob(fs.readFileSync(path.join(this.drafts.folder(target), image.file))) }));
      const { version, updatedAt, ...saved } = metadata;
      value = { ...saved, target: { ...saved.target, cwd: '', projectId: null }, project, images };
    }
    this.sync.capture('draft', target.machine, id, value, seed, undefined, stale);
  }
  async apply(entry) {
    const { kind, machine, id, value } = entry;
    if (kind === 'pin') {
      if (machine === this.machine()) this.pins.set(this.options(), id, Boolean(value));
    } else if (kind === 'messagePin') {
      const [threadId, itemId] = JSON.parse(id);
      this.preferences.update({ messagePin: { machine, threadId, itemId, ...(value || {}), pinned: Boolean(value) } });
    } else if (kind === 'shortcuts' && value) this.preferences.update({ shortcuts: value });
    else if (kind === 'unread' || kind === 'completion') {
      const markers = this.preferences.read().conversationStates?.[machine] || { unread: [], completions: {} };
      const unread = new Set(markers.unread), completions = { ...markers.completions };
      if (kind === 'unread') { if (value) unread.add(id); else unread.delete(id); }
      else { if (value) completions[id] = value.status || value; else delete completions[id]; }
      this.preferences.update({ conversationState: { machine, unread: [...unread], completions } });
    } else if (kind === 'draft') {
      const identity = JSON.parse(id), project = value?.project || (Array.isArray(identity[1]) && identity[1][0] === 'project' ? identity[1][1] : null);
      const binding = project && this.binding(project, machine);
      const pending = () => this.sync.state.pending.some(op => op.key === entry.key);
      let target = value?.target;
      if (!target) {
        for (const saved of this.drafts.list()) if (saved.target.machine === machine && this.draftIdentity(saved.target).id === id) this.drafts.clear(saved.target);
        return;
      }
      if (machine !== this.machine() || project && !binding) return;
      const previous = this.drafts.metadata(target)?.target;
      target = { ...target, cwd: binding?.root || previous?.cwd || '', projectId: binding?.nativeId || previous?.projectId || null };
      // A foreign folder without a project has no safe mapping on this computer.
      if (!target.threadId && !binding) return;
      const images = await this.sync.images(value, true);
      if (pending() || (this.sync.state.entries[entry.key]?.revision || 0) > entry.revision) return;
      const patch = { text: value.text, images };
      for (const field of ['hours', 'model', 'effort', 'mode', 'access', 'runAt']) if (value[field] !== undefined) patch[field] = value[field];
      this.drafts.save(target, patch);
    }
  }
  seed() {
    if (!this.shared.enabled) return;
    this.sync.load(); if (this.sync.state.seeded) return;
    const prefs = this.preferences.read(), machine = this.machine();
    for (const id of this.pins.get(this.options())) this.sync.capture('pin', machine, id, true, true);
    for (const [machine, state] of Object.entries(prefs.conversationStates || {})) {
      for (const id of state.unread) this.sync.capture('unread', machine, id, true, true);
      for (const [id, status] of Object.entries(state.completions)) this.sync.capture('completion', machine, id, status, true);
    }
    for (const [machine, threads] of Object.entries(prefs.messagePins || {})) for (const [threadId, pins] of Object.entries(threads)) for (const pin of pins) this.sync.capture('messagePin', machine, JSON.stringify([threadId, pin.itemId]), pin, true);
    if (prefs.shortcuts !== undefined) this.sync.capture('shortcuts', 'access:local', 'shortcuts', prefs.shortcuts, true);
    for (const value of this.drafts.list()) this.captureDraft(value.target, true);
    this.sync.state.seeded = true; this.sync.save();
  }
  async tick() {
    if (!this.shared.enabled) { this.activeNamespace = null; return; }
    this.sync.load();
    if (!this.connection.ready && !this.sync.state.seeded) return;
    if (this.connection.ready && (this.activeNamespace !== this.shared.key || this.activeMachine !== this.machine() || this.activeSession !== this.connection.session)) {
      if (this.bootstrapping) return;
      this.bootstrapping = true;
      const machine = this.machine(), session = this.connection.session, namespace = this.shared.key;
      try {
        this.nativeProjects.clear();
        if (this.connection.supports('project/list')) {
          let cursor = null;
          do {
            const result = await this.connection.call('project/list', { limit: 100, cursor });
            if (namespace !== this.shared.key || machine !== this.machine() || session !== this.connection.session) return;
            result.data.forEach(project => this.captureProject(project)); cursor = result.nextCursor;
          } while (cursor);
        }
        this.seed();
        for (const id of this.pins.get(this.options())) this.sync.capture('pin', machine, id, true, true);
        await this.sync.hydrate();
        if (namespace !== this.shared.key || machine !== this.machine() || session !== this.connection.session) return;
        this.activeNamespace = namespace; this.activeMachine = machine; this.activeSession = session;
      } finally { this.bootstrapping = false; }
    }
    await this.sync.tick();
  }
  status() {
    const conflicts = this.shared.enabled ? this.sync.conflicts().map(({ key, remote, local, version }) => ({ key, version, kind: JSON.parse(key)[0], local: local?.text ?? JSON.stringify(local, null, 2), remote: remote?.value?.text ?? JSON.stringify(remote?.value, null, 2) })) : [];
    const catalog = this.shared.enabled ? JSON.stringify(Object.values(this.sync.state.entries).filter(entry => ['project', 'thread'].includes(entry.kind)).map(entry => entry.revision)) : '';
    return { enabled: this.shared.enabled, error: this.sync.error, conflicts, catalog };
  }
}
module.exports = { ConversationState };

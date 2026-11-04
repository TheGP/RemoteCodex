class AgentWakeLock {
  constructor(blocker, connection, changed = () => {}) {
    this.blocker = blocker;
    this.changed = changed;
    this.id = null;
    this.active = new Map();
    this.pending = new Map();
    this.versions = new Map();
    this.finished = new Set();
    this.sequence = 0;
    connection.on('rpc', event => this.rpc(event));
    connection.on('notification', event => this.notification(event));
    connection.on('disconnected', () => this.clear());
  }

  sync() {
    const working = this.active.size > 0 || [...this.pending.values()].some(request => request.working);
    if (working && this.id === null) { this.id = this.blocker.start('prevent-app-suspension'); this.changed(true); }
    else if (!working && this.id !== null) { this.blocker.stop(this.id); this.id = null; this.changed(false); }
  }

  set(threadId, turnId) {
    if (!threadId) return;
    this.versions.set(threadId, ++this.sequence);
    if (turnId === false) this.active.delete(threadId); else this.active.set(threadId, turnId);
  }

  rpc(event) {
    if (event.phase === 'started') {
      this.pending.set(event.requestId, { ...event, sequence: this.sequence, working: ['turn/start', 'turn/steer', 'review/start', 'thread/compact/start'].includes(event.method) });
    } else {
      const request = this.pending.get(event.requestId);
      if (!request) return;
      this.pending.delete(event.requestId);
      const result = event.result;
      const current = threadId => threadId && (this.versions.get(threadId) || 0) <= request.sequence;
      const thread = value => {
        if (!current(value?.id) || !value.status) return;
        this.set(value.id, value.status.type === 'active' ? this.active.get(value.id) || null : false);
      };
      if (result?.thread) thread(result.thread);
      if (event.method === 'thread/list') for (const value of result?.data || []) thread(value);
      const threadId = request.threadId || result?.reviewThreadId;
      if (result?.turn && current(threadId)) {
        const key = threadId + ':' + result.turn.id;
        if (result.turn.status === 'inProgress' && !this.finished.has(key)) this.set(threadId, result.turn.id);
        else if (!this.active.get(threadId) || this.active.get(threadId) === result.turn.id) this.set(threadId, false);
      }
    }
    this.sync();
  }

  notification({ method, params = {} }) {
    const { threadId, turn } = params;
    if (method === 'connection/closed') { this.clear(); return; }
    if (method === 'turn/started' && !this.finished.has(threadId + ':' + turn.id)) this.set(threadId, turn.id);
    else if (method === 'turn/completed') {
      this.finished.add(threadId + ':' + turn.id);
      if (this.finished.size > 1000) this.finished.delete(this.finished.values().next().value);
      if (!this.active.get(threadId) || this.active.get(threadId) === turn.id) this.set(threadId, false);
    } else if (method === 'thread/status/changed') this.set(threadId, params.status?.type === 'active' ? this.active.get(threadId) || null : false);
    else if (method === 'error' && threadId && !params.willRetry && (!params.turnId || !this.active.get(threadId) || this.active.get(threadId) === params.turnId)) this.set(threadId, false);
    else if (method === 'thread/archived') this.set(threadId, false);
    this.sync();
  }

  clear() {
    this.active.clear(); this.pending.clear(); this.versions.clear(); this.finished.clear();
    this.sync();
  }
}

module.exports = { AgentWakeLock };

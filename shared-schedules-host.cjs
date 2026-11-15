const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ScheduleStore } = require('./scheduler.cjs');

const leaseMs = 60000;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const scope = (machine, threadId) => {
  if (typeof machine !== 'string' || !machine.startsWith('access:') || machine.length > 500 || !validId(threadId)) throw new Error('Invalid conversation.');
  return JSON.stringify([machine, threadId]);
};

class SharedScheduleDatabase {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, machine TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL, run_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS due_tasks ON tasks(machine,thread_id,status,run_at);
      CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(resource TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, expires_at INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  get(id) { const row = this.db.prepare('SELECT payload FROM tasks WHERE id=? UNION ALL SELECT payload FROM tombstones WHERE id=? LIMIT 1').get(id, id); return row ? JSON.parse(row.payload) : null; }
  put(task, now) {
    const { message, ...summary } = task;
    this.db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,run_at=excluded.run_at,updated_at=excluded.updated_at,summary=excluded.summary,payload=excluded.payload`)
      .run(task.id, task.machine, task.threadId, task.status, Date.parse(task.runAt), now, JSON.stringify(summary), JSON.stringify(task));
    return task;
  }
  sweep(now) {
    for (const lease of this.db.prepare('SELECT * FROM leases WHERE expires_at<=?').all(now)) {
      const task = lease.task_id && this.get(lease.task_id);
      if (task?.delivery?.token === lease.token && ['claimed', 'sending'].includes(task.status)) {
        task.status = task.status === 'claimed' ? 'pending' : 'unconfirmed';
        task.error = task.status === 'unconfirmed' ? 'Delivery was not confirmed before the sending computer disconnected; check chat history before scheduling again.' : null;
        this.put(task, now);
      }
      if (task?.delivery?.token === lease.token && task.status === 'sent' && task.active) this.put({ ...task, needsReview: true, error: 'The sending computer disconnected before confirming this run finished. Check its history before dismissing.' }, now);
    }
    this.db.prepare('DELETE FROM leases WHERE expires_at<=?').run(now);
    const expired = this.db.prepare("SELECT payload FROM tasks WHERE status IN ('sent','cancelled') AND json_extract(payload,'$.active') IS NOT 1 AND updated_at<?").all(now - 7 * 86400000);
    for (const row of expired) {
      const { id, machine, threadId, status, turnId, delivery, runAt, dismissed } = JSON.parse(row.payload);
      this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?)').run(id, JSON.stringify({ id, machine, threadId, status, turnId, delivery, runAt, dismissed, active: false, retired: true }));
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    }
  }
  lease(task, token, owner, kind, now) {
    const lease = this.db.prepare('SELECT * FROM leases WHERE resource=?').get(scope(task.machine, task.threadId));
    if (!lease || lease.kind !== kind || lease.token !== token || lease.owner !== owner || lease.expires_at <= now) throw new Error('This schedule lock expired. Reopen the editor or refresh schedules.');
    return lease;
  }
  request(method, args = {}, owner, now = Date.now()) {
    if (!validId(owner) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid shared schedule request.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sweep(now);
      const result = this.perform(method, args, owner, now);
      this.db.exec('COMMIT');
      return { result, serverNow: now };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  perform(method, args, owner, now) {
    if (method === 'hello') return { protocol: 1, leaseMs };
    if (method === 'storage-info') {
      const directory = path.dirname(this.file);
      let bytes = 0, remaining = 10000, complete = true;
      const folders = [directory];
      while (folders.length && complete) {
        const folder = folders.pop();
        const entries = fs.opendirSync(folder);
        try {
          let entry;
          while ((entry = entries.readSync())) {
            if (--remaining < 0) { complete = false; break; }
            const file = path.join(folder, entry.name);
            let stat;
            try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (stat.isFile()) bytes += stat.size;
            else if (stat.isDirectory()) folders.push(file);
          }
        } finally { entries.closeSync(); }
      }
      return { directory, bytes, complete, measuredAt: new Date(now).toISOString() };
    }
    if (method === 'list') return this.db.prepare("SELECT summary FROM tasks ORDER BY CASE WHEN status IN ('sent','cancelled') THEN 1 ELSE 0 END,run_at LIMIT 2000").all().map(row => JSON.parse(row.summary));
    if (method === 'create' || method === 'import') {
      const memory = new ScheduleStore(null);
      let task;
      if (method === 'create') task = memory.enqueue(args.message, args.hours, now);
      else {
        const source = args.task;
        if (!source || source.status !== 'pending' || !validId(source.id) || !Number.isFinite(Date.parse(source.runAt))) throw new Error('Only pending schedules can be shared.');
        const thread = source.message?.thread || { id: source.threadId, cwd: source.cwd, name: source.title };
        task = source.message ? memory.enqueue(source.message, 1, now) : memory.add(thread, { prompt: source.prompt, delay_seconds: 1 }, null, now);
        Object.assign(task, { id: source.id, machine: source.machine || 'access:local', runAt: source.runAt, createdAt: source.createdAt || task.createdAt });
        if (task.threadId !== source.threadId || task.message && task.machine !== task.message.machine) throw new Error('Schedule conversation does not match its message.');
      }
      if (args.id !== undefined) { if (!validId(args.id)) throw new Error('Invalid schedule identity.'); task.id = args.id; }
      scope(task.machine, task.threadId);
      const existing = this.get(task.id);
      if (existing) {
        if (existing.machine !== task.machine || existing.threadId !== task.threadId) throw new Error('This schedule identity belongs to another conversation.');
        return existing;
      }
      if (this.db.prepare("SELECT count(*) AS total FROM tasks WHERE status IN ('pending','claimed','sending')").get().total >= 1000) throw new Error('Cancel pending tasks before scheduling more.');
      task.originDevice = owner;
      return this.put(task, now);
    }
    if (method === 'edit-lock') {
      const resource = scope(args.machine, args.threadId);
      if (this.db.prepare('SELECT 1 FROM leases WHERE resource=?').get(resource)) throw new Error('Another computer is editing or sending to this conversation.');
      const token = randomUUID();
      this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?)').run(resource, token, owner, 'edit', null, now + leaseMs);
      return { token, expiresAt: now + leaseMs };
    }
    if (method === 'unlock') {
      if (!validId(args.token)) throw new Error('Invalid lock.');
      this.db.prepare("DELETE FROM leases WHERE token=? AND owner=? AND kind='edit'").run(args.token, owner);
      return {};
    }
    if (method === 'renew') {
      if (!Array.isArray(args.tokens) || args.tokens.length > 1000 || !args.tokens.every(validId)) throw new Error('Invalid locks.');
      return args.tokens.filter(token => this.db.prepare('UPDATE leases SET expires_at=? WHERE token=? AND owner=? AND expires_at>?').run(now + leaseMs, token, owner, now).changes > 0);
    }
    if (!validId(args.id)) throw new Error('Invalid schedule identity.');
    const task = this.get(args.id);
    if (!task) throw new Error('Scheduled task not found.');
    const resource = scope(task.machine, task.threadId);
    if (method === 'get' || method === 'edit') {
      this.lease(task, args.token, owner, 'edit', now);
      if (task.status !== 'pending') throw new Error('This scheduled message is no longer pending.');
      if (method === 'get') return task;
      const memory = new ScheduleStore(null); memory.tasks = [task];
      return this.put(memory.edit(task.id, args.patch, now), now);
    }
    if (method === 'cancel') {
      if (task.status === 'cancelled') return task;
      if (task.status !== 'pending') throw new Error('This task is being sent or has already been attempted; check chat history.');
      if (this.db.prepare("SELECT 1 FROM leases WHERE resource=? AND kind='edit'").get(resource)) throw new Error('Close the scheduled editor before cancelling this task.');
      return this.put({ ...task, status: 'cancelled', message: null }, now);
    }
    if (method === 'claim') {
      if (task.status !== 'pending' || Date.parse(task.runAt) > now || this.db.prepare('SELECT 1 FROM leases WHERE resource=?').get(resource)) return null;
      if (this.db.prepare("SELECT 1 FROM tasks WHERE machine=? AND thread_id=? AND (status='unconfirmed' OR json_extract(payload,'$.active')=1)").get(task.machine, task.threadId)) return null;
      const earliest = this.db.prepare("SELECT id FROM tasks WHERE machine=? AND thread_id=? AND status='pending' AND run_at<=? ORDER BY run_at,id LIMIT 1").get(task.machine, task.threadId, now);
      if (earliest?.id !== task.id) return null;
      const token = randomUUID();
      this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?)').run(resource, token, owner, 'delivery', task.id, now + leaseMs);
      task.status = 'claimed'; task.delivery = { token, owner };
      this.put(task, now);
      return { task, token, expiresAt: now + leaseMs };
    }
    if (method === 'begin' || method === 'release') {
      this.lease(task, args.token, owner, 'delivery', now);
      if (task.status !== 'claimed' || task.delivery?.token !== args.token) throw new Error('This delivery is no longer claimed by this computer.');
      task.status = method === 'begin' ? 'sending' : 'pending';
      this.put(task, now);
      if (method === 'release') this.db.prepare('DELETE FROM leases WHERE token=? AND owner=?').run(args.token, owner);
      return task;
    }
    if (method === 'finish') {
      if (task.status === 'cancelled' && task.dismissed && task.delivery?.owner === owner && task.delivery.token === args.token) return task;
      if (!['sent', 'unconfirmed'].includes(args.status) || task.delivery?.owner !== owner || task.delivery.token !== args.token || !['sending', 'unconfirmed', 'sent'].includes(task.status)) throw new Error('This computer does not own the delivery receipt.');
      if (task.status === 'sent') {
        if (args.status !== 'sent' || task.turnId !== args.turnId) throw new Error('Receipt does not match the confirmed delivery.');
        return task;
      }
      if (args.status === 'sent' && !validId(args.turnId)) throw new Error('Missing confirmed turn.');
      Object.assign(task, { status: args.status, error: args.status === 'sent' ? null : 'Delivery was not confirmed; check chat history before scheduling again.' });
      if (args.status === 'sent') Object.assign(task, { message: null, turnId: args.turnId, active: true, needsReview: false, sentAt: new Date(now).toISOString() });
      this.put(task, now);
      if (args.status !== 'sent') this.db.prepare('DELETE FROM leases WHERE token=? AND owner=?').run(args.token, owner);
      return task;
    }
    if (method === 'complete') {
      if (task.status !== 'sent' || task.turnId !== args.turnId || task.delivery?.token !== args.token || task.delivery?.owner !== owner) throw new Error('This run does not match its delivery receipt.');
      if (!task.active) return task;
      this.db.prepare('DELETE FROM leases WHERE token=? AND owner=?').run(args.token, owner);
      return this.put({ ...task, active: false, needsReview: false, error: null }, now);
    }
    if (method === 'dismiss') {
      if (task.status === 'cancelled' && task.dismissed) return task;
      if (task.status !== 'unconfirmed' && !(task.status === 'sent' && task.needsReview)) throw new Error('Only uncertain deliveries can be dismissed after checking history.');
      if (this.db.prepare('SELECT 1 FROM leases WHERE resource=?').get(resource)) throw new Error('A computer is still sending or editing this conversation.');
      return this.put({ ...task, status: 'cancelled', active: false, needsReview: false, dismissed: true, message: null }, now);
    }
    throw new Error('Unsupported shared schedule operation.');
  }
}

function run() {
  process.umask(0o077);
  const requested = process.argv[2] || path.join(os.homedir(), '.local/share/remote-codex/schedule-sync/schedules.sqlite');
  const file = requested.startsWith('~/') ? path.join(os.homedir(), requested.slice(2)) : requested;
  if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) throw new Error('Use an absolute server database path.');
  const store = new SharedScheduleDatabase(file);
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) { process.stderr.write('Shared schedule request exceeds 64 MB.\n'); process.exit(1); }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let request;
      try {
        request = JSON.parse(line);
        const response = store.request(request.method, request.params, request.owner);
        process.stdout.write(JSON.stringify({ id: request.id, ...response }) + '\n');
      } catch (error) { process.stdout.write(JSON.stringify({ id: request?.id ?? null, error: error.message }) + '\n'); }
    }
  });
  process.stdin.on('end', () => { store.close(); });
}
if (require.main === module) run();
module.exports = { SharedScheduleDatabase, leaseMs };

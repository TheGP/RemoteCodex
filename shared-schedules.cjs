const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { isDeepStrictEqual } = require('node:util');
const { connectionOptions } = require('./transport.cjs');
const defaultFolder = '~/.local/share/remote-codex/schedule-sync';
const historyRecoveryMs = 5 * 60000;
const historyRetryMs = 60000;

function sharingOptions(value = {}) {
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('Invalid schedule sharing setting.');
  const { host, port, key } = connectionOptions({ mode: 'ssh', host: value.host, port: value.port, key: value.key });
  const folder = value.folder === undefined ? defaultFolder : value.folder;
  if (typeof folder !== 'string' || folder.length > 4096 || /[\x00-\x1f\x7f]/.test(folder) || !folder.startsWith('/') && !folder.startsWith('~/')) throw new Error('Use an absolute server folder or ~/folder.');
  const normalized = (folder.startsWith('~/') ? '~/' + path.posix.normalize(folder.slice(2)) : path.posix.normalize(folder)).replace(/\/$/, '');
  if (!normalized || normalized === '~/.' || normalized.startsWith('~/../') || normalized === '~/..') throw new Error('Choose a dedicated sync folder.');
  return { enabled: value.enabled ?? false, host, port, key, folder: normalized };
}
const serverKey = options => JSON.stringify([options.host, options.port, ...(options.folder && options.folder !== defaultFolder ? [options.folder] : [])]);

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(file + '.tmp', 'w', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(file + '.tmp', file);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

class ScheduleBridge {
  constructor(owner, spawnProcess = spawn) {
    this.owner = owner; this.spawnProcess = spawnProcess; this.pending = new Map(); this.sequence = 0; this.generation = 0;
  }
  spawn(options, command) {
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-p', String(options.port)];
    if (options.key) args.push('-i', options.key.replace(/^~(?=[/\\])/, os.homedir()));
    args.push(options.host, command);
    return this.spawnProcess(process.platform === 'win32' ? 'ssh.exe' : '/usr/bin/ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  async connect(options) {
    if (this.child) return;
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const opening = this.open(options, generation).finally(() => { if (this.connecting === opening) this.connecting = null; });
    this.connecting = opening; return opening;
  }
  async open(options, generation) {
    // Only these app-owned helpers are installed; credentials and histories stay on the client.
    const files = Object.fromEntries(['shared-schedules-host.cjs', 'scheduler.cjs', 'queues.cjs'].map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
    const install = `const fs=require("node:fs"),path=require("node:path"),os=require("node:os");process.umask(63);let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const files=JSON.parse(input),dir=path.join(os.homedir(),".local/share/remote-codex/schedule-sync");fs.mkdirSync(dir,{recursive:true,mode:448});for(const name of ["shared-schedules-host.cjs","scheduler.cjs","queues.cjs"]){if(typeof files[name]!=="string")throw Error("Missing schedule helper");const file=path.join(dir,name);if(fs.existsSync(file)&&fs.readFileSync(file,"utf8")===files[name])continue;const temp=file+"."+process.pid+".tmp";fs.writeFileSync(temp,files[name],{mode:384});fs.renameSync(temp,file);}});`;
    const child = this.spawn(options, "node -e '" + install + "'");
    this.installing = child;
    await new Promise((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Schedule server installation timed out.')); }, 20000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || 'Could not install schedule server helpers.')); });
      child.stdin.end(JSON.stringify(files));
    });
    if (this.installing === child) this.installing = null;
    if (this.generation !== generation) throw new Error('Schedule storage connection changed.');
    const file = options.folder !== defaultFolder ? path.posix.join(options.folder, 'schedules.sqlite') : null;
    const argument = file ? " '" + file.replace(/'/g, "'\\''") + "'" : '';
    const process = this.spawn(options, 'exec node --no-warnings "$HOME/.local/share/remote-codex/schedule-sync/shared-schedules-host.cjs"' + argument);
    this.child = process;
    let buffer = '', stderr = '';
    const decoder = new StringDecoder('utf8');
    const fail = error => { if (this.child === process) this.close(error); };
    process.on('error', fail); process.stdin.on('error', fail);
    process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    process.on('close', () => fail(new Error(stderr.trim() || 'Schedule server disconnected.')));
    process.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) return fail(new Error('Schedule server response exceeds 64 MB.'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { return fail(new Error('Invalid schedule server response.')); }
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else { this.clockOffset = message.serverNow - Date.now(); request.resolve(message.result); }
      }
    });
    try {
      const hello = await this.call('hello');
      if (this.generation !== generation) throw new Error('Schedule storage connection changed.');
      if (hello?.protocol !== 1) throw new Error('Unsupported schedule server version.');
    } catch (error) { if (this.child === process) this.close(error); throw error; }
  }
  now() { return Date.now() + (this.clockOffset || 0); }
  call(method, params = {}) {
    if (!this.child) return Promise.reject(new Error('Schedule server is offline.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Schedule server request timed out.')), 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ id, method, params, owner: this.owner }) + '\n'); }
      catch (error) { this.close(error); }
    });
  }
  close(error = new Error('Schedule server disconnected.')) {
    this.generation++; this.installing?.kill(); this.installing = null; this.connecting = null;
    const child = this.child; this.child = null; child?.kill();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
}

class SharedSchedules {
  constructor({ file, store, connection, machine, blocked, dispatching, available, changed = () => {}, log = () => {}, bridge }) {
    Object.assign(this, { file, store, connection, machine, blocked, dispatching, available, changed, log });
    this.state = { version: 1, device: randomUUID(), options: sharingOptions(), tasks: [], receipts: [] };
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || typeof data.device !== 'string' || !Array.isArray(data.tasks) || !Array.isArray(data.receipts)) throw new Error('Invalid shared schedule settings.');
      this.state = { ...data, options: sharingOptions(data.options) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.bridge = bridge || new ScheduleBridge(this.state.device);
    this.locks = new Map(); this.retry = new Map(); this.finished = new Set(); this.receiptChecks = new Map(); this.error = null;
    this.timer = setInterval(() => this.renew().catch(error => this.failed(error)), 20000); this.timer.unref();
  }
  get enabled() { return this.state.options.enabled; }
  get key() { return serverKey(this.state.options); }
  save() { this.dirty = true; writePrivate(this.file, this.state); this.dirty = false; }
  settings() { return { ...this.state.options, connected: Boolean(this.bridge.child), error: this.error }; }
  async storageInfo() {
    const key = this.key;
    await this.online();
    const info = await this.bridge.call('storage-info');
    if (this.key !== key) throw new Error('Schedule storage changed. Try again.');
    return info;
  }
  tasks() { return this.state.server === this.key ? this.state.tasks.map(task => ({ ...structuredClone(task), shared: true })) : []; }
  summaries() {
    const shared = this.tasks();
    return [...this.store.summaries().filter(task => !task.sharedTo || !task.sharedImported && !shared.some(saved => saved.id === task.id)), ...shared];
  }
  owns(id) { return this.tasks().some(task => task.id === id) || this.store.tasks.some(task => task.id === id && task.sharedTo); }
  failed(error) { if (this.error === error.message) return; this.log('schedule.sync.failed', { error: error.message }); this.error = error.message; this.changed(); }
  async configure(value) {
    const options = sharingOptions(value);
    if (this.running || this.changing || this.bridge.connecting || this.bridge.pending?.size || this.locks.size || this.state.receipts.length) throw new Error('Wait for schedule sync to finish and close message editors before changing sharing.');
    if (serverKey(options) !== this.key && this.store.tasks.some(task => task.status === 'pending' && task.sharedTo === this.key && !task.sharedImported)) throw new Error('Finish uploading scheduled messages before choosing another server or folder.');
    if (serverKey(options) !== this.key && this.tasks().some(task => ['pending', 'claimed', 'sending', 'unconfirmed'].includes(task.status) || task.active)) throw new Error('Cancel or finish shared schedules before choosing another server or folder.');
    this.changing = true;
    try {
      this.bridge.close(); this.state.options = options; this.save(); this.error = null;
      if (options.enabled) await this.refresh(); this.changed(); return this.settings();
    }
    catch (error) { this.failed(error); throw error; }
    finally { this.changing = false; }
  }
  async online() {
    if (this.closed) throw new Error('Shared schedule client closed.');
    if (!this.enabled) throw new Error('Enable shared schedules in Settings first.');
    const options = this.state.options;
    await this.bridge.connect(options);
    if (this.state.options !== options) throw new Error('Schedule storage changed. Try again.');
  }
  async refresh() {
    const key = this.key;
    await this.online();
    const tasks = await this.bridge.call('list');
    if (this.key !== key) throw new Error('Schedule storage changed. Try again.');
    const changed = this.state.server !== key || !isDeepStrictEqual(this.state.tasks, tasks);
    const recovered = Boolean(this.error);
    if (changed || this.dirty) { this.state.server = key; this.state.tasks = tasks; this.save(); }
    this.error = null;
    if (changed || recovered) this.changed();
    return this.tasks();
  }
  async migrate() {
    let changed = false;
    try {
      for (const task of this.store.list().filter(task => task.status === 'pending' && !task.sharedImported && (!task.sharedTo || task.sharedTo === this.key))) {
        if (!task.sharedTo) this.store.update(task.id, { sharedTo: this.key });
        const saved = await this.bridge.call('import', { task });
        const { message, ...summary } = saved;
        if (!saved.retired) {
          this.state.server = this.key;
          this.state.tasks = [...this.state.tasks.filter(entry => entry.id !== saved.id), summary]; this.save();
        }
        this.store.update(task.id, { sharedImported: true, message: null });
        changed = true;
      }
    } finally { if (changed) this.changed(); }
  }
  async create(message, hours) {
    await this.online();
    const task = this.store.enqueue(message, hours, this.bridge.now(), this.key);
    // Once saved locally, delivery belongs to the outbox even if SSH drops before acknowledgement.
    try { await this.migrate(); await this.refresh(); }
    catch (error) { this.failed(error); }
    this.changed(); return task;
  }
  async mutation(method, params) {
    await this.online();
    const task = await this.bridge.call(method, params);
    await this.refresh(); return task;
  }
  async lock(threadId) {
    await this.online();
    const lease = await this.bridge.call('edit-lock', { threadId, machine: this.machine() });
    this.locks.set(lease.token, { ...lease, threadId, kind: 'edit' }); return lease.token;
  }
  async unlock(token) {
    this.locks.delete(token);
    if (this.enabled) { await this.online(); await this.bridge.call('unlock', { token }); }
  }
  async verify(token) {
    const lease = this.locks.get(token);
    if (!lease || lease.expiresAt <= this.bridge.now()) throw new Error('Shared editing lock expired. Reopen the message editor; your draft is saved.');
    await this.online();
    const tokens = await this.bridge.call('renew', { tokens: [token] });
    if (!tokens.includes(token)) { this.locks.delete(token); throw new Error('Shared editing lock expired. Reopen the message editor; your draft is saved.'); }
    lease.expiresAt = this.bridge.now() + 60000;
  }
  async renew() {
    if (!this.enabled || !this.locks.size) return;
    const eligible = [...this.locks].filter(([, lease]) => this.connection.ready && this.available() && (lease.kind === 'edit' || lease.task?.machine === this.machine())).map(([token]) => token);
    if (!eligible.length) {
      for (const [token, lease] of this.locks) if (lease.expiresAt <= this.bridge.now()) this.locks.delete(token);
      return;
    }
    await this.online();
    const tokens = await this.bridge.call('renew', { tokens: eligible });
    for (const [token, lease] of this.locks) {
      if (tokens.includes(token)) lease.expiresAt = this.bridge.now() + 60000;
      else if (eligible.includes(token) || lease.expiresAt <= this.bridge.now()) this.locks.delete(token);
    }
  }
  async flushReceipts() {
    for (const receipt of [...this.state.receipts]) {
      if (receipt.server !== this.key) continue;
      const saved = await this.bridge.call('finish', receipt);
      if (receipt.status === 'sent' && saved.status !== 'cancelled' && saved.active !== false) {
        if (!receipt.completed && receipt.machine !== this.machine()) continue;
        if (!receipt.completed) {
          const session = this.connection.session, now = this.bridge.now();
          const checked = this.receiptChecks.get(receipt.token);
          if (checked?.session === session && checked.machine === this.machine() && checked.nextAt > now) {
            const status = await this.connection.call('thread/read', { threadId: receipt.threadId, includeTurns: false }, 5000).catch(() => ({}));
            if (this.connection.session !== session || receipt.machine !== this.machine()) continue;
            if (!receipt.completed && (status.thread?.id !== receipt.threadId || status.thread.cwd !== receipt.cwd || status.thread.status?.type !== 'idle')) continue;
          }
          if (!receipt.completed) {
            this.receiptChecks.set(receipt.token, { session, machine: this.machine(), nextAt: now + historyRetryMs });
            const result = await this.connection.call('thread/read', { threadId: receipt.threadId, includeTurns: true }, 5000).catch(error => {
              this.log('schedule.receipt.deferred', { threadId: receipt.threadId, error: error.message }); return {};
            });
            if (this.connection.session !== session || receipt.machine !== this.machine()) continue;
            const turn = result.thread?.turns?.find(turn => turn.id === receipt.turnId);
            if (!receipt.completed) {
              if (result.thread?.id !== receipt.threadId || result.thread.cwd !== receipt.cwd || !turn) continue;
              if (!['completed', 'failed', 'interrupted'].includes(turn.status)) {
                this.receiptChecks.set(receipt.token, { session, machine: this.machine(), nextAt: now + historyRecoveryMs });
                continue;
              }
              receipt.completed = true; this.save();
            }
          }
        }
        await this.bridge.call('complete', receipt);
      }
      this.locks.delete(receipt.token); this.receiptChecks.delete(receipt.token);
      this.state.receipts = this.state.receipts.filter(entry => entry !== receipt); this.save();
    }
  }
  matches(task, thread) {
    return thread?.id === task.threadId && typeof task.cwd === 'string' && thread.cwd === task.cwd && (!task.message?.thread.createdAt || task.message.thread.createdAt === thread.createdAt);
  }
  completed({ threadId, turn } = {}) {
    if (!threadId || !turn?.id || !['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    const key = JSON.stringify([this.machine(), threadId, turn.id]);
    this.finished.add(key);
    if (this.finished.size > 1000) this.finished.delete(this.finished.values().next().value);
    let changed = false;
    for (const receipt of this.state.receipts) if (!receipt.completed && receipt.machine === this.machine() && receipt.threadId === threadId && receipt.turnId === turn.id) { receipt.completed = true; changed = true; }
    if (changed) this.save();
  }
  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const session = this.connection.session, machine = this.machine();
    const current = () => this.enabled && this.connection.ready && this.connection.session === session && this.machine() === machine && this.available();
    let refreshNeeded = false;
    try {
      await this.online(); await this.migrate();
      if (current()) await this.flushReceipts();
      await this.refresh();
      for (const task of this.tasks().filter(task => task.machine === machine && task.status === 'pending' && Date.parse(task.runAt) <= this.bridge.now())) {
        if (!current()) break;
        if (this.blocked(task.threadId) || (this.retry.get(task.id) || 0) > Date.now()) continue;
        this.dispatching.add(task.threadId);
        let claim, begun = false;
        try {
          const before = await this.connection.call('thread/read', { threadId: task.threadId, includeTurns: false }, 5000);
          if (!current() || !this.matches(task, before.thread) || before.thread.status?.type === 'active') continue;
          refreshNeeded = true;
          claim = await this.bridge.call('claim', { id: task.id });
          if (!claim) continue;
          this.locks.set(claim.token, { ...claim, threadId: task.threadId, kind: 'delivery' });
          const resumed = await this.connection.call('thread/resume', { threadId: task.threadId, excludeTurns: true });
          if (!current() || !this.matches(claim.task, resumed.thread) || resumed.thread.status?.type === 'active' || this.blocked(task.threadId)) continue;
          await this.bridge.call('begin', { id: task.id, token: claim.token }); begun = true;
          let receipt;
          try {
            if (!current()) throw new Error('Agent connection changed before delivery.');
            const message = claim.task.message;
            const result = await this.connection.call('turn/start', message ? { ...message.turnSettings, threadId: task.threadId, input: message.input } : { threadId: task.threadId, input: [{ type: 'text', text: claim.task.prompt }] });
            if (!result.turn?.id) throw new Error('Agent did not confirm a turn identity.');
            receipt = { id: task.id, token: claim.token, threadId: task.threadId, cwd: claim.task.cwd, machine, turnId: result.turn.id, status: 'sent', server: this.key, completed: ['completed', 'failed', 'interrupted'].includes(result.turn.status) || this.finished.has(JSON.stringify([machine, task.threadId, result.turn.id])) };
          } catch (error) {
            receipt = { id: task.id, token: claim.token, threadId: task.threadId, machine, status: 'unconfirmed', server: this.key };
            this.log('schedule.delivery.unconfirmed', { threadId: task.threadId, error: error.message });
          }
          this.state.receipts.push(receipt); this.save();
          if (receipt.status === 'sent') this.receiptChecks.set(receipt.token, { session, machine, nextAt: this.bridge.now() + historyRecoveryMs });
          await this.flushReceipts();
        } catch (error) {
          this.retry.set(task.id, Date.now() + 60000); this.log('schedule.delivery.deferred', { threadId: task.threadId, error: error.message });
        } finally {
          if (claim && !begun) {
            await this.bridge.call('release', { id: task.id, token: claim.token }).catch(error => this.failed(error));
            this.locks.delete(claim.token);
          }
          this.dispatching.delete(task.threadId);
        }
      }
      if (refreshNeeded) await this.refresh();
    } catch (error) { this.failed(error); }
    finally { this.running = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); this.bridge.close(); }
}
module.exports = { SharedSchedules, ScheduleBridge, sharingOptions, serverKey, writePrivate, defaultFolder };

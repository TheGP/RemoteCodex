const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('./package.json');
const { stderrDiagnostic } = require('./diagnostics.cjs');

function connectionOptions(value = {}) {
  const mode = value.mode ?? 'ssh';
  if (!['local', 'ssh'].includes(mode)) throw new Error('Choose Local or SSH.');
  const host = String(value.host || 'root@warmer').trim();
  const port = Number(value.port ?? 22);
  const key = String(value.key || '').trim();
  const cwd = String(value.cwd || '/root').trim();
  const localCwd = String(value.localCwd || os.homedir()).trim();
  const codexPath = String(value.codexPath || '').trim();
  if (mode === 'ssh') {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]*$/.test(host)) throw new Error('Enter an SSH host such as root@warmer.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535.');
    if (!cwd.startsWith('/') || cwd.includes('\0')) throw new Error('Use an absolute folder on the server.');
    if (key.includes('\0')) throw new Error('Invalid SSH key path.');
  } else {
    if (!path.isAbsolute(localCwd) || localCwd.includes('\0')) throw new Error('Use an absolute local workspace folder.');
    if (codexPath && (!path.isAbsolute(codexPath) || codexPath.includes('\0'))) throw new Error('Use an absolute path to the Codex executable.');
  }
  return { mode, host, port, key, cwd, localCwd, codexPath };
}

function localLaunch(options) {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir));
  directories.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const root of [path.join(os.homedir(), '.local/share/nvm'), path.join(os.homedir(), '.nvm/versions/node')]) {
    try {
      for (const version of fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) directories.push(path.join(root, version, 'bin'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (process.platform === 'win32' && process.env.APPDATA) directories.push(path.join(process.env.APPDATA, 'npm'));
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  const managedCodex = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'packages/app-server-daemon/current/bin', names[0]);
  const candidates = options.codexPath ? [options.codexPath] : [managedCodex, ...directories.flatMap(dir => names.map(name => path.join(dir, name)))];
  const executable = candidates.find(candidate => {
    try { fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('Local Codex executable not found. Set its absolute path in connection settings.');
  let entry = fs.realpathSync(executable);
  if (/\.cmd$/i.test(entry)) entry = path.join(path.dirname(entry), 'node_modules/@openai/codex/bin/codex.js');
  const env = { ...process.env, PATH: [path.dirname(executable), ...directories].join(path.delimiter) };
  if (/\.m?js$/i.test(entry)) {
    fs.accessSync(entry, fs.constants.R_OK);
    const node = [path.dirname(executable), ...directories].map(dir => path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')).find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!node) throw new Error('Node.js is required by this Codex installation but was not found.');
    return { command: node, args: [entry, 'app-server', '--listen', 'stdio://'], env };
  }
  return { command: entry, args: ['app-server', '--listen', 'stdio://'], env };
}

class CodexConnection extends EventEmitter {
  constructor(spawnProcess = spawn) {
    super();
    this.pending = new Map();
    this.requests = new Map();
    this.sequence = 0;
    this.receivedSequence = 0;
    this.child = null;
    this.ready = false;
    this.spawnProcess = spawnProcess;
  }

  async connect(options, schedulerMcp = null) {
    options = connectionOptions(options);
    this.disconnect();
    let command, args, env, cwd;
    if (options.mode === 'local') {
      ({ command, args, env } = localLaunch(options));
      cwd = options.localCwd;
      if (schedulerMcp) {
        args.push('-c', `mcp_servers.remote_codex_scheduler.url=${JSON.stringify(schedulerMcp.url)}`, '-c', 'mcp_servers.remote_codex_scheduler.bearer_token_env_var="REMOTE_CODEX_SCHEDULER_TOKEN"');
        env.REMOTE_CODEX_SCHEDULER_TOKEN = schedulerMcp.token;
      }
    } else {
      command = process.platform === 'win32' ? 'ssh.exe' : '/usr/bin/ssh';
      args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-p', String(options.port)];
      if (options.key) args.push('-i', options.key.replace(/^~(?=[/\\])/, os.homedir()));
      args.push(options.host, 'exec codex app-server --listen stdio://');
    }
    const child = this.spawnProcess(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env, cwd } : {}) });
    this.child = child;
    this.emit('diagnostic', { event: 'process.started', details: { source: options.mode, pid: child.pid } });
    let stderr = '';
    const stderrDecoder = new StringDecoder('utf8');
    let stderrLine = '', warningWindow = Date.now(), warningCount = 0, droppedWarnings = 0;
    const warning = line => {
      if (this.child !== child) return;
      const details = stderrDiagnostic(line);
      if (!details) return;
      if (Date.now() - warningWindow >= 30000) {
        if (droppedWarnings) this.emit('diagnostic', { event: 'process.stderr.suppressed', details: { count: droppedWarnings } });
        warningWindow = Date.now(); warningCount = 0; droppedWarnings = 0;
      }
      if (++warningCount <= 20) this.emit('diagnostic', { event: 'process.stderr', details });
      else droppedWarnings++;
    };
    child.stderr.on('data', chunk => {
      const text = stderrDecoder.write(chunk);
      stderr = (stderr + text).slice(-6000);
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        stderrLine = (stderrLine + lines[index]).slice(0, 8192);
        if (index < lines.length - 1) { warning(stderrLine); stderrLine = ''; }
      }
    });
    child.stderr.on('end', () => { warning(stderrLine + stderrDecoder.end()); stderrLine = ''; });
    const fail = error => {
      if (this.child !== child) return;
      this.disconnect();
      this.emit('notification', { method: 'connection/closed', params: { message: error.message } });
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', (code, signal) => {
      if (this.child === child) this.emit('diagnostic', { event: 'process.exited', details: { exitCode: code, signal, count: droppedWarnings } });
      fail(new Error(stderr.trim() || `${options.mode === 'local' ? 'Local Codex' : 'SSH connection'} closed (${code}).`));
    });
    const receive = line => {
      if (this.child !== child || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { this.emit('diagnostic', { event: 'rpc.invalid-message', details: { source: 'stdout', error: 'Codex returned invalid JSON.' } }); return; }
      const receivedSequence = ++this.receivedSequence;
      if (message.method) {
        if (message.id !== undefined) this.requests.set(message.id, message);
        this.emit('notification', { ...message, receivedSequence });
      } else if (this.pending.has(message.id)) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        this.emit('diagnostic', { event: message.error ? 'rpc.failed' : 'rpc.completed', details: { ...request.diagnostic, durationMs: Date.now() - request.startedAt, status: message.result?.turn?.status || message.result?.thread?.status?.type, error: message.error?.message } });
        this.emit('rpc', { phase: 'finished', requestId: message.id, method: request.method, threadId: request.threadId, result: message.result });
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(request.method === 'thread/turns/list' ? { ...message.result, receivedSequence } : message.result);
      }
    };
    const decoder = new StringDecoder('utf8');
    let fragments = [];
    child.stdout.on('data', chunk => {
      const parts = decoder.write(chunk).split('\n');
      for (let index = 0; index < parts.length - 1; index++) {
        fragments.push(parts[index]); const line = fragments.join(''); fragments = []; receive(line);
      }
      if (parts.at(-1)) fragments.push(parts.at(-1));
    });
    child.stdout.on('end', () => {
      fragments.push(decoder.end()); receive(fragments.join('')); fragments = [];
    });
    try {
      const result = await this.call('initialize', { clientInfo: { name: 'remote_codex', title: 'Remote Codex', version }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      this.ready = true;
      return result;
    } catch (error) {
      if (this.child === child) this.disconnect();
      throw new Error(stderr.trim() || error.message);
    }
  }

  write(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Connect to Codex first.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params = {}, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const diagnostic = { requestId: id, method, threadId: params?.threadId, turnId: params?.turnId || params?.expectedTurnId };
      const startedAt = Date.now();
      this.emit('diagnostic', { event: 'rpc.started', details: diagnostic });
      this.emit('rpc', { phase: 'started', requestId: id, method, threadId: params?.threadId });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.emit('diagnostic', { event: 'rpc.timeout', details: { ...diagnostic, durationMs: Date.now() - startedAt } });
        this.emit('rpc', { phase: 'finished', requestId: id, method, threadId: params?.threadId });
        reject(new Error(`${method} timed out. Reconnect before retrying; the server may have received the request.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, threadId: params?.threadId, diagnostic, startedAt });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.emit('diagnostic', { event: 'rpc.failed', details: { ...diagnostic, error: error.message } });
        this.emit('rpc', { phase: 'finished', requestId: id, method, threadId: params?.threadId });
        reject(error);
      }
    });
  }

  respond(id, result) {
    if (!this.requests.has(id)) throw new Error('This request is no longer pending.');
    this.write({ id, result });
    this.requests.delete(id);
  }

  rejectRequest(id) {
    this.write({ id, error: { code: -32601, message: 'This client does not support this request.' } });
    this.requests.delete(id);
  }

  disconnect() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) { child.stdin.end(); child.kill(); }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      this.emit('diagnostic', { event: 'rpc.disconnected', details: { ...request.diagnostic, durationMs: Date.now() - request.startedAt } });
      request.reject(new Error('Disconnected from server.'));
    }
    this.pending.clear();
    this.requests.clear();
    this.emit('disconnected');
  }
}

module.exports = { CodexConnection, connectionOptions, localLaunch };

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('./package.json');

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

  async connect(options) {
    options = connectionOptions(options);
    this.disconnect();
    let command, args, env, cwd;
    if (options.mode === 'local') {
      ({ command, args, env } = localLaunch(options));
      cwd = options.localCwd;
    } else {
      command = process.platform === 'win32' ? 'ssh.exe' : '/usr/bin/ssh';
      args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-p', String(options.port)];
      if (options.key) args.push('-i', options.key.replace(/^~(?=[/\\])/, os.homedir()));
      args.push(options.host, 'exec codex app-server --listen stdio://');
    }
    const child = this.spawnProcess(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env, cwd } : {}) });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    const fail = error => {
      if (this.child !== child) return;
      this.disconnect();
      this.emit('notification', { method: 'connection/closed', params: { message: error.message } });
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => fail(new Error(stderr.trim() || `${options.mode === 'local' ? 'Local Codex' : 'SSH connection'} closed (${code}).`)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (this.child !== child || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const receivedSequence = ++this.receivedSequence;
      if (message.method) {
        if (message.id !== undefined) this.requests.set(message.id, message);
        this.emit('notification', { ...message, receivedSequence });
      } else if (this.pending.has(message.id)) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(request.method === 'thread/turns/list' ? { ...message.result, receivedSequence } : message.result);
      }
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. Reconnect before retrying; the server may have received the request.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
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
      request.reject(new Error('Disconnected from server.'));
    }
    this.pending.clear();
    this.requests.clear();
  }
}

module.exports = { CodexConnection, connectionOptions, localLaunch };

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const fields = new Set(['source', 'machine', 'threadId', 'turnId', 'method', 'requestId', 'queueLength', 'queueCount', 'paused', 'phase', 'reason', 'error', 'connected', 'owned', 'working', 'steer', 'delayHours', 'status', 'willRetry', 'durationMs', 'version', 'level', 'module', 'idleMs', 'firstOutputMs', 'pendingRequests', 'count', 'pid', 'exitCode', 'signal']);

function stderrDiagnostic(line) {
  line = line.replace(/\x1b\[[0-9;]*m/g, '');
  const level = line.match(/\b(WARN|ERROR)\b/)?.[1];
  if (!level) return null;
  const reason = [
    ['timeout', /timed? out|timeout/i], ['rate-limit', /rate.?limit|\b429\b/i],
    ['authentication', /unauthori[sz]ed|forbidden|\b40[13]\b/i],
    ['connection', /disconnect|connection|broken pipe|network|dns/i],
    ['overloaded', /overload|\b50[234]\b/i], ['retry', /retry/i]
  ].find(([, pattern]) => pattern.test(line))?.[0] || 'unclassified';
  const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
  return {
    source: 'stderr', level, reason,
    module: line.match(/\b(?:WARN|ERROR)\s+([a-zA-Z_][\w]*(?:::[\w]+)+):/)?.[1],
    threadId: line.match(new RegExp('(?:thread[_.]id|conversation[.]id)=["\']?(' + uuid + ')', 'i'))?.[1],
    turnId: line.match(new RegExp('turn[_.]id=["\']?(' + uuid + ')', 'i'))?.[1]
  };
}

class TurnDiagnostics {
  constructor(connection, now = Date.now) {
    this.connection = connection;
    this.now = now;
    this.turns = new Map();
    this.finished = new Set();
    connection.on('notification', message => this.notification(message));
    connection.on('rpc', event => {
      if (event.phase === 'finished' && event.result?.turn?.status === 'inProgress') this.start(event.threadId, event.result.turn.id);
    });
    connection.on('disconnected', () => {
      for (const [threadId] of this.turns) this.finish(threadId, null, 'disconnected');
      this.finished.clear();
    });
  }

  write(event, threadId, record, extra = {}) {
    this.connection.emit('diagnostic', { event, details: {
      threadId, turnId: record.turnId, phase: record.phase,
      durationMs: this.now() - record.startedAt, idleMs: this.now() - record.lastAt,
      firstOutputMs: record.firstOutputMs,
      pendingRequests: [...this.connection.requests.values()].filter(request => request.params?.threadId === threadId).length,
      ...extra
    } });
  }

  start(threadId, turnId) {
    if (!threadId || !turnId || this.finished.has(threadId + ':' + turnId) || this.turns.get(threadId)?.turnId === turnId) return;
    this.finish(threadId, null, 'replaced');
    this.turns.set(threadId, { turnId, startedAt: this.now(), lastAt: this.now(), phase: 'waiting-for-output', quiet: false });
  }

  finish(threadId, turnId, reason) {
    const record = this.turns.get(threadId);
    if (!record || turnId && record.turnId !== turnId) return;
    this.write('turn.summary', threadId, record, { reason });
    this.turns.delete(threadId);
    this.finished.add(threadId + ':' + record.turnId);
    if (this.finished.size > 1000) this.finished.delete(this.finished.values().next().value);
  }

  notification({ method, params = {}, id }) {
    const { threadId, turnId, turn, item } = params;
    if (method === 'turn/started') this.start(threadId, turn?.id);
    if (method === 'turn/completed') { this.finish(threadId, turn?.id, turn?.status); return; }
    if (method === 'thread/status/changed' && params.status?.type !== 'active') { this.finish(threadId, null, 'thread-' + params.status?.type); return; }
    const record = this.turns.get(threadId);
    if (!record || turnId && turnId !== record.turnId) return;
    const output = /^item\/(agentMessage|reasoning|plan)\//.test(method) || method === 'item/completed' && ['agentMessage', 'reasoning', 'plan'].includes(item?.type);
    const progress = output || ['item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress'].includes(method);
    const lifecycle = ['item/started', 'item/completed', 'error'].includes(method) || id !== undefined;
    if (!progress && !lifecycle) return;
    if (record.quiet) this.write('turn.resumed', threadId, record, { method });
    record.quiet = false;
    record.lastAt = this.now();
    record.phase = ['agentMessage', 'reasoning', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall'].includes(item?.type) ? item.type + (method === 'item/completed' ? ':completed' : ':started') : method;
    if (output && record.firstOutputMs === undefined) {
      record.firstOutputMs = this.now() - record.startedAt;
      this.write('turn.first-output', threadId, record);
    } else if (lifecycle) this.write('turn.activity', threadId, record, { method, status: item?.status });
  }

  check() {
    for (const [threadId, record] of this.turns) if (!record.quiet && this.now() - record.lastAt >= 60000) {
      this.write('turn.quiet', threadId, record);
      record.quiet = true;
    }
  }
}

function redact(value) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/\b(password|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1=[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"<>]+/gi, '[url]');
}

class DiagnosticLog {
  constructor(directory, { maxBytes = MAX_LOG_BYTES, report = console.error } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > MAX_LOG_BYTES) throw new Error('Invalid diagnostic log size.');
    this.directory = directory;
    this.file = path.join(directory, 'diagnostics.log');
    this.previous = path.join(directory, 'diagnostics.1.log');
    this.partBytes = Math.floor(maxBytes / 2);
    this.report = report;
    this.warned = false;
  }

  write(event, details = {}) {
    if (typeof event !== 'string' || !/^[\w./-]{1,100}$/.test(event)) return false;
    try {
      const safe = {};
      if (details && typeof details === 'object') for (const [key, value] of Object.entries(details)) {
        if (!fields.has(key)) continue;
        if (typeof value === 'string') safe[key] = redact(value).slice(0, key === 'error' ? 2048 : 200);
        else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      }
      const record = { at: new Date().toISOString(), event, ...safe };
      let line = Buffer.from(JSON.stringify(record) + '\n');
      if (line.length > Math.min(this.partBytes, 8192)) line = Buffer.from(JSON.stringify({ at: record.at, event, reason: 'Oversized diagnostic entry omitted' }) + '\n');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const size = file => { try { return fs.statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
      if (size(this.previous) > this.partBytes) fs.truncateSync(this.previous, 0);
      if (size(this.file) > this.partBytes) fs.truncateSync(this.file, 0);
      if (size(this.file) + line.length > this.partBytes) {
        fs.rmSync(this.previous, { force: true });
        fs.renameSync(this.file, this.previous);
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      return true;
    } catch (error) {
      if (!this.warned) { this.warned = true; this.report(`Could not write diagnostic log: ${error.message}`); }
      return false;
    }
  }
}

module.exports = { DiagnosticLog, MAX_LOG_BYTES, stderrDiagnostic, TurnDiagnostics };

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const fields = new Set(['source', 'machine', 'threadId', 'turnId', 'method', 'requestId', 'queueLength', 'queueCount', 'paused', 'phase', 'reason', 'error', 'connected', 'owned', 'working', 'steer', 'delayHours', 'status', 'willRetry', 'durationMs', 'version']);

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

module.exports = { DiagnosticLog, MAX_LOG_BYTES };

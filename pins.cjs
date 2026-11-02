const fs = require('node:fs');
const path = require('node:path');

class PinStore {
  constructor(file) { this.file = file; }

  key(options) {
    return JSON.stringify(options.mode === 'local' ? ['local', process.env.CODEX_HOME || 'default'] : ['ssh', options.host, Number(options.port)]);
  }

  read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('Invalid saved conversation pins.');
    return data;
  }

  get(options) { return this.read()[this.key(options)] || []; }

  set(options, threadId, pinned) {
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200 || typeof pinned !== 'boolean') throw new Error('Invalid conversation pin.');
    const data = this.read();
    const key = this.key(options);
    const ids = new Set(data[key] || []);
    if (pinned) ids.add(threadId); else ids.delete(threadId);
    data[key] = [...ids];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return data[key];
  }
}

module.exports = { PinStore };

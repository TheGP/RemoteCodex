const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function validate(queue) {
  if (!queue || typeof queue.machine !== 'string' || !queue.machine.startsWith('access:') || queue.machine.length > 500 || typeof queue.thread?.id !== 'string' || !queue.thread.id || queue.thread.id.length > 200 || typeof queue.thread.cwd !== 'string' || queue.key !== queue.machine + ':' + queue.thread.id || !Array.isArray(queue.messages) || queue.messages.some(message => !message || message.machine !== queue.machine || message.thread?.id !== queue.thread.id || typeof message.text !== 'string' || !Array.isArray(message.images) || !Array.isArray(message.input) || !['read-only', 'workspace-write', 'danger-full-access'].includes(message.access?.sandbox) || !['never', 'on-request'].includes(message.access?.approvalPolicy))) throw new Error('Invalid saved message queue.');
}

class QueueStore {
  constructor(directory) { this.directory = directory; }

  file(key) { return path.join(this.directory, createHash('sha256').update(key).digest('hex') + '.json'); }

  hasMessages(key) {
    try {
      const queue = JSON.parse(fs.readFileSync(this.file(key), 'utf8')); validate(queue);
      return queue.messages.length > 0;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  list() {
    let files;
    try { files = fs.readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(file => file.endsWith('.json')).map(file => {
      const queue = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
      validate(queue);
      if (queue.version !== 1 || path.basename(this.file(queue.key)) !== file) throw new Error('Invalid saved message queue.');
      return { ...queue, paused: true };
    });
  }

  save(queue) {
    validate(queue);
    const file = this.file(queue.key);
    if (!queue.messages.length) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return;
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const data = { version: 1, key: queue.key, machine: queue.machine, thread: queue.thread, messages: queue.messages, paused: Boolean(queue.paused) };
    fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
}

module.exports = { QueueStore, validateQueue: validate };

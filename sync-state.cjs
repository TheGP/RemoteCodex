const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const kinds = new Set(['pin', 'finished', 'messagePin', 'unread', 'completion', 'draft', 'project', 'thread', 'shortcuts', 'history', 'projectPath', 'note']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f\x7f]/.test(value);
const stateKey = (kind, machine, id) => {
  if (!kinds.has(kind) || !validId(machine) || !machine.startsWith('access:') || !validId(id)) throw new Error('Invalid synced conversation identity.');
  return JSON.stringify([kind, machine, id]);
};
const hash = value => createHash('sha256').update(value).digest('hex');
const blobGraceMs = 60 * 60 * 1000;

class StateDatabase {
  constructor(db) {
    this.db = db;
    const maximum = db.prepare('PRAGMA max_page_count').get().max_page_count;
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const migrating = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='sync_blob_usage'").get();
    const reserve = 16;
    const expanded = migrating && maximum - pages + free < reserve;
    if (expanded) db.exec(`PRAGMA max_page_count=${pages + reserve}`);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS sync_entries(key TEXT PRIMARY KEY,kind TEXT NOT NULL,machine TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,writer TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sync_revision ON sync_entries(revision);
      CREATE TABLE IF NOT EXISTS sync_ops(id TEXT PRIMARY KEY,key TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_blobs(hash TEXT PRIMARY KEY,data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_blob_usage(hash TEXT PRIMARY KEY,touched_at INTEGER NOT NULL);`);
      db.exec('CREATE TABLE IF NOT EXISTS sync_owners(machine TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,requested TEXT,requested_name TEXT,epoch INTEGER NOT NULL,busy INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(machine,id))');
      if (!db.prepare('PRAGMA table_info(sync_owners)').all().some(column => column.name === 'run_token')) db.exec('ALTER TABLE sync_owners ADD COLUMN run_token TEXT');
      db.prepare("INSERT OR IGNORE INTO sync_blob_usage VALUES('',?)").run(Date.now());
    } finally {
      if (expanded) db.exec(`PRAGMA max_page_count=${Math.max(maximum, db.prepare('PRAGMA page_count').get().page_count)}`);
    }
  }
  entry(row) { return row ? { ...row, value: JSON.parse(row.value) } : null; }
  get(key) { return this.entry(this.db.prepare('SELECT * FROM sync_entries WHERE key=?').get(key)); }
  collectBlobs(now) {
    this.db.prepare(`DELETE FROM sync_blobs WHERE hash IN (SELECT blob.hash FROM sync_blobs blob LEFT JOIN sync_blob_usage usage ON blob.hash=usage.hash
        WHERE COALESCE(usage.touched_at,(SELECT touched_at FROM sync_blob_usage WHERE hash=''))<?)
      AND hash NOT IN (SELECT json_extract(image.value,'$.hash') FROM sync_entries entry,json_each(entry.value,'$.images') image
        WHERE entry.kind='draft' AND json_type(image.value,'$.hash')='text')
      AND hash NOT IN (SELECT json_extract(blob.value,'$.hash') FROM sync_entries entry,json_each(entry.value,'$.blobs') blob
        WHERE entry.kind='history' AND json_type(blob.value,'$.hash')='text')`).run(now - blobGraceMs);
    this.db.prepare("DELETE FROM sync_blob_usage WHERE hash<>'' AND hash NOT IN (SELECT hash FROM sync_blobs)").run();
    this.nextBlobGc = now + 60000;
  }
  touchBlob(id, now) { this.db.prepare('INSERT INTO sync_blob_usage VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET touched_at=excluded.touched_at').run(id, now); }
  request(method, args, owner, now = Date.now()) {
    if (method.startsWith('history-')) {
      if (!validId(args.machine) || !args.machine.startsWith('access:')) throw new Error('Invalid conversation machine.');
      if (method === 'history-owners') return { owners: this.db.prepare('SELECT * FROM sync_owners WHERE machine=?').all(args.machine) };
      stateKey('history', args.machine, args.id);
      let current = this.db.prepare('SELECT * FROM sync_owners WHERE machine=? AND id=?').get(args.machine, args.id);
      if (method === 'history-request' || method === 'history-claim') {
        if (!validId(args.name) || args.name.length > 100) throw new Error('Invalid computer name.');
        if (!current) {
          this.db.prepare('INSERT INTO sync_owners(machine,id,owner,name,requested,requested_name,epoch) VALUES(?,?,?,?,NULL,NULL,1)').run(args.machine, args.id, owner, args.name);
        } else if (current.owner !== owner && method === 'history-request') {
          if (current.requested && current.requested !== owner) throw new Error('Another computer is already waiting for this conversation.');
          this.db.prepare('UPDATE sync_owners SET requested=?,requested_name=? WHERE machine=? AND id=?').run(owner, args.name, args.machine, args.id);
        }
      } else if (method === 'history-release') {
        if (!current || current.owner !== owner || current.epoch !== args.epoch || !current.requested || current.busy) throw new Error('Conversation ownership changed or its task is still running.');
        const saved = this.get(stateKey('history', args.machine, args.id));
        if (!saved || saved.value?.digest !== args.digest || saved.value?.epoch !== current.epoch) throw new Error('Finish uploading conversation history before transferring it.');
        this.db.prepare('UPDATE sync_owners SET owner=requested,name=requested_name,requested=NULL,requested_name=NULL,epoch=epoch+1 WHERE machine=? AND id=?').run(args.machine, args.id);
      } else if (method === 'history-verify' || method === 'history-begin') {
        if (!current || current.owner !== owner || current.epoch !== args.epoch || current.requested) throw new Error('Use this conversation on this computer before sending messages.');
        if (method === 'history-begin') {
          if (current.busy) throw new Error('This conversation already has a running task.');
          this.db.prepare('UPDATE sync_owners SET busy=1,run_token=? WHERE machine=? AND id=?').run(randomUUID(), args.machine, args.id);
        }
      } else if (method === 'history-end') {
        if (!current || current.owner !== owner || current.epoch !== args.epoch) throw new Error('Conversation ownership changed.');
        if ((current.run_token || null) === (args.runToken || null)) this.db.prepare('UPDATE sync_owners SET busy=0,run_token=NULL WHERE machine=? AND id=?').run(args.machine, args.id);
      } else throw new Error('Unsupported conversation ownership operation.');
      return this.db.prepare('SELECT * FROM sync_owners WHERE machine=? AND id=?').get(args.machine, args.id);
    }
    if (method === 'blob-prepare') {
      if (!Array.isArray(args.hashes) || args.hashes.length > 500 || args.hashes.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid attachment identities.');
      const missing = [];
      for (const id of args.hashes) {
        if (this.db.prepare('SELECT 1 FROM sync_blobs WHERE hash=?').get(id)) this.touchBlob(id, now);
        else missing.push(id);
      }
      this.collectBlobs(now); return { missing };
    }
    if (method === 'state-get') return this.get(stateKey(args.kind, args.machine, args.id));
    if (method === 'state-pull') {
      if (!Number.isSafeInteger(args.cursor) || args.cursor < 0) throw new Error('Invalid sync cursor.');
      if (!this.nextBlobGc || now >= this.nextBlobGc) this.collectBlobs(now);
      const rows = this.db.prepare('SELECT * FROM sync_entries WHERE revision>? ORDER BY revision LIMIT 201').all(args.cursor);
      const entries = []; let bytes = 0;
      for (const row of rows.slice(0, 200)) {
        bytes += Buffer.byteLength(row.value);
        if (entries.length && bytes > 8 * 1024 * 1024) break;
        entries.push(this.entry(row));
      }
      return { entries, cursor: entries.at(-1)?.revision ?? args.cursor, more: rows.length > entries.length };
    }
    if (method === 'state-push') {
      if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 50) throw new Error('Invalid sync operations.');
      if (args.isolateErrors === true) return args.operations.map(op => {
        try { return this.request('state-push', { operations: [op] }, owner, now)[0]; }
        catch (error) { return { opId: op?.opId, error: error.message }; }
      });
      const operations = args.operations.map(op => {
        const key = stateKey(op.kind, op.machine, op.id);
        if (!validId(op.opId) || !Number.isSafeInteger(op.base) || op.base < 0 || op.value === undefined || Buffer.byteLength(JSON.stringify(op.value)) > 1024 * 1024) throw new Error('Invalid synced conversation change.');
        const receipt = this.db.prepare('SELECT * FROM sync_ops WHERE id=?').get(op.opId);
        if (receipt) {
          if (receipt.key !== key) throw new Error('Sync operation identity was reused.');
          return { ...op, key, receipt };
        }
        if (['pin', 'finished', 'unread'].includes(op.kind) && typeof op.value !== 'boolean' && op.value !== null) throw new Error('Invalid synced marker.');
        if (op.kind === 'projectPath') {
          let identity;
          try { identity = JSON.parse(op.id); } catch { throw new Error('Invalid shared project folder identity.'); }
          if (!Array.isArray(identity) || identity.length !== 2 || !validId(identity[0]) || identity[1] !== owner) throw new Error('Only this computer can publish its project folders.');
          if (op.value !== null && (!Array.isArray(op.value?.roots) || !op.value.roots.length || op.value.roots.length > 100 || op.value.roots.some(root => typeof root !== 'string' || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root) || !path.posix.isAbsolute(root) && !path.win32.isAbsolute(root) || /^[\\/]{2}/.test(root)))) throw new Error('Invalid shared project folder.');
        }
        if (op.kind === 'note' && op.value !== null && (typeof op.value !== 'string' || !op.value.trim() || op.value.length > 4000 || op.value.includes('\0'))) throw new Error('Invalid synced conversation note.');
        if (op.kind === 'completion' && op.value !== null && !['completed', 'failed'].includes(op.value?.status || op.value)) throw new Error('Invalid synced completion.');
        if (op.value && op.kind === 'draft') for (const image of op.value.images || []) {
          if (!/^[a-f0-9]{64}$/.test(image.hash) || !this.db.prepare('SELECT 1 FROM sync_blobs WHERE hash=?').get(image.hash)) throw new Error('Upload draft attachments before publishing the draft.');
        }
        if (op.kind === 'history') {
          const access = this.db.prepare('SELECT * FROM sync_owners WHERE machine=? AND id=?').get(op.machine, op.id);
          if (!access || access.owner !== owner || !op.value || op.value.epoch !== access.epoch) throw new Error('Conversation is owned by another computer.');
          if (!Array.isArray(op.value.blobs) || op.value.blobs.length > 628 || !/^[a-f0-9]{64}$/.test(op.value.digest)) throw new Error('Invalid conversation snapshot.');
          for (const blob of op.value.blobs) if (!/^[a-f0-9]{64}$/.test(blob.hash) || !this.db.prepare('SELECT 1 FROM sync_blobs WHERE hash=?').get(blob.hash)) throw new Error('Upload conversation history before publishing it.');
        }
        return { ...op, key, receipt: null };
      });
      return operations.map(op => {
        const receipt = op.receipt || this.db.prepare('SELECT * FROM sync_ops WHERE id=?').get(op.opId);
        const current = this.get(op.key);
        if (receipt) {
          if (receipt.key !== op.key) throw new Error('Sync operation identity was reused.');
          return { opId: op.opId, revision: receipt.revision, current };
        }
        if (op.seed && current) return { opId: op.opId, revision: current.revision, current, seeded: true };
        if (['draft', 'note'].includes(op.kind) && op.stale) return { opId: op.opId, conflict: true, current };
        if (op.kind === 'completion' && op.value === null && current?.value?.turnId && op.observedTurn !== current.value.turnId) return { opId: op.opId, conflict: true, current };
        if (['draft', 'shortcuts', 'unread', 'completion', 'history', 'note'].includes(op.kind) && !op.seed && (current?.revision || 0) !== op.base) return { opId: op.opId, conflict: true, current };
        const revision = this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS value FROM sync_entries').get().value;
        this.db.exec('SAVEPOINT sync_operation');
        try {
          this.db.prepare('INSERT INTO sync_entries VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value,writer=excluded.writer')
            .run(op.key, op.kind, op.machine, op.id, revision, JSON.stringify(op.value), owner);
          this.db.prepare('INSERT INTO sync_ops VALUES(?,?,?)').run(op.opId, op.key, revision);
          this.db.exec('RELEASE sync_operation');
        } catch (error) {
          try { this.db.exec('ROLLBACK TO sync_operation'); this.db.exec('RELEASE sync_operation'); } catch {}
          throw error;
        }
        return { opId: op.opId, revision, current: this.get(op.key) };
      });
    }
    if (method === 'blob-put') {
      if (!/^[a-f0-9]{64}$/.test(args.hash) || typeof args.data !== 'string' || args.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data)) throw new Error('Invalid draft attachment.');
      const data = Buffer.from(args.data, 'base64');
      if (data.length > 20 * 1024 * 1024 || hash(data) !== args.hash) throw new Error('Draft attachment checksum does not match.');
      this.collectBlobs(now);
      this.db.prepare('INSERT OR IGNORE INTO sync_blobs VALUES(?,?)').run(args.hash, data);
      this.touchBlob(args.hash, now);
      return {};
    }
    if (method === 'blob-get') {
      if (!/^[a-f0-9]{64}$/.test(args.hash)) throw new Error('Invalid attachment identity.');
      const row = this.db.prepare('SELECT data FROM sync_blobs WHERE hash=?').get(args.hash);
      if (!row) throw new Error('Shared draft attachment was not found.');
      this.touchBlob(args.hash, now);
      return { data: Buffer.from(row.data).toString('base64') };
    }
    throw new Error('Unsupported conversation sync operation.');
  }
}
module.exports = { StateDatabase, stateKey, hash, blobGraceMs };

const { createHash } = require('node:crypto');

const kinds = new Set(['pin', 'messagePin', 'unread', 'completion', 'draft', 'project', 'thread', 'shortcuts']);
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
        WHERE entry.kind='draft' AND json_type(image.value,'$.hash')='text')`).run(now - blobGraceMs);
    this.db.prepare("DELETE FROM sync_blob_usage WHERE hash<>'' AND hash NOT IN (SELECT hash FROM sync_blobs)").run();
    this.nextBlobGc = now + 60000;
  }
  touchBlob(id, now) { this.db.prepare('INSERT INTO sync_blob_usage VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET touched_at=excluded.touched_at').run(id, now); }
  request(method, args, owner, now = Date.now()) {
    if (method === 'blob-prepare') {
      if (!Array.isArray(args.hashes) || args.hashes.length > 500 || args.hashes.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid attachment identities.');
      const missing = [];
      for (const id of args.hashes) {
        if (this.db.prepare('SELECT 1 FROM sync_blobs WHERE hash=?').get(id)) this.touchBlob(id, now);
        else missing.push(id);
      }
      this.collectBlobs(now); return { missing };
    }
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
      const operations = args.operations.map(op => {
        const key = stateKey(op.kind, op.machine, op.id);
        if (!validId(op.opId) || !Number.isSafeInteger(op.base) || op.base < 0 || op.value === undefined || Buffer.byteLength(JSON.stringify(op.value)) > 1024 * 1024) throw new Error('Invalid synced conversation change.');
        if (['pin', 'unread'].includes(op.kind) && typeof op.value !== 'boolean' && op.value !== null) throw new Error('Invalid synced marker.');
        if (op.kind === 'completion' && op.value !== null && !['completed', 'failed'].includes(op.value?.status || op.value)) throw new Error('Invalid synced completion.');
        if (op.value && op.kind === 'draft') for (const image of op.value.images || []) {
          if (!/^[a-f0-9]{64}$/.test(image.hash) || !this.db.prepare('SELECT 1 FROM sync_blobs WHERE hash=?').get(image.hash)) throw new Error('Upload draft attachments before publishing the draft.');
        }
        return { ...op, key };
      });
      return operations.map(op => {
        const receipt = this.db.prepare('SELECT * FROM sync_ops WHERE id=?').get(op.opId);
        const current = this.get(op.key);
        if (receipt) {
          if (receipt.key !== op.key) throw new Error('Sync operation identity was reused.');
          return { opId: op.opId, revision: receipt.revision, current };
        }
        if (op.seed && current) return { opId: op.opId, revision: current.revision, current, seeded: true };
        if (op.kind === 'draft' && op.stale) return { opId: op.opId, conflict: true, current };
        if (op.kind === 'completion' && op.value === null && current?.value?.turnId && op.observedTurn !== current.value.turnId) return { opId: op.opId, conflict: true, current };
        if (['draft', 'shortcuts', 'unread', 'completion'].includes(op.kind) && !op.seed && (current?.revision || 0) !== op.base) return { opId: op.opId, conflict: true, current };
        const revision = this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS value FROM sync_entries').get().value;
        this.db.prepare('INSERT INTO sync_entries VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value,writer=excluded.writer')
          .run(op.key, op.kind, op.machine, op.id, revision, JSON.stringify(op.value), owner);
        this.db.prepare('INSERT INTO sync_ops VALUES(?,?,?)').run(op.opId, op.key, revision);
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

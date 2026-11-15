// Isolated SSH storage and fake agents; never reads or sends real conversations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { SharedSchedules } = require('../shared-schedules.cjs');
const { ScheduleStore } = require('../scheduler.cjs');
const { ConversationState } = require('../conversation-state.cjs');
const { PinStore } = require('../pins.cjs');
const { DraftStore } = require('../drafts.cjs');
const { PreferencesStore } = require('../preferences.cjs');

async function main() {
  const host = process.env.CODEX_TEST_HOST || 'root@warmer', id = randomUUID();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-conversation-live-'));
  const folder = `~/.local/share/remote-codex/schedule-sync/conversations-test-${id}`;
  const clients = [], machine = () => 'access:local';
  try {
    for (const device of ['first', 'second']) {
      const local = path.join(directory, device), root = path.join(local, 'workspace');
      fs.mkdirSync(root, { recursive: true });
      const connection = { ready: true, session: {}, supports: () => false, async call(method, params) {
        if (method === 'fs/readDirectory') { assert.equal(params.path, root); return { entries: [] }; }
        assert.equal(method, 'project/create'); return { project: { id: device + '-project', provider: 'codex', roots: [{ path: root }], name: params.name } };
      } };
      const shared = new SharedSchedules({ file: path.join(local, 'sharing.json'), store: new ScheduleStore(path.join(local, 'schedules.json')), connection, machine, blocked: () => true, dispatching: new Set(), available: () => false });
      const pins = new PinStore(path.join(local, 'pins.json')), drafts = new DraftStore(path.join(local, 'drafts')), preferences = new PreferencesStore(path.join(local, 'preferences.json'));
      const state = new ConversationState({ directory: path.join(local, 'sync'), shared, connection, machine, pins, drafts, preferences, options: () => ({ mode: 'local' }), changed() {}, log() {} });
      state.sync.soon = () => {};
      clients.push({ state, shared, root, pins, drafts, preferences });
      await shared.configure({ enabled: true, host, folder });
    }
    const [a, b] = clients;
    const project = a.state.captureProject({ id: 'first-project', provider: 'codex', roots: [{ path: a.root }], name: 'Synced project' });
    a.state.captureThread({ id, projectId: project.id, cwd: a.root, name: 'Test conversation', updatedAt: 10 });
    a.state.sync.capture('pin', machine(), id, true);
    a.state.sync.capture('messagePin', machine(), JSON.stringify([id, 'message']), { itemId: 'message', turnId: 'turn', preview: 'Pinned message' });
    a.state.sync.capture('unread', machine(), id, true);
    a.state.sync.capture('shortcuts', machine(), 'shortcuts', [{ id: 'review', label: 'Review', prompt: '$cr ur changes', mode: 'fill' }]);
    const source = { machine: machine(), kind: 'composer', projectId: project.id, threadId: id, cwd: a.root };
    a.drafts.save(source, { text: 'Unsent draft', images: [{ name: 'tiny.png', url: 'data:image/png;base64,aW1hZ2U=' }] });
    a.state.captureDraft(source);
    await a.state.tick(); await b.state.tick();
    assert.equal(b.pins.get({ mode: 'local' }).includes(id), true);
    assert.equal(b.preferences.read().messagePins[machine()][id][0].preview, 'Pinned message');
    assert.deepEqual(b.preferences.read().conversationStates[machine()].unread, [id]);
    assert.equal(b.preferences.read().shortcuts[0].mode, 'fill');
    assert.throws(() => b.state.threadBinding(id), /Choose this shared project/);
    const mapped = await b.state.bind(project.sharedId, b.root);
    const target = { ...source, cwd: b.root, projectId: mapped.id };
    assert.equal(b.drafts.read(target).target.cwd, b.root);
    assert.equal(b.drafts.read(target).text, 'Unsent draft');
    assert.equal(b.drafts.read(target).images[0].url, 'data:image/png;base64,aW1hZ2U=');
    a.drafts.save(source, { text: 'First computer edit' }); a.state.captureDraft(source);
    b.drafts.save(target, { text: 'Second computer edit' }); b.state.captureDraft(target);
    await a.state.tick(); await b.state.tick();
    const conflict = b.state.sync.conflicts()[0];
    assert.equal(conflict.local.text, 'Second computer edit'); assert.equal(conflict.remote.value.text, 'First computer edit');
    await b.state.sync.resolve(conflict.key, 'local', conflict.version); await b.state.tick(); await a.state.tick();
    assert.equal(a.drafts.read(source).text, 'Second computer edit');
    const storage = await a.shared.storageInfo(); assert.equal(storage.complete, true); assert.ok(storage.bytes > 0);
    console.log('PASS Warmer SSH: pins, message pins, unread, shortcuts, image drafts, distinct project roots and concurrent draft resolution; no native execution.');
  } finally {
    for (const client of clients) { client.state.sync.close(); client.shared.close(); }
    const cleanup = `const fs=require("node:fs"),path=require("node:path"),os=require("node:os");fs.rmSync(path.join(os.homedir(),".local/share/remote-codex/schedule-sync/conversations-test-${id}"),{recursive:true,force:true});`;
    execFileSync('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', host, "node -e '" + cleanup + "'"], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

// Real isolated SSH storage and disposable fake agents; never reads or sends real conversations.
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

const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const decode = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
async function main() {
  const host = process.env.CODEX_TEST_HOST || 'root@warmer', id = randomUUID();
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-history-live-')));
  const folder = `~/.local/share/remote-codex/schedule-sync/history-test-${id}`, clients = [];
  const machine = () => 'access:local';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  try {
    for (const device of ['source', 'receiver']) {
      const local = path.join(directory, device), root = path.join(local, 'own workspace'), home = path.join(local, 'codex-home');
      for (const name of [root, path.join(home, 'sessions')]) fs.mkdirSync(name, { recursive: true });
      const options = { mode: 'local', localCwd: root }, native = new Map(), calls = [];
      const connection = { ready: true, session: {}, supports: (method, provider = 'codex') => method === 'thread/list' && provider === 'codex', async call(method, params) {
        calls.push({ method, params: structuredClone(params) });
        if (method === 'thread/list') return { data: [...native.values()].map(thread => structuredClone(thread)), nextCursor: null };
        if (method === 'thread/read') { const thread = native.get(params.threadId); if (!thread) throw new Error('Thread not found'); return { thread: structuredClone(thread) }; }
        if (method === 'thread/unsubscribe') return {};
        if (method === 'thread/turns/list') return { data: [{ id: 'fixture-turn', status: 'completed', items: [] }], nextCursor: null };
        assert.equal(method, 'thread/resume', 'history smoke test must never start inference');
        assert.ok(path.resolve(params.path).startsWith(home + path.sep));
        assert.equal(params.sandbox, 'read-only'); assert.equal(params.approvalPolicy, 'never'); assert.equal(params.cwd, root); assert.deepEqual(params.runtimeWorkspaceRoots, [root]);
        const records = decode(params.path), thread = { id: records[0].payload.id, cwd: params.cwd, path: params.path, name: 'History sync fixture', provider: 'codex', status: { type: 'idle' } };
        assert.equal(thread.id, params.threadId); native.set(thread.id, thread); return { thread: structuredClone(thread) };
      } };
      const shared = new SharedSchedules({ file: path.join(local, 'sharing.json'), store: new ScheduleStore(path.join(local, 'schedules.json')), connection, machine, blocked: () => true, dispatching: new Set(), available: () => false });
      const pins = new PinStore(path.join(local, 'pins.json')), preferences = new PreferencesStore(path.join(local, 'preferences.json'));
      const state = new ConversationState({ directory: path.join(local, 'sync'), shared, connection, machine, options: () => options, pins, preferences, drafts: new DraftStore(path.join(local, 'drafts')), changed() {}, log() {} });
      state.sync.soon = () => {};
      Object.defineProperty(state.history, 'home', { value: home });
      clients.push({ state, shared, root, home, native, calls, pins, preferences, options });
      await shared.configure({ enabled: true, host, folder });
    }
    const [a, b] = clients, threadId = randomUUID(), timestamp = '2026-11-16T12:00:00.000Z';
    const image = path.join(a.root, 'tiny fixture.png'); fs.writeFileSync(image, png);
    const source = path.join(a.home, 'sessions', 'rollout-history-live-' + threadId + '.jsonl');
    fs.writeFileSync(source, encode([
      { timestamp, ordinal: 0, type: 'session_meta', payload: { id: threadId, cwd: a.root, runtime_workspace_roots: [a.root] } },
      { timestamp, ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic history transfer question' }, { type: 'localImage', path: image }] } },
      { timestamp, ordinal: 2, type: 'response_item', payload: { id: 'history-live-answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic history transfer answer' }] } }
    ]));
    const original = fs.readFileSync(source);
    const thread = { id: threadId, cwd: a.root, path: source, name: 'History sync fixture', provider: 'codex', projectId: null, status: { type: 'idle' }, updatedAt: 1 };
    a.native.set(threadId, thread); a.pins.set(a.options, threadId, true);
    a.preferences.update({ messagePin: { machine: machine(), threadId, itemId: 'history-live-answer', turnId: 'history-live-turn', preview: 'Synthetic pinned answer', pinned: true } });
    a.state.captureThread(thread); a.state.history.observe(thread);
    await a.state.tick(); await b.state.tick();
    assert.ok(a.state.catalog('history', threadId));
    assert.equal(a.state.history.status().find(owner => owner.id === threadId).owned, true);
    await b.state.history.read(threadId);
    const imported = b.native.get(threadId), importedRows = decode(imported.path);
    assert.notEqual(imported.path, source); assert.equal(importedRows[0].payload.cwd, b.root);
    assert.match(fs.readFileSync(imported.path, 'utf8'), /Synthetic history transfer question/); assert.match(fs.readFileSync(imported.path, 'utf8'), /Synthetic history transfer answer/);
    assert.deepEqual(fs.readFileSync(importedRows[1].payload.content[1].path), png);
    await assert.rejects(b.state.history.verify(threadId), /Use this conversation|owned by another/);
    assert.equal(b.pins.get(b.options).includes(threadId), true); assert.equal(b.preferences.read().messagePins[machine()][threadId][0].preview, 'Synthetic pinned answer');
    assert.deepEqual(fs.readFileSync(source), original);
    console.log('PASS Warmer SSH: full native history and PNG import into a distinct read-only workspace; foreign-owner writes denied; pin metadata preserved.');
    await b.state.history.request(threadId); await a.state.history.tick(); await b.state.history.refresh();
    assert.equal(b.state.history.status().find(owner => owner.id === threadId).owned, true);
    await b.state.history.verify(threadId); await assert.rejects(a.state.history.verify(threadId), /Use this conversation|owned by another/);
    fs.appendFileSync(imported.path, encode([{ timestamp, ordinal: 3, type: 'event_msg', payload: { type: 'user_message', message: 'Receiver follow-up appended by the disposable fake agent' } }]));
    b.state.history.observe(imported); await b.state.history.tick(); await a.state.history.read(threadId, { refresh: true });
    const returned = a.native.get(threadId), returnedRows = decode(returned.path);
    assert.notEqual(returned.path, source); assert.notEqual(returned.path, imported.path);
    assert.match(fs.readFileSync(returned.path, 'utf8'), /Receiver follow-up appended by the disposable fake agent/);
    assert.equal(returnedRows[0].payload.cwd, a.root); assert.deepEqual(fs.readFileSync(returnedRows[1].payload.content[1].path), png);
    assert.deepEqual(fs.readFileSync(source), original); assert.deepEqual(fs.readFileSync(image), png);
    assert.equal(a.pins.get(a.options).includes(threadId), true); assert.equal(b.pins.get(b.options).includes(threadId), true);
    assert.ok(clients.flatMap(client => client.calls).every(call => ['thread/list', 'thread/read', 'thread/turns/list', 'thread/unsubscribe', 'thread/resume'].includes(call.method)));
    console.log('PASS Warmer SSH: idle uploaded handoff, new owner history round trip with attachment bytes, original rollout preservation, and no inference.');
  } finally {
    for (const client of clients) { client.state.sync.close(); client.shared.close(); }
    const cleanup = `const fs=require("node:fs"),path=require("node:path"),os=require("node:os");fs.rmSync(path.join(os.homedir(),".local/share/remote-codex/schedule-sync/history-test-${id}"),{recursive:true,force:true});`;
    try { execFileSync('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', host, "node -e '" + cleanup + "'"], { stdio: 'pipe' }); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

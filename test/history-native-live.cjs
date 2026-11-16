const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { CodexConnection, localLaunch } = require('../transport.cjs');
const { exportCodexHistory, importCodexHistory } = require('../codex-history.cjs');
const { readImage } = require('../images.cjs');
const { AgentPool } = require('../agent-pool.cjs');
const { ConversationState } = require('../conversation-state.cjs');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { PinStore } = require('../pins.cjs');
const { DraftStore } = require('../drafts.cjs');
const { PreferencesStore } = require('../preferences.cjs');

const timestamp = '2026-11-16T12:00:00.000Z';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM9sAAAAASUVORK5CYII=', 'base64');
const encode = rows => rows.map((row, ordinal) => JSON.stringify({ timestamp, ...row, ordinal }) + '\n').join('');
const allowed = new Set(['initialize', 'thread/resume', 'thread/read', 'thread/turns/list', 'thread/unsubscribe', 'thread/list', 'fs/readFile']);
const checksum = data => createHash('sha256').update(data).digest('hex');

async function main() {
  const launch = localLaunch({ codexPath: process.env.CODEX_TEST_PATH || '' });
  const executable = launch.args[0] === 'app-server' ? launch.command : launch.args[0];
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-native-history-')));
  const connections = [], children = [], requests = [], notifications = [], states = [], pools = [], databases = [];
  try {
    const makeProfile = name => {
      const home = path.join(directory, name, 'codex-home'), cwd = path.join(directory, name, 'project');
      for (const folder of [home, cwd, path.join(home, 'sessions')]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      return { home, cwd };
    };
    const profiles = ['source', 'receiver'].map(makeProfile);
    function createAdapter(profile) {
      const connection = new CodexConnection((command, args, options) => {
        const env = { PATH: options.env.PATH, HOME: path.dirname(profile.home), CODEX_HOME: profile.home, TMPDIR: directory, LANG: 'en_US.UTF-8', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
        const child = spawn(command, [...args, '-c', 'features.goals=false', '-c', 'thread_unload_delay_secs=0'], { ...options, env });
        children.push(child); return child;
      });
      connections.push(connection);
      const call = connection.call.bind(connection);
      connection.call = (method, params, timeout = 15000) => { assert.ok(allowed.has(method), 'No inference or mutation RPC is allowed: ' + method); requests.push(method); if (process.env.HISTORY_NATIVE_DEBUG) console.log(path.basename(path.dirname(profile.home)), method, params?.threadId || ''); return call(method, params, timeout).catch(error => { error.message = path.basename(path.dirname(profile.home)) + ' ' + method + ': ' + error.message; throw error; }); };
      connection.on('notification', message => {
        notifications.push(message);
        if (message.id !== undefined) connection.rejectRequest(message.id);
      });
      return connection;
    }
    async function connect(profile) {
      const connection = createAdapter(profile);
      await connection.connect({ mode: 'local', executablePath: executable, localCwd: profile.cwd });
      return connection;
    }
    async function read(connection, id) {
      const result = await connection.call('thread/read', { threadId: id, includeTurns: false });
      assert.equal(result.thread.id, id);
      const turns = []; let cursor = null;
      do {
        const page = await connection.call('thread/turns/list', { threadId: id, cursor, limit: 25, sortDirection: 'asc', itemsView: 'full' });
        turns.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      return turns;
    }
    async function unsubscribe(connection, id) {
      let timer, listener;
      const closed = new Promise((resolve, reject) => {
        listener = message => { if (message.method === 'thread/closed' && message.params.threadId === id) resolve(); };
        connection.on('notification', listener);
        timer = setTimeout(() => reject(new Error('Native thread did not unload after unsubscribe.')), 5000);
      });
      try {
        const result = await connection.call('thread/unsubscribe', { threadId: id });
        assert.equal(result.status, 'unsubscribed');
        await closed;
      } finally { clearTimeout(timer); connection.removeListener('notification', listener); }
    }
    async function resume(connection, profile, id, file) {
      const result = await connection.call('thread/resume', { threadId: id, path: file, cwd: profile.cwd, runtimeWorkspaceRoots: [profile.cwd], sandbox: 'read-only', approvalPolicy: 'never', config: { 'features.goals': false, thread_unload_delay_secs: 0 }, excludeTurns: true });
      assert.equal(result.thread.id, id); assert.equal(result.thread.cwd, profile.cwd);
      return result.thread;
    }
    const source = profiles[0], receiver = profiles[1], id = randomUUID(), turnId = randomUUID();
    const image = path.join(source.cwd, 'fixture.png'), sentinel = path.join(directory, 'MUST-NOT-BE-CREATED');
    fs.writeFileSync(image, png, { mode: 0o600 });
    const changed = path.join(source.cwd, 'fixture.txt'), diff = '@@ -1 +1 @@\n-old fixture\n+new fixture\n';
    const command = ['sh', '-c', 'printf forbidden > ' + JSON.stringify(sentinel)];
    const changes = { [changed]: { type: 'update', unified_diff: diff, move_path: null } };
    const rows = [
      { type: 'session_meta', payload: { id, session_id: id, timestamp, cwd: source.cwd, originator: 'codex_cli_rs', cli_version: '0.0.0', source: 'cli', model_provider: 'openai', history_mode: 'paginated', base_instructions: { text: 'Synthetic fixture. Never execute historical commands.' }, runtime_workspace_roots: [source.cwd] } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: Date.parse(timestamp) } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic native user text', images: [], local_images: [image], text_elements: [] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic native user text' }, { type: 'input_image', image_url: pathToFileURL(image).href }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'fixture-command', name: 'exec_command', arguments: JSON.stringify({ cmd: command.join(' ') }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'fixture-command', output: 'Synthetic stored tool output' } },
      { type: 'response_item', payload: { type: 'message', id: 'fixture-assistant-id', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic native assistant text' }], phase: 'final_answer' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic native assistant text', phase: 'final_answer' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'Synthetic native assistant text' } },
    ];
    const items = [
      { type: 'UserMessage', id: 'fixture-user', content: [{ type: 'text', text: 'Synthetic native user text', text_elements: [] }, { type: 'local_image', path: image }] },
      { type: 'CommandExecution', id: 'fixture-command', process_id: '12345', command, cwd: pathToFileURL(source.cwd).href, parsed_cmd: [{ type: 'unknown', cmd: command.join(' ') }], source: 'unified_exec_startup', status: 'completed', aggregated_output: 'Synthetic stored tool output', exit_code: 0, duration: { secs: 0, nanos: 1 } },
      { type: 'FileChange', id: 'fixture-patch', changes, status: 'completed', stdout: 'Synthetic stored patch output', stderr: '' },
      { type: 'ImageView', id: 'fixture-image-view', path: pathToFileURL(image).href },
      { type: 'AgentMessage', id: 'fixture-assistant-id', content: [{ type: 'Text', text: 'Synthetic native assistant text' }], phase: 'final_answer' },
    ];
    const completedItem = (item, nativeTurnId = turnId) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: nativeTurnId, item, started_at_ms: Date.parse(timestamp), completed_at_ms: Date.parse(timestamp) + 1 } });
    rows.splice(rows.length - 1, 0, ...items.map(item => completedItem(item)));
    const sourcePath = path.join(source.home, 'sessions', 'rollout-2026-11-16T12-00-00-' + id + '.jsonl');
    fs.writeFileSync(sourcePath, encode(rows), { mode: 0o600 });
    const sourceConnection = await connect(source), receiverConnection = await connect(receiver);
    const sourceThread = await resume(sourceConnection, source, id, sourcePath), sourceTurns = await read(sourceConnection, id);
    if (process.env.HISTORY_NATIVE_DEBUG) console.log(JSON.stringify({ sourceThread, sourceTurns }, null, 2));
    assert.equal(sourceTurns.length, 1); assert.equal(sourceTurns[0].id, turnId);
    const sourceItems = sourceTurns.flatMap(turn => turn.items), serialized = JSON.stringify(sourceItems);
    assert.match(serialized, /Synthetic native user text/); assert.match(serialized, /Synthetic native assistant text/);
    assert.match(serialized, /Synthetic stored tool output/); assert.match(serialized, /new fixture/);
    const pinned = sourceItems.find(item => item.type === 'agentMessage'); assert.ok(pinned?.id);
    await unsubscribe(sourceConnection, id);
    const blobs = new Map();
    const keepBlob = data => { const digest = checksum(data); blobs.set(digest, Buffer.from(data)); return digest; };
    const readBlob = async digest => { assert.ok(blobs.has(digest)); return blobs.get(digest); };
    const manifest = await exportCodexHistory({ thread: { ...sourceThread, path: sourcePath }, home: source.home, keepBlob });
    const imported = await importCodexHistory({ manifest, home: receiver.home, cwd: receiver.cwd, readBlob, directory: path.join(receiver.home, 'private-history') });
    await resume(receiverConnection, receiver, id, imported.path);
    const importedTurns = await read(receiverConnection, id), importedItems = importedTurns.flatMap(turn => turn.items);
    assert.deepEqual(importedTurns.map(turn => turn.id), sourceTurns.map(turn => turn.id));
    assert.deepEqual(importedItems.map(item => [item.id, item.type]), sourceItems.map(item => [item.id, item.type]));
    assert.equal(importedItems.find(item => item.id === pinned.id)?.text, pinned.text);
    assert.deepEqual(importedItems.find(item => item.type === 'userMessage').content.filter(item => item.type === 'text'), sourceItems.find(item => item.type === 'userMessage').content.filter(item => item.type === 'text'));
    for (const type of ['agentMessage', 'commandExecution', 'fileChange']) assert.deepEqual(importedItems.filter(item => item.type === type), sourceItems.filter(item => item.type === type));
    const attachment = manifest.attachments[0]; assert.ok(attachment);
    const imagePath = path.join(receiver.home, 'private-history', 'attachments', attachment.hash + '.png');
    assert.equal(await readImage(receiverConnection, imagePath), 'data:image/png;base64,' + png.toString('base64'));
    assert.equal(importedItems.find(item => item.type === 'userMessage').content.find(item => item.type === 'localImage').path, imagePath);
    const view = importedItems.find(item => item.type === 'imageView'); assert.ok(view);
    assert.equal(view.path.startsWith('file://') ? fileURLToPath(view.path) : view.path, imagePath);
    await unsubscribe(receiverConnection, id);
    const firstImportedBytes = fs.readFileSync(imported.path);
    const secondTurnId = randomUUID();
    fs.writeFileSync(sourcePath, encode([...rows,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: secondTurnId, root_turn_id: secondTurnId, started_at: Date.parse(timestamp) } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Second synthetic version', images: [], local_images: [], text_elements: [] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Second synthetic answer', phase: 'final_answer' } },
      completedItem({ type: 'UserMessage', id: 'fixture-user-2', content: [{ type: 'text', text: 'Second synthetic version', text_elements: [] }] }, secondTurnId),
      completedItem({ type: 'AgentMessage', id: 'fixture-assistant-2', content: [{ type: 'Text', text: 'Second synthetic answer' }], phase: 'final_answer' }, secondTurnId),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: secondTurnId, last_agent_message: 'Second synthetic answer' } },
    ]));
    const nextManifest = await exportCodexHistory({ thread: { ...sourceThread, path: sourcePath }, home: source.home, keepBlob });
    assert.notEqual(nextManifest.digest, manifest.digest);
    const nativeId = randomUUID();
    const updated = await importCodexHistory({ manifest: nextManifest, nativeId, home: receiver.home, cwd: receiver.cwd, readBlob, directory: path.join(receiver.home, 'private-history') });
    assert.notEqual(updated.path, imported.path);
    assert.equal(updated.id, nativeId); assert.equal(updated.logicalId, id);
    await resume(receiverConnection, receiver, nativeId, updated.path);
    const latest = await read(receiverConnection, nativeId);
    assert.deepEqual(latest.map(turn => turn.id), [turnId, secondTurnId]);
    assert.match(JSON.stringify(latest), /Second synthetic answer/);
    assert.deepEqual(latest[0].items.map(item => [item.id, item.type]), sourceItems.map(item => [item.id, item.type]));
    assert.equal(latest[0].items.find(item => item.id === pinned.id)?.text, pinned.text);
    await unsubscribe(receiverConnection, nativeId);
    const reexported = await exportCodexHistory({ thread: { id: nativeId, path: updated.path, cwd: receiver.cwd }, logicalId: id, home: receiver.home, attachmentRoots: [path.join(receiver.home, 'private-history')], keepBlob });
    assert.equal(reexported.id, id);
    const portable = require('node:zlib').gunzipSync(Buffer.concat(reexported.chunks.map(chunk => blobs.get(chunk.hash)))).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(portable[0].payload.id, id);
    assert.ok(portable.filter(row => row.type === 'event_msg' && row.payload.thread_id).every(row => row.payload.thread_id === id));
    assert.deepEqual(fs.readFileSync(imported.path), firstImportedBytes);
    const integratedProfiles = ['pool-a', 'pool-b'].map(makeProfile), sharedFile = path.join(directory, 'integration-shared.sqlite');
    const clients = [];
    for (const [index, profile] of integratedProfiles.entries()) {
      const database = new SharedScheduleDatabase(sharedFile); databases.push(database);
      const registry = { codex: { id: 'codex', name: 'Codex', methods: [...allowed].filter(method => method !== 'initialize'), options: () => ({ mode: 'local', localCwd: profile.cwd, executablePath: executable }), create: () => createAdapter(profile) } };
      const pool = new AgentPool(registry); pools.push(pool);
      const options = { mode: 'local', localCwd: profile.cwd, executablePath: executable };
      await pool.connect(options);
      const shared = { enabled: true, key: 'isolated-native-fixture:/shared', state: { device: 'fixture-device-' + index }, online: async () => {}, failed: error => { throw error; }, bridge: { call: async (method, args) => database.request(method, structuredClone(args), shared.state.device).result } };
      const local = path.join(path.dirname(profile.home), 'local-state'), pins = new PinStore(path.join(local, 'pins.json')), preferences = new PreferencesStore(path.join(local, 'preferences.json'));
      const state = new ConversationState({ directory: path.join(local, 'sync'), shared, pins, preferences, drafts: new DraftStore(path.join(local, 'drafts')), machine: () => 'access:local', options: () => options, connection: pool, changed() {}, log() {} });
      state.sync.soon = () => {}; Object.defineProperty(state.history, 'home', { get: () => profile.home }); states.push(state);
      clients.push({ profile, pool, state, shared, options, pins, preferences });
    }
    const [a, b] = clients, logicalId = randomUUID();
    const integrationRows = JSON.parse(JSON.stringify(rows).replaceAll(source.cwd, a.profile.cwd).replaceAll(id, logicalId));
    fs.writeFileSync(path.join(a.profile.cwd, 'fixture.png'), png);
    const original = path.join(a.profile.home, 'sessions', 'rollout-2026-11-16T12-00-00-' + logicalId + '.jsonl');
    fs.writeFileSync(original, encode(integrationRows), { mode: 0o600 });
    const nativeThread = await resume(a.pool, a.profile, logicalId, original), originalTurns = await read(a.pool, logicalId);
    await unsubscribe(a.pool, logicalId); const originalBytes = fs.readFileSync(original);
    a.pins.set(a.options, logicalId, true);
    a.preferences.update({ messagePin: { machine: 'access:local', threadId: logicalId, itemId: pinned.id, turnId, preview: pinned.text, pinned: true } });
    a.state.captureThread(nativeThread); await a.state.tick();
    assert.equal(a.state.catalog('history', logicalId).epoch, 1);
    await b.state.tick(); await b.state.history.read(logicalId);
    const peerThread = (await b.pool.call('thread/read', { threadId: logicalId, includeTurns: false })).thread;
    assert.equal(peerThread.id, logicalId); assert.equal(peerThread.cwd, b.profile.cwd);
    assert.notEqual(b.state.history.record(logicalId).nativeId, logicalId);
    assert.equal(b.state.threads([], null).find(thread => thread.id === logicalId).remoteOnly, false);
    const peerTurns = await read(b.pool, logicalId);
    assert.deepEqual(peerTurns.map(turn => turn.id), originalTurns.map(turn => turn.id));
    assert.deepEqual(peerTurns.flatMap(turn => turn.items).map(item => [item.id, item.type]), originalTurns.flatMap(turn => turn.items).map(item => [item.id, item.type]));
    for (const type of ['agentMessage', 'commandExecution', 'fileChange']) assert.deepEqual(peerTurns[0].items.filter(item => item.type === type), originalTurns[0].items.filter(item => item.type === type));
    assert.deepEqual(b.pins.get(b.options), [logicalId]);
    const syncedPin = b.preferences.read().messagePins['access:local'][logicalId][0];
    assert.equal(peerTurns[0].items.find(item => item.id === syncedPin.itemId)?.text, pinned.text);
    await b.state.history.request(logicalId); await a.state.tick(); await b.state.history.refresh();
    assert.equal(b.state.history.status().find(owner => owner.id === logicalId).owned, true);
    await b.state.history.verify(logicalId); await b.state.tick();
    assert.equal(b.state.catalog('history', logicalId).epoch, 2);
    await a.state.history.read(logicalId);
    assert.notEqual(a.state.history.record(logicalId).nativeId, logicalId);
    const returned = await read(a.pool, logicalId);
    assert.deepEqual(returned.flatMap(turn => turn.items).map(item => [item.id, item.type]), originalTurns.flatMap(turn => turn.items).map(item => [item.id, item.type]));
    assert.equal(returned[0].items.find(item => item.id === pinned.id)?.text, pinned.text);
    for (const client of clients) {
      const listed = await client.pool.call('thread/list', { limit: 100 });
      assert.equal(listed.data.filter(thread => thread.id === logicalId).length, 1);
      assert.equal(listed.data.some(thread => client.state.history.record(logicalId).retiredNativeIds.includes(thread.id) && thread.id !== logicalId), false);
    }
    const storedNativeId = b.state.history.record(logicalId).nativeId;
    b.pool.disconnect(); await b.pool.connect(b.options); b.state.history.restore();
    assert.equal(b.pool.nativeParams('codex', { threadId: logicalId }).threadId, storedNativeId);
    await resume(b.pool, b.profile, logicalId);
    const restored = await read(b.pool, logicalId);
    assert.equal(restored[0].items.find(item => item.id === syncedPin.itemId)?.text, pinned.text);
    assert.deepEqual(fs.readFileSync(original), originalBytes);
    assert.equal(fs.existsSync(path.join(a.profile.cwd, 'fixture.txt')), false);
    assert.equal(fs.existsSync(sentinel), false); assert.equal(fs.existsSync(changed), false);
    assert.equal(notifications.some(message => message.method === 'turn/started' || message.method === 'item/started' && ['commandExecution', 'fileChange'].includes(message.params?.item?.type)), false);
    assert.equal(notifications.some(message => message.id !== undefined), false);
    assert.equal(requests.some(method => method === 'turn/start' || method === 'turn/steer'), false);
    console.log('PASS isolated native history: source/import projection, stable IDs and pin lookup, tool output and diff, PNG display, replacement snapshot, real pool/coordinator handoff and reconnect; no inference or historical command execution.');
  } finally {
    states.forEach(state => { state.history.close(); state.sync.close(); }); pools.forEach(pool => pool.disconnect());
    connections.forEach(connection => connection.disconnect());
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 3000).unref(); })));
    databases.forEach(database => database.close());
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { ConversationState } = require('../conversation-state.cjs');
const { PinStore } = require('../pins.cjs');
const { DraftStore } = require('../drafts.cjs');
const { PreferencesStore } = require('../preferences.cjs');
const { hash, stateKey } = require('../sync-state.cjs');

const machine = 'access:local';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-conversation-state-'));
  const databases = [new SharedScheduleDatabase(path.join(directory, 'shared.sqlite')), new SharedScheduleDatabase(path.join(directory, 'shared.sqlite'))];
  const servers = new Map([['fixture-server:/shared', databases]]);
  const server = key => {
    if (!servers.has(key)) {
      const file = path.join(directory, hash(key) + '.sqlite');
      servers.set(key, [new SharedScheduleDatabase(file), new SharedScheduleDatabase(file)]);
    }
    return servers.get(key);
  };
  const clients = databases.map((database, index) => {
    const local = path.join(directory, 'computer-' + index), root = path.join(local, 'own project');
    fs.mkdirSync(root, { recursive: true });
    const pins = new PinStore(path.join(local, 'pins.json'));
    const drafts = new DraftStore(path.join(local, 'drafts'));
    const preferences = new PreferencesStore(path.join(local, 'preferences.json'));
    let options = { mode: 'local', localCwd: root }, selectedMachine = machine;
    const calls = [], bridgeCalls = [], errors = [], nativeProjects = [], skills = [], createdProjects = new Map();
    const connection = { ready: true, session: {}, supports: method => method === 'project/list' && nativeProjects.length > 0, call: async (method, params, _timeout, context) => {
      calls.push({ method, params: structuredClone(params), context });
      if (method === 'project/list') return { data: structuredClone(nativeProjects), nextCursor: null };
      if (method === 'skills/list') return { data: [{ cwd: params.cwds[0], skills: structuredClone(skills) }] };
      if (method === 'fs/readDirectory') return { entries: fs.readdirSync(params.path, { withFileTypes: true }).map(entry => ({ fileName: entry.name, isDirectory: entry.isDirectory() })) };
      if (method === 'project/create') {
        if (!createdProjects.has(params.idempotencyKey)) {
          const project = { id: 'native-created-' + index + '-' + createdProjects.size, provider: params.provider, name: params.name, roots: params.roots };
          createdProjects.set(params.idempotencyKey, project); nativeProjects.push(project);
        }
        return { project: createdProjects.get(params.idempotencyKey) };
      }
      throw new Error('Unexpected native agent command: ' + method);
    } };
    const shared = { enabled: true, key: 'fixture-server:/shared', state: { device: 'computer-' + index }, online: async () => {}, failed: error => errors.push(error), bridge: { call: async (method, args) => {
      const copy = structuredClone(args); bridgeCalls.push({ key: shared.key, method, args: copy });
      return server(shared.key)[index].request(method, copy, 'computer-' + index).result;
    } } };
    const makeState = () => {
      const state = new ConversationState({ directory: path.join(local, 'sync'), shared, pins, drafts, preferences, machine: () => selectedMachine, options: () => options, connection, changed() {}, log() {} });
      state.sync.soon = () => {}; return state;
    };
    let state = makeState();
    return { get state() { return state; }, shared, root, pins, drafts, preferences, get options() { return options; }, calls, bridgeCalls, errors, connection, nativeProjects, skills, restart: () => { state.sync.close(); state = makeState(); }, switchMachine: (value, nextOptions) => { selectedMachine = value; options = nextOptions; connection.session = {}; } };
  });
  t.after(() => { clients.forEach(client => client.state.sync.close()); for (const databases of servers.values()) databases.forEach(database => database.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { a: clients[0], b: clients[1] };
}

test('shared project catalogs require an explicit local folder mapping before running a peer conversation', async t => {
  const { a, b } = fixture(t);
  const project = a.state.captureProject({ id: 'native-project-0', provider: 'codex', name: 'Shared project', roots: [{ path: a.root }] });
  a.state.captureThread({ id: 'shared-chat', projectId: project.id, cwd: a.root, name: 'Shared conversation', createdAt: 1, updatedAt: 2 });
  await a.state.tick(); await b.state.tick();
  const peer = b.state.projects([]).find(entry => entry.sharedId === project.sharedId);
  assert.ok(peer); assert.equal(peer.name, project.name); assert.equal(peer.needsFolder, true); assert.deepEqual(peer.roots, []);
  const conversation = b.state.threads([], peer.id).find(entry => entry.id === 'shared-chat');
  assert.ok(conversation); assert.equal(conversation.cwd, ''); assert.equal(conversation.needsFolder, true);
  assert.throws(() => b.state.threadBinding(conversation.id), /Choose this shared project/);
  assert.deepEqual(b.calls, []);
  const catalog = b.state.catalog('project', project.sharedId);
  assert.equal(catalog.roots, undefined); assert.equal(JSON.stringify(catalog).includes(a.root), false);
  const mapped = await b.state.bind(project.sharedId, b.root);
  assert.equal(b.state.threadBinding(conversation.id).root, b.root);
  assert.equal(a.state.threadBinding(conversation.id).root, a.root);
  const local = b.state.threads([], mapped.id).find(entry => entry.id === conversation.id);
  assert.equal(local.cwd, b.root); assert.equal(local.projectId, mapped.id); assert.equal(local.needsFolder, false);
  assert.deepEqual(b.calls.map(call => call.method), ['fs/readDirectory', 'project/create']);
  assert.equal(b.calls[0].params.path, b.root); assert.equal(b.calls[0].context.provider, 'codex');
  assert.deepEqual(b.calls[1].params.roots, [{ path: b.root }]);
  assert.equal(b.calls[1].params.idempotencyKey, hash(JSON.stringify([project.sharedId, b.root])));
});

test('real local pin, message-pin, unread, completion and shortcut stores receive synced metadata', async t => {
  const { a, b } = fixture(t);
  a.pins.set(a.options, 'shared-chat', true);
  a.preferences.update({ conversationState: { machine, unread: ['shared-chat'], completions: { 'shared-chat': 'completed' } } });
  const pin = { machine, threadId: 'shared-chat', itemId: 'reply-a', turnId: 'turn-a', preview: 'Pinned response', pinned: true };
  a.preferences.update({ messagePin: pin });
  const shortcuts = [{ id: 'review', label: 'Review', prompt: '$cr ur changes', mode: 'fill' }];
  a.preferences.update({ shortcuts });
  await a.state.tick(); await b.state.tick();
  assert.deepEqual(b.pins.get(b.options), ['shared-chat']);
  const prefs = b.preferences.read();
  assert.deepEqual(prefs.conversationStates[machine], { unread: ['shared-chat'], completions: { 'shared-chat': 'completed' } });
  assert.deepEqual(prefs.messagePins[machine]['shared-chat'], [{ itemId: pin.itemId, turnId: pin.turnId, preview: pin.preview }]);
  assert.deepEqual(prefs.shortcuts, shortcuts);
  b.state.sync.capture('pin', machine, 'shared-chat', false);
  b.state.sync.capture('messagePin', machine, JSON.stringify(['shared-chat', pin.itemId]), null);
  b.state.sync.capture('unread', machine, 'shared-chat', false);
  b.state.sync.capture('completion', machine, 'shared-chat', null);
  await b.state.tick(); await a.state.tick();
  assert.deepEqual(a.pins.get(a.options), []);
  const cleared = a.preferences.read();
  assert.deepEqual(cleared.conversationStates[machine], { unread: [], completions: {} });
  assert.equal(cleared.messagePins[machine]?.['shared-chat'], undefined);
  assert.deepEqual(a.calls, []); assert.deepEqual(b.calls, []);
});

test('shared drafts and image attachments use the receiving computer\'s mapped root and clear safely', async t => {
  const { a, b } = fixture(t);
  const project = a.state.captureProject({ id: 'native-project-0', provider: 'codex', name: 'Shared project', roots: [{ path: a.root }] });
  const targetA = { machine, kind: 'composer', cwd: a.root, projectId: project.id, threadId: null };
  const bytes = Buffer.from('Draft attachment content 世界🙂');
  a.drafts.save(targetA, { text: 'Continue this work', images: [{ name: 'preview.png', url: 'data:image/png;base64,' + bytes.toString('base64') }], hours: 24, model: 'saved-model', effort: 'high', mode: 'plan', access: 'read-only' });
  await a.state.tick(); await b.state.tick();
  assert.deepEqual(b.drafts.list(), []);
  assert.deepEqual(b.calls, []);
  const mapped = await b.state.bind(project.sharedId, b.root);
  const targetB = { ...targetA, cwd: b.root, projectId: mapped.id };
  const received = b.drafts.read(targetB);
  assert.equal(received.text, 'Continue this work'); assert.equal(received.target.cwd, b.root); assert.equal(received.target.projectId, mapped.id);
  assert.equal(received.hours, 24); assert.equal(received.model, 'saved-model'); assert.equal(received.effort, 'high'); assert.equal(received.mode, 'plan'); assert.equal(received.access, 'read-only');
  assert.deepEqual(Buffer.from(received.images[0].url.split(',')[1], 'base64'), bytes);
  assert.equal(b.drafts.list().some(entry => entry.target.cwd === a.root), false);
  a.drafts.clear(targetA); a.state.captureDraft(targetA);
  await a.state.tick(); await b.state.tick();
  assert.equal(b.drafts.read(targetB), null);
  assert.ok(b.calls.every(call => ['fs/readDirectory', 'project/create'].includes(call.method)));
  assert.deepEqual(a.calls, []);
});

test('unmapped projectless composer drafts never reuse a peer computer\'s folder automatically', async t => {
  const { a, b } = fixture(t);
  const target = { machine, kind: 'composer', cwd: a.root, threadId: null, projectId: null };
  a.drafts.save(target, { text: 'Private folder draft', images: [] });
  await a.state.tick(); await b.state.tick();
  assert.deepEqual(b.drafts.list(), []);
  assert.deepEqual(b.calls, []);
  assert.equal(b.state.sync.entries('draft', machine).length, 1);
});

test('native projects are loaded before existing local drafts are seeded into shared identities', async t => {
  const { a, b } = fixture(t);
  const project = { id: 'existing-native-project', provider: 'codex', name: 'Existing project', roots: [{ path: a.root }] };
  a.nativeProjects.push(project);
  const target = { machine, kind: 'composer', cwd: a.root, projectId: project.id, threadId: null };
  a.drafts.save(target, { text: 'Draft saved before enabling sync', images: [], model: 'saved-model' });
  await a.state.tick(); await b.state.tick();
  const id = a.state.projectId(project.id);
  const entry = a.state.sync.entries('draft', machine)[0];
  assert.ok(id); assert.equal(entry.value.project, id); assert.deepEqual(JSON.parse(entry.id)[1], ['project', id]);
  assert.equal(a.calls[0].method, 'project/list');
  assert.deepEqual(b.drafts.list(), []);
  const mapped = await b.state.bind(id, b.root);
  assert.equal(b.drafts.read({ ...target, cwd: b.root, projectId: mapped.id }).text, 'Draft saved before enabling sync');
  assert.ok(a.calls.every(call => call.method === 'project/list'));
});

test('explicitly mapping to a preexisting native project merges its catalog and known thread membership', async t => {
  const { a, b } = fixture(t);
  const shared = a.state.captureProject({ id: 'native-project-0', provider: 'codex', name: 'Shared project', roots: [{ path: a.root }] });
  a.state.captureThread({ id: 'peer-chat', name: 'Peer chat', cwd: a.root, projectId: shared.id });
  await a.state.tick();
  const local = { id: 'already-local-project', provider: 'codex', name: 'Existing local project', roots: [{ path: b.root }] };
  b.nativeProjects.push(local);
  await b.state.tick();
  const previous = b.state.projectId(local.id);
  assert.ok(previous); assert.notEqual(previous, shared.sharedId);
  b.state.captureThread({ id: 'local-chat', name: 'Local chat', cwd: b.root, projectId: local.id });
  await b.state.sync.tick();
  const mapped = await b.state.bind(shared.sharedId, b.root);
  await b.state.tick(); await a.state.tick();
  assert.equal(mapped.id, local.id); assert.equal(mapped.sharedId, shared.sharedId);
  assert.equal(b.state.binding(previous), undefined); assert.equal(b.state.catalog('project', previous), null);
  assert.equal(b.state.catalog('thread', 'local-chat').project, shared.sharedId);
  assert.equal(b.state.threadBinding('local-chat').root, b.root); assert.equal(b.state.threadBinding('peer-chat').root, b.root);
  const catalog = b.state.projects([local]);
  assert.equal(catalog.length, 1); assert.equal(catalog[0].sharedId, shared.sharedId);
  assert.ok(b.calls.every(call => ['project/list', 'fs/readDirectory'].includes(call.method)));
});

test('remapping a shared project uses a root-specific create key and never reuses the old native folder', async t => {
  const { a, b } = fixture(t);
  const shared = a.state.captureProject({ id: 'native-project-0', provider: 'codex', name: 'Shared project', roots: [{ path: a.root }] });
  a.state.captureThread({ id: 'shared-chat', name: 'Shared chat', cwd: a.root, projectId: shared.id });
  await a.state.tick(); await b.state.tick();
  const first = await b.state.bind(shared.sharedId, b.root);
  const other = path.join(path.dirname(b.root), 'remapped project'); fs.mkdirSync(other);
  const second = await b.state.bind(shared.sharedId, other);
  assert.notEqual(second.id, first.id); assert.equal(second.roots[0].path, other);
  assert.equal(b.state.threadBinding('shared-chat').root, other); assert.equal(a.state.threadBinding('shared-chat').root, a.root);
  const creates = b.calls.filter(call => call.method === 'project/create');
  assert.equal(creates.length, 2); assert.notEqual(creates[0].params.idempotencyKey, creates[1].params.idempotencyKey);
  assert.equal(creates[1].params.idempotencyKey, hash(JSON.stringify([shared.sharedId, other])));
  assert.equal((await b.state.bind(shared.sharedId, other)).id, second.id);
  assert.equal(b.calls.filter(call => call.method === 'project/create').length, 2);
});

test('switching back to a machine hydrates cached pins and drafts even without newer server revisions', async t => {
  const { a, b } = fixture(t), localOptions = b.options;
  const targetA = { machine, kind: 'composer', cwd: a.root, threadId: 'cached-chat', projectId: null };
  a.pins.set(a.options, 'cached-chat', true);
  a.drafts.save(targetA, { text: 'Cached shared draft', images: [], effort: 'high' });
  await a.state.tick();
  b.switchMachine('access:other-host:22', { mode: 'ssh', host: 'other-host', port: 22 });
  await b.state.tick();
  const cursor = b.state.sync.state.cursor;
  assert.ok(cursor > 0); assert.deepEqual(b.pins.get(localOptions), []); assert.deepEqual(b.drafts.list(), []);
  const targetB = { ...targetA, cwd: b.root };
  b.drafts.save(targetB, { text: 'Existing local context', images: [] });
  b.switchMachine(machine, localOptions); await b.state.tick();
  assert.equal(b.state.sync.state.cursor, cursor);
  assert.deepEqual(b.pins.get(localOptions), ['cached-chat']);
  assert.equal(b.drafts.read(targetB).text, 'Cached shared draft');
  assert.equal(b.drafts.read(targetB).target.cwd, b.root);
  assert.deepEqual(b.calls, []);
});

test('explicitly clearing projectId ungroups a synced thread while partial metadata preserves its group', async t => {
  const { a, b } = fixture(t);
  const project = a.state.captureProject({ id: 'native-project-0', provider: 'codex', name: 'Shared project', roots: [{ path: a.root }] });
  a.state.captureThread({ id: 'shared-chat', name: 'Grouped chat', projectId: project.id, updatedAt: 1 });
  await a.state.tick(); await b.state.tick();
  a.state.captureThread({ id: 'shared-chat', name: 'Partial metadata', updatedAt: 2 });
  await a.state.tick(); await b.state.tick();
  assert.equal(b.state.catalog('thread', 'shared-chat').project, project.sharedId);
  a.state.captureThread({ id: 'shared-chat', name: 'Ungrouped chat', projectId: null, updatedAt: 3 });
  await a.state.tick(); await b.state.tick();
  assert.equal(a.state.catalog('thread', 'shared-chat').project, null); assert.equal(b.state.catalog('thread', 'shared-chat').project, null);
  assert.equal(b.state.threads([], null)[0].id, 'shared-chat'); assert.equal(b.state.threadBinding('shared-chat'), null);
});

test('scheduled task preparation requires an active machine and maps only local folders, skills and sandbox roots', async t => {
  const { a, b } = fixture(t);
  const project = a.state.captureProject({ id: 'native-project-0', provider: 'codex', name: 'Shared project', roots: [{ path: a.root }] });
  a.state.captureThread({ id: 'scheduled-chat', name: 'Scheduled chat', projectId: project.id, updatedAt: 1 });
  const task = { id: 'mapped-schedule', machine, threadId: 'scheduled-chat', cwd: a.root, originDevice: a.shared.state.device, message: { machine, thread: { id: 'scheduled-chat', cwd: a.root, projectId: project.id }, text: '$cr review changes', images: [], input: [{ type: 'text', text: '$cr review changes' }, { type: 'skill', name: 'cr', path: path.join(a.root, '.agents/skills/cr/SKILL.md') }], turnSettings: { threadId: 'scheduled-chat', cwd: a.root, approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [a.root] } } } };
  assert.equal(await b.state.scheduledTask(task), null); assert.deepEqual(b.calls, []);
  await a.state.tick(); await b.state.tick();
  assert.equal(await b.state.scheduledTask(task), null); assert.deepEqual(b.calls, []);
  const mapped = await b.state.bind(project.sharedId, b.root);
  const skillPath = path.join(b.root, '.agents/skills/cr/SKILL.md'); b.skills.push({ name: 'cr', path: skillPath, enabled: true });
  const prepared = await b.state.scheduledTask(task);
  assert.equal(prepared.cwd, b.root); assert.equal(prepared.sourceCwd, a.root);
  assert.equal(prepared.message.thread.cwd, b.root); assert.equal(prepared.message.thread.projectId, mapped.id);
  assert.equal(prepared.message.turnSettings.cwd, b.root); assert.deepEqual(prepared.message.turnSettings.sandboxPolicy.writableRoots, [b.root]);
  assert.equal(prepared.message.input.find(part => part.type === 'skill').path, skillPath);
  assert.equal(task.cwd, a.root); assert.equal(task.message.thread.cwd, a.root); assert.deepEqual(task.message.turnSettings.sandboxPolicy.writableRoots, [a.root]);
  b.connection.session = {};
  const count = b.calls.length;
  assert.equal(await b.state.scheduledTask(task), null); assert.equal(b.calls.length, count);
  await b.state.tick(); assert.ok(await b.state.scheduledTask(task));
  b.skills.length = 0;
  await assert.rejects(b.state.scheduledTask(task), /Install the scheduled skill/);
  b.switchMachine('access:other-host:22', { mode: 'ssh', host: 'other-host', port: 22 });
  const after = b.calls.length;
  assert.equal(await b.state.scheduledTask(task), null); assert.equal(b.calls.length, after);
  assert.ok(b.calls.every(call => ['project/list', 'fs/readDirectory', 'project/create', 'skills/list'].includes(call.method)));
});

for (const restart of [false, true]) test(`disabled conversation edits and clears survive peer changes${restart ? ' and restart while disabled' : ''}`, async t => {
  const { a, b } = fixture(t);
  const editA = { machine, kind: 'composer', cwd: a.root, threadId: 'disabled-edit', projectId: null };
  const clearA = { ...editA, threadId: 'disabled-clear' };
  const editB = { ...editA, cwd: b.root }, clearB = { ...clearA, cwd: b.root };
  const initialShortcuts = [{ id: 'initial', label: 'Initial', prompt: 'Initial shortcut' }];
  const localShortcuts = [{ id: 'local', label: 'Local', prompt: 'Keep local shortcut' }];
  const peerShortcuts = [{ id: 'peer', label: 'Peer', prompt: 'Peer changed shortcut' }];
  a.drafts.save(editA, { text: 'Initial editable draft', images: [] });
  a.drafts.save(clearA, { text: 'Initial draft to clear', images: [] });
  a.pins.set(a.options, 'disabled-edit', true); a.preferences.update({ shortcuts: initialShortcuts });
  await a.state.tick(); await b.state.tick();
  a.shared.enabled = false;
  const calls = a.bridgeCalls.length;
  a.drafts.save(editA, { text: 'Typed while sharing was disabled', images: [] }); a.state.captureDraft(editA);
  a.drafts.clear(clearA); a.state.captureDraft(clearA);
  a.pins.set(a.options, 'disabled-edit', false); a.state.sync.capture('pin', machine, 'disabled-edit', false);
  a.preferences.update({ shortcuts: localShortcuts }); a.state.sync.capture('shortcuts', machine, 'shortcuts', localShortcuts);
  await a.state.tick();
  if (restart) { a.restart(); a.connection.session = {}; await a.state.tick(); }
  assert.equal(a.bridgeCalls.length, calls);
  b.drafts.save(editB, { text: 'Peer edited the same draft', images: [] }); b.state.captureDraft(editB);
  b.drafts.save(clearB, { text: 'Peer replaced the cleared draft', images: [] }); b.state.captureDraft(clearB);
  b.preferences.update({ shortcuts: peerShortcuts }); b.state.sync.capture('shortcuts', machine, 'shortcuts', peerShortcuts);
  await b.state.tick();
  a.shared.enabled = true; await a.state.tick(); await b.state.tick();
  assert.equal(a.drafts.read(editA).text, 'Typed while sharing was disabled'); assert.equal(a.drafts.read(clearA), null);
  assert.deepEqual(a.preferences.read().shortcuts, localShortcuts);
  assert.deepEqual(a.pins.get(a.options), []); assert.deepEqual(b.pins.get(b.options), []);
  const conflicts = a.state.sync.conflicts();
  const edited = conflicts.find(conflict => conflict.key === stateKey('draft', machine, a.state.draftIdentity(editA).id));
  const cleared = conflicts.find(conflict => conflict.key === stateKey('draft', machine, a.state.draftIdentity(clearA).id));
  const shortcuts = conflicts.find(conflict => conflict.key === stateKey('shortcuts', machine, 'shortcuts'));
  assert.equal(edited.local.text, 'Typed while sharing was disabled'); assert.equal(edited.remote.value.text, 'Peer edited the same draft');
  assert.equal(cleared.local, null); assert.equal(cleared.remote.value.text, 'Peer replaced the cleared draft');
  assert.deepEqual(shortcuts.local, localShortcuts); assert.deepEqual(shortcuts.remote.value, peerShortcuts);
});

test('initially disabled conversation sharing uploads nothing until explicitly enabled', async t => {
  const { a, b } = fixture(t); a.shared.enabled = false;
  const project = { id: 'never-synced-project', provider: 'codex', name: 'Local project', roots: [{ path: a.root }] };
  a.nativeProjects.push(project);
  const target = { machine, kind: 'composer', cwd: a.root, projectId: project.id, threadId: null };
  a.drafts.save(target, { text: 'Keep this local until sharing is enabled', images: [] });
  a.pins.set(a.options, 'never-synced-chat', true);
  a.state.captureDraft(target); await a.state.tick(); await b.state.tick();
  assert.deepEqual(a.bridgeCalls, []); assert.deepEqual(a.calls, []);
  assert.equal(b.state.sync.entries('draft', machine).length, 0); assert.deepEqual(b.pins.get(b.options), []);
  a.shared.enabled = true; await a.state.tick(); await b.state.tick();
  assert.equal(b.state.sync.entries('draft', machine)[0].value.text, 'Keep this local until sharing is enabled');
  assert.equal(b.state.sync.entries('project', machine)[0].value.name, project.name);
  assert.deepEqual(b.pins.get(b.options), ['never-synced-chat']);
  assert.deepEqual(b.drafts.list(), []);
});

test('changing sync destination seeds a fresh namespace and returning restores its cached project, pins and draft', async t => {
  const { a, b } = fixture(t);
  const project = { id: 'namespace-project', provider: 'codex', name: 'Namespace project', roots: [{ path: a.root }] };
  a.nativeProjects.push(project);
  const target = { machine, kind: 'composer', cwd: a.root, projectId: project.id, threadId: null };
  a.drafts.save(target, { text: 'Old server draft', images: [] }); a.pins.set(a.options, 'namespace-chat', true);
  await a.state.tick(); await b.state.tick();
  const previousKey = a.shared.key, previousId = a.state.projectId(project.id), previousCursor = a.state.sync.state.cursor, session = a.connection.session;
  a.shared.key = 'fixture-server:/different-folder'; await a.state.tick();
  assert.equal(a.connection.session, session); assert.equal(a.state.sync.namespace, a.shared.key);
  assert.equal(a.state.sync.state.seeded, true);
  assert.equal(a.state.sync.entries('project', machine).length, 1); assert.equal(a.state.sync.entries('draft', machine).length, 1);
  assert.equal(a.state.sync.entries('pin', machine).find(entry => entry.id === 'namespace-chat').value, true);
  assert.notEqual(a.state.projectId(project.id), previousId);
  a.pins.set(a.options, 'namespace-chat', false); a.state.sync.capture('pin', machine, 'namespace-chat', false);
  a.drafts.save(target, { text: 'Only the new server draft', images: [] }); a.state.captureDraft(target); await a.state.tick();
  a.shared.key = previousKey; await a.state.tick();
  assert.equal(a.connection.session, session); assert.equal(a.state.projectId(project.id), previousId);
  assert.equal(a.state.sync.state.cursor, previousCursor);
  assert.deepEqual(a.pins.get(a.options), ['namespace-chat']); assert.equal(a.drafts.read(target).text, 'Old server draft');
  await b.state.tick();
  assert.equal(b.state.sync.entries('draft', machine)[0].value.text, 'Old server draft');
  assert.ok(a.calls.every(call => call.method === 'project/list'));
});

test('a renamed project immediately uses its pending local name while sync is offline', async t => {
  const { a } = fixture(t);
  const project = { id: 'renamed-native-project', provider: 'codex', name: 'Old project name', roots: [{ path: a.root }] };
  a.nativeProjects.push(project); await a.state.tick();
  const previous = a.state.projectId(project.id), count = a.bridgeCalls.length;
  a.shared.online = async () => { throw new Error('Sync server offline'); };
  const renamed = a.state.captureProject({ ...project, name: 'New project name' }, true);
  assert.equal(renamed.name, 'New project name'); assert.equal(renamed.sharedId, previous);
  assert.equal(a.state.projects([{ ...project, name: 'New project name' }])[0].name, 'New project name');
  assert.equal(a.state.projects([project])[0].name, 'New project name');
  assert.equal(a.bridgeCalls.length, count);
  assert.equal(a.state.sync.state.pending.findLast(op => op.kind === 'project').value.name, 'New project name');
});

test('an explicit project rename while sharing is disabled stays journaled through restart and re-enable', async t => {
  const { a, b } = fixture(t);
  const project = { id: 'paused-project', provider: 'codex', name: 'Original name', roots: [{ path: a.root }] };
  a.nativeProjects.push(project); await a.state.tick(); await b.state.tick();
  const id = a.state.projectId(project.id), calls = a.bridgeCalls.length;
  a.shared.enabled = false; project.name = 'Renamed while disabled';
  assert.equal(a.state.captureProject(project, true).name, project.name);
  await a.state.tick(); assert.equal(a.bridgeCalls.length, calls);
  a.restart(); a.shared.enabled = true;
  await a.state.tick(); await b.state.tick();
  assert.equal(a.state.projects([project])[0].name, project.name);
  assert.equal(b.state.catalog('project', id).name, project.name);
});

test('typing from an unseen editor version preserves the remote draft as a conflict even after its revision was pulled', async t => {
  const { a, b } = fixture(t);
  const targetA = { machine, kind: 'edit-message', threadId: 'editor-chat', itemId: 'turn', cwd: a.root };
  const targetB = { ...targetA, cwd: b.root };
  a.drafts.save(targetA, { text: 'Original' }); await a.state.tick(); await b.state.tick();
  a.drafts.save(targetA, { text: 'Peer changed the draft' }); a.state.captureDraft(targetA);
  await a.state.tick(); await b.state.tick();
  b.drafts.save(targetB, { text: 'Original plus local typing' }); b.state.captureDraft(targetB, false, true);
  await b.state.tick(); await a.state.tick();
  const conflict = b.state.sync.conflicts()[0];
  assert.equal(conflict.local.text, 'Original plus local typing'); assert.equal(conflict.remote.value.text, 'Peer changed the draft');
  assert.equal(a.drafts.read(targetA).text, 'Peer changed the draft');
  b.drafts.save(targetB, { text: 'Keep typing locally' }); b.state.captureDraft(targetB);
  await b.state.tick(); assert.equal(b.state.sync.conflicts()[0].local.text, 'Keep typing locally');
  await b.state.sync.resolve(conflict.key, 'local'); await b.state.tick(); await a.state.tick();
  assert.equal(a.drafts.read(targetA).text, 'Keep typing locally');
});

test('typing while a remote draft image downloads keeps the original applied revision for conflict detection', async t => {
  const { a, b } = fixture(t);
  const targetA = { machine, kind: 'composer', threadId: 'image-race-chat', cwd: a.root };
  const targetB = { ...targetA, cwd: b.root };
  a.drafts.save(targetA, { text: 'Original', images: [] }); await a.state.tick(); await b.state.tick();
  a.drafts.save(targetA, { text: 'Peer text with image', images: [{ name: 'remote.png', url: 'data:image/png;base64,aW1hZ2U=' }] }); a.state.captureDraft(targetA); await a.state.tick();
  const original = b.shared.bridge.call; let release, began;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  b.shared.bridge.call = async (method, args) => { if (method === 'blob-get') { began(); await held; } return original(method, args); };
  const pulling = b.state.tick(); await started;
  b.drafts.save(targetB, { text: 'Original plus local typing' }); b.state.captureDraft(targetB);
  release(); await pulling; await b.state.tick();
  const conflict = b.state.sync.conflicts()[0];
  assert.equal(b.drafts.read(targetB).text, 'Original plus local typing');
  assert.equal(conflict.local.text, 'Original plus local typing'); assert.equal(conflict.remote.value.text, 'Peer text with image');
});


test('cancelling a stale open editor preserves the newer shared draft instead of silently deleting it', async t => {
  const { a, b } = fixture(t);
  const ta = { machine, kind: 'edit-message', threadId: 'cancel-chat', itemId: 'cancel-turn', cwd: a.root }, tb = { ...ta, cwd: b.root };
  a.drafts.save(ta, { text: 'Original' }); await a.state.tick(); await b.state.tick();
  a.drafts.save(ta, { text: 'New peer draft' }); a.state.captureDraft(ta); await a.state.tick(); await b.state.tick();
  b.drafts.clear(tb); b.state.captureDraft(tb, false, true); await b.state.tick(); await a.state.tick();
  assert.equal(b.state.sync.conflicts()[0].local, null);
  assert.equal(b.state.sync.conflicts()[0].remote.value.text, 'New peer draft');
  assert.equal(a.drafts.read(ta).text, 'New peer draft');
});

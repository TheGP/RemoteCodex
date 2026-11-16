const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PreferencesStore } = require('../preferences.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-preferences-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'preferences.json');
}

test('theme and per-machine startup projects persist independently through restarts', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  assert.deepEqual(store.read(), { theme: 'system', startupProjects: {} });
  store.update({ theme: 'purple' });
  store.update({ startupProject: { machine: 'access:local', projectId: 'rapidcode' } });
  store.update({ startupProject: { machine: 'access:root@host:22', projectId: 'remote-project' } });
  assert.deepEqual(new PreferencesStore(file).read(), { theme: 'purple', startupProjects: { 'access:local': 'rapidcode', 'access:root@host:22': 'remote-project' } });
  store.update({ theme: 'claude-code' });
  store.update({ startupProject: { machine: 'access:local', projectId: null } });
  assert.deepEqual(new PreferencesStore(file).read(), { theme: 'claude-code', startupProjects: { 'access:root@host:22': 'remote-project' } });
});

test('invalid preferences and failed writes leave saved settings unchanged', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'dark' });
  for (const patch of [null, {}, [], { unknown: true }, { theme: 'unknown' }, { startupProject: null }, { startupProject: { machine: '__proto__', projectId: 'bad' } }, { startupProject: { machine: 'access:local', projectId: '' } }]) assert.throws(() => store.update(patch));
  assert.equal(store.read().theme, 'dark');
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ theme: 'light' }));
  assert.equal(new PreferencesStore(file).read().theme, 'dark');
});

test('file opener preferences persist without changing connection or other preferences', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'purple', startupProject: { machine: 'access:local', projectId: 'rapidcode' } });
  for (const fileOpener of ['gitferry', 'antigravity', 'reveal', 'vscode']) {
    store.update({ fileOpener });
    assert.equal(new PreferencesStore(file).read().fileOpener, fileOpener);
    assert.equal(store.read().theme, 'purple'); assert.equal(store.read().startupProjects['access:local'], 'rapidcode');
  }
  assert.throws(() => store.update({ fileOpener: 'shell-command' }));
  assert.equal(store.read().fileOpener, 'vscode');
});

test('unread and completion markers survive process restarts and remain separate per machine', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'purple', startupProject: { machine: 'access:local', projectId: 'rapidcode' } });
  store.update({ conversationState: { machine: 'access:local', unread: ['manual', 'manual'], completions: { finished: 'completed', broken: 'failed' } } });
  store.update({ conversationState: { machine: 'access:root@host:22', unread: ['remote'], completions: { done: 'completed' } } });
  const reopened = new PreferencesStore(file);
  assert.deepEqual(reopened.read().conversationStates['access:local'], { unread: ['manual'], completions: { finished: 'completed', broken: 'failed' } });
  reopened.update({ conversationState: { machine: 'access:local', unread: [], completions: {} } });
  assert.deepEqual(new PreferencesStore(file).read().conversationStates['access:local'], { unread: [], completions: {} });
  assert.deepEqual(new PreferencesStore(file).read().conversationStates['access:root@host:22'], { unread: ['remote'], completions: { done: 'completed' } });
  assert.equal(reopened.read().theme, 'purple');
  assert.equal(reopened.read().startupProjects['access:local'], 'rapidcode');
});

test('invalid markers and failed writes preserve the last saved unread state', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  const saved = { machine: 'access:local', unread: ['keep'], completions: { finished: 'completed' } };
  store.update({ conversationState: saved });
  for (const value of [null, { ...saved, machine: '__proto__' }, { ...saved, unread: [''] }, { ...saved, completions: [] }, { ...saved, completions: { finished: 'running' } }]) assert.throws(() => store.update({ conversationState: value }));
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ conversationState: { ...saved, unread: [] } }));
  assert.deepEqual(new PreferencesStore(file).read().conversationStates['access:local'], { unread: ['keep'], completions: { finished: 'completed' } });
});

test('conversation order survives restart independently for each project and machine', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'purple', conversationState: { machine: 'access:local', unread: ['unread'], completions: { finished: 'completed' } } });
  store.update({ threadOrder: { machine: 'access:local', projectId: 'rapidcode', ids: ['b', 'a', 'b'] } });
  store.update({ threadOrder: { machine: 'access:local', projectId: 'other', ids: ['other-b', 'other-a'] } });
  store.update({ threadOrder: { machine: 'access:host:22', projectId: 'rapidcode', ids: ['remote-a'] } });
  const saved = new PreferencesStore(file).read();
  assert.deepEqual(saved.threadOrders, { 'access:local': { rapidcode: ['b', 'a'], other: ['other-b', 'other-a'] }, 'access:host:22': { rapidcode: ['remote-a'] } });
  assert.equal(saved.theme, 'purple');
  assert.deepEqual(saved.conversationStates['access:local'].unread, ['unread']);
  const order = { machine: 'access:local', projectId: 'rapidcode', ids: ['a', 'b'] };
  for (const value of [null, { ...order, machine: '__proto__' }, { ...order, projectId: '' }, { ...order, ids: [''] }, { ...order, ids: 'invalid' }]) assert.throws(() => store.update({ threadOrder: value }));
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ threadOrder: order }));
  assert.deepEqual(new PreferencesStore(file).read().threadOrders['access:local'].rapidcode, ['b', 'a']);
});

test('conversation cutoffs persist and late migration preserves manual ordering', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  const target = { machine: 'access:local', projectId: 'rapidcode' };
  store.update({ threadOrder: { ...target, ids: ['b', 'a'] } });
  store.update({ threadOrder: { ...target, cutoff: 100 } });
  store.update({ threadOrder: { ...target, cutoff: 300 } });
  assert.equal(new PreferencesStore(file).read().threadOrderCutoffs['access:local'].rapidcode, 100);
  assert.deepEqual(store.read().threadOrders['access:local'].rapidcode, ['b', 'a']);
  store.update({ threadOrder: { ...target, ids: ['a', 'b'], cutoff: 400 } });
  store.update({ threadOrder: { ...target, cutoff: 100 } });
  assert.equal(store.read().threadOrderCutoffs['access:local'].rapidcode, 400);
  assert.deepEqual(store.read().threadOrders['access:local'].rapidcode, ['a', 'b']);
  store.update({ threadOrder: { ...target, machine: 'access:other:22', ids: ['remote'], cutoff: 0 } });
  assert.equal(store.read().threadOrderCutoffs['access:other:22'].rapidcode, 0);
  const before = store.read();
  for (const cutoff of [-1, null, '100', 1.5, NaN, Infinity]) assert.throws(() => store.update({ threadOrder: { ...target, cutoff } }));
  assert.deepEqual(store.read(), before);
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ threadOrder: { ...target, ids: ['b', 'a'], cutoff: 500 } }));
  assert.deepEqual(new PreferencesStore(file).read(), before);
});

test('prompt shortcuts persist, validate inputs, and allow removing all defaults', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  const shortcut = { id: 'review', label: 'Review', prompt: '$cr ur changes' };
  store.update({ shortcuts: [shortcut] });
  assert.deepEqual(new PreferencesStore(file).read().shortcuts, [shortcut]);
  for (const shortcuts of [null, {}, [shortcut, shortcut], [{ ...shortcut, label: ' ' }], [{ ...shortcut, label: 'a'.repeat(33) }], [{ ...shortcut, prompt: '' }], [{ ...shortcut, prompt: 'x'.repeat(20001) }]]) assert.throws(() => store.update({ shortcuts }));
  assert.deepEqual(store.read().shortcuts, [shortcut]);
  store.update({ shortcuts: [{ ...shortcut, mode: 'fill' }] });
  assert.equal(new PreferencesStore(file).read().shortcuts[0].mode, 'fill');
  assert.throws(() => store.update({ shortcuts: [{ ...shortcut, mode: 'invalid' }] }));
  assert.equal(store.read().shortcuts[0].mode, 'fill');
  store.update({ shortcuts: [] }); assert.deepEqual(new PreferencesStore(file).read().shortcuts, []);
});

test('completion sound accepts only booleans and survives restarting', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  assert.notEqual(store.read().completionSound, false);
  store.update({ completionSound: false });
  assert.equal(new PreferencesStore(file).read().completionSound, false);
  for (const completionSound of [null, 0, 1, 'false', {}, []]) assert.throws(() => store.update({ completionSound }));
  assert.equal(store.read().completionSound, false);
  store.update({ completionSound: true }); assert.equal(new PreferencesStore(file).read().completionSound, true);
});

test('skipping test diffs defaults on, persists both choices, and rejects invalid values', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  assert.notEqual(store.read().skipTestDiffs, false);
  for (const skipTestDiffs of [false, true]) {
    store.update({ skipTestDiffs });
    assert.equal(new PreferencesStore(file).read().skipTestDiffs, skipTestDiffs);
  }
  for (const skipTestDiffs of [null, undefined, 0, 1, 'false', {}, []]) assert.throws(() => store.update({ skipTestDiffs }));
  assert.equal(store.read().skipTestDiffs, true);
  fs.writeFileSync(file, JSON.stringify({ ...store.read(), skipTestDiffs: 'false' }));
  assert.throws(() => store.read(), /Invalid test diff preference/);
});

test('completion volume persists and rejects values outside the percentage range', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  for (const completionVolume of [0, 50, 100]) {
    store.update({ completionVolume });
    assert.equal(new PreferencesStore(file).read().completionVolume, completionVolume);
  }
  for (const completionVolume of [-1, 101, 0.5, null, undefined, NaN, Infinity, '50', {}]) assert.throws(() => store.update({ completionVolume }));
  assert.equal(store.read().completionVolume, 100);
  fs.writeFileSync(file, JSON.stringify({ theme: 'system', startupProjects: {}, completionVolume: 101 }));
  assert.throws(() => store.read(), /Invalid completion volume/);
});

test('message pins survive restart, remain separate per chat and machine, and preserve other preferences', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  store.update({ theme: 'purple' });
  const pin = { machine: 'access:local', threadId: 'chat', itemId: 'reply', turnId: 'turn', preview: 'Codex: Saved reply', pinned: true };
  store.update({ messagePin: pin });
  store.update({ messagePin: { ...pin, itemId: 'question', preview: 'You: Saved question' } });
  store.update({ messagePin: { ...pin, machine: 'access:host:22', preview: 'Remote reply' } });
  store.update({ messagePin: { ...pin, threadId: 'another-chat', preview: 'Other chat' } });
  const saved = new PreferencesStore(file).read();
  assert.deepEqual(saved.messagePins['access:local'].chat.map(value => value.itemId), ['reply', 'question']);
  assert.equal(saved.messagePins['access:host:22'].chat[0].preview, 'Remote reply');
  assert.equal(saved.messagePins['access:local']['another-chat'][0].preview, 'Other chat');
  assert.equal(saved.theme, 'purple');
  store.update({ messagePin: { ...pin, preview: 'Updated reply' } });
  assert.equal(store.read().messagePins['access:local'].chat.length, 2);
  store.update({ messagePin: { machine: pin.machine, threadId: pin.threadId, itemId: pin.itemId, pinned: false } });
  assert.deepEqual(store.read().messagePins['access:local'].chat.map(value => value.itemId), ['question']);
  store.update({ messagePin: { ...pin, itemId: 'question', pinned: false } });
  assert.equal(new PreferencesStore(file).read().messagePins['access:local'].chat, undefined);
});

test('invalid pins, excess pins, and failed writes preserve saved message pins', t => {
  const file = fixture(t); const store = new PreferencesStore(file);
  const pin = { machine: 'access:local', threadId: 'chat', itemId: 'reply', turnId: 'turn', preview: 'Saved reply', pinned: true };
  store.update({ messagePin: pin });
  const saved = store.read();
  for (const value of [null, { ...pin, machine: '__proto__' }, { ...pin, threadId: '__proto__' }, { ...pin, itemId: '' }, { ...pin, turnId: '' }, { ...pin, pinned: 'true' }, { ...pin, preview: 'x'.repeat(201) }]) assert.throws(() => store.update({ messagePin: value }));
  assert.deepEqual(store.read(), saved);
  for (let index = 1; index < 50; index++) store.update({ messagePin: { ...pin, itemId: 'reply-' + index } });
  assert.throws(() => store.update({ messagePin: { ...pin, itemId: 'extra' } }), /50 messages/);
  assert.equal(store.read().messagePins['access:local'].chat.length, 50);
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.update({ messagePin: { ...pin, pinned: false } }));
  assert.equal(new PreferencesStore(file).read().messagePins['access:local'].chat.length, 50);
  fs.writeFileSync(file, JSON.stringify({ ...saved, messagePins: { 'access:local': { chat: [{ itemId: 'bad' }] } } }));
  assert.throws(() => store.read(), /Invalid saved message pins/);
});


test('manual finished marks persist independently of unread state and remain scoped to each machine', t => {
  const file = fixture(t), store = new PreferencesStore(file);
  store.update({ conversationState: { machine: 'access:local', unread: ['chat'], completions: { chat: 'failed' } } });
  const mark = { machine: 'access:local', threadId: 'chat', finished: true };
  store.update({ finishedThread: mark }); store.update({ finishedThread: mark });
  store.update({ finishedThread: { ...mark, machine: 'access:other:22' } });
  const reopened = new PreferencesStore(file);
  assert.deepEqual(reopened.read().finishedThreads, { 'access:local': ['chat'], 'access:other:22': ['chat'] });
  reopened.update({ conversationState: { machine: 'access:local', unread: [], completions: {} } });
  assert.deepEqual(reopened.read().finishedThreads['access:local'], ['chat']);
  for (const value of [null, { ...mark, machine: '__proto__' }, { ...mark, threadId: '' }, { ...mark, finished: 'yes' }]) assert.throws(() => reopened.update({ finishedThread: value }));
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => reopened.update({ finishedThread: { ...mark, finished: false } }));
  assert.deepEqual(reopened.read().finishedThreads['access:local'], ['chat']);
  fs.rmdirSync(file + '.tmp');
  reopened.update({ finishedThread: { ...mark, finished: false } });
  assert.deepEqual(reopened.read().finishedThreads, { 'access:local': [], 'access:other:22': ['chat'] });
});

test('active runs recover as interrupted after restart without losing other conversation preferences', t => {
  const file = fixture(t), store = new PreferencesStore(file);
  store.update({ theme: 'purple', conversationState: { machine: 'access:local', unread: ['local-chat'], completions: { done: 'completed' } }, finishedThread: { machine: 'access:local', threadId: 'finished-chat', finished: true } });
  store.recordRun('access:local', 'local-chat', 'local-turn', 'codex');
  store.recordRun('access:local', 'agent:sample:thread:chat', 'agent:sample:turn:turn', 'sample');
  store.recordRun('access:user@host:22', 'remote-chat', 'remote-turn', 'codex');
  const reopened = new PreferencesStore(file), recovered = reopened.recoverInterruptedRuns();
  assert.equal(recovered.length, 3);
  assert.deepEqual(reopened.read().conversationStates['access:local'], { unread: ['local-chat'], completions: { done: 'completed', 'local-chat': 'interrupted', 'agent:sample:thread:chat': 'interrupted' } });
  assert.equal(reopened.read().conversationStates['access:user@host:22'].completions['remote-chat'], 'interrupted');
  assert.equal(reopened.read().activeRuns, undefined);
  assert.deepEqual(reopened.read().finishedThreads['access:local'], ['finished-chat']); assert.equal(reopened.read().theme, 'purple');
  assert.deepEqual(new PreferencesStore(file).recoverInterruptedRuns(), []);
  reopened.update({ conversationState: { machine: 'access:local', unread: [], completions: { done: 'completed' } } });
  assert.equal(new PreferencesStore(file).read().conversationStates['access:local'].completions['local-chat'], undefined);
});

test('run completions are fenced by machine, provider and exact turn, including early and duplicate events', t => {
  const file = fixture(t), store = new PreferencesStore(file);
  store.recordRun('access:local', 'chat', 'old-turn');
  store.recordRun('access:local', 'chat', 'new-turn');
  assert.equal(store.finishRun('access:local', 'chat', 'old-turn'), false);
  assert.equal(store.finishRun('access:local', 'chat', 'new-turn', 'sample'), false);
  assert.equal(store.finishRun('access:other-host:22', 'chat', 'new-turn'), false);
  assert.equal(store.recordRun('access:local', 'chat', 'old-turn'), false);
  assert.equal(store.read().activeRuns['access:local'].chat.turnId, 'new-turn');
  assert.equal(store.finishRun('access:local', 'chat', 'new-turn'), true);
  assert.equal(store.recordRun('access:local', 'chat', 'new-turn'), false);
  store.finishRun('access:local', 'fast-chat', 'fast-turn');
  assert.equal(store.recordRun('access:local', 'fast-chat', 'fast-turn'), false);
  assert.deepEqual(new PreferencesStore(file).recoverInterruptedRuns(), []);
  for (const args of [['access:local', undefined, 'turn'], ['access:local', '__proto__', 'turn'], ['access:local', 'chat', null], ['access:local', 'chat', 'turn', null], ['not-a-machine', 'chat', 'turn']]) assert.throws(() => store.recordRun(...args), /Invalid active run/);
});

test('conversation notes persist per machine and chat, validate text and remove empty notes', t => {
  const file = fixture(t), store = new PreferencesStore(file);
  store.update({ theme: 'purple', conversationNote: { machine: 'access:local', threadId: 'chat-a', text: '  First line\nSecond line <b>literal</b>  ' } });
  store.update({ conversationNote: { machine: 'access:local', threadId: 'chat-b', text: 'Other chat' } });
  store.update({ conversationNote: { machine: 'access:remote:22', threadId: 'chat-a', text: 'Other machine' } });
  assert.equal(new PreferencesStore(file).read().conversationNotes['access:local']['chat-a'], 'First line\nSecond line <b>literal</b>');
  for (const value of [null, { machine: 'invalid', threadId: 'chat-a', text: 'x' }, { machine: 'access:local', threadId: '__proto__', text: 'x' }, { machine: 'access:local', threadId: 'chat-a', text: 'x'.repeat(4001) }, { machine: 'access:local', threadId: 'chat-a', text: 'bad\0note' }, { machine: 'access:local', threadId: 'chat-a', text: 2 }]) assert.throws(() => store.update({ conversationNote: value }), /Invalid conversation note/);
  store.update({ conversationNote: { machine: 'access:local', threadId: 'chat-a', text: ' \n ' } });
  const saved = new PreferencesStore(file).read();
  assert.equal(saved.conversationNotes['access:local']['chat-a'], undefined);
  assert.equal(saved.conversationNotes['access:local']['chat-b'], 'Other chat'); assert.equal(saved.conversationNotes['access:remote:22']['chat-a'], 'Other machine'); assert.equal(saved.theme, 'purple');
});

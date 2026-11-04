const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentWakeLock } = require('../wake-lock.cjs');

function fixture() {
  const connection = new EventEmitter(); const starts = []; const stops = []; const changes = [];
  const blocker = { start: type => { starts.push(type); return starts.length - 1; }, stop: id => stops.push(id) };
  const lock = new AgentWakeLock(blocker, connection, working => changes.push(working));
  const notify = (method, params = {}) => connection.emit('notification', { method, params });
  const rpc = (phase, requestId, method, threadId, result) => connection.emit('rpc', { phase, requestId, method, threadId, result });
  return { connection, lock, starts, stops, changes, notify, rpc };
}

test('all working chats share one idle-sleep blocker until the final turn stops', () => {
  const f = fixture();
  f.notify('turn/started', { threadId: 'one', turn: { id: 'first' } });
  f.notify('turn/started', { threadId: 'two', turn: { id: 'second' } });
  f.notify('turn/started', { threadId: 'two', turn: { id: 'second' } });
  assert.deepEqual(f.starts, ['prevent-app-suspension']); assert.equal(f.lock.id, 0);
  f.notify('turn/completed', { threadId: 'one', turn: { id: 'first', status: 'completed' } });
  assert.equal(f.stops.length, 0);
  f.notify('turn/completed', { threadId: 'two', turn: { id: 'second', status: 'interrupted' } });
  assert.deepEqual(f.stops, [0]); assert.deepEqual(f.changes, [true, false]);
});

test('send/review/compaction dispatch blocks sleep, while history reads and failed sends do not leave it blocked', () => {
  for (const method of ['turn/start', 'turn/steer', 'review/start', 'thread/compact/start']) {
    const f = fixture();
    f.rpc('started', 1, 'thread/read', 'history'); assert.equal(f.starts.length, 0);
    f.rpc('started', 2, method, 'working'); assert.equal(f.starts.length, 1);
    f.rpc('finished', 2, method, 'working'); assert.deepEqual(f.stops, [0]);
    f.rpc('finished', 1, 'thread/read', 'history'); assert.equal(f.stops.length, 1);
  }
});

test('accepted turns stay awake even without start notifications, including scheduled sends and reviews', () => {
  for (const method of ['turn/start', 'review/start']) {
    const f = fixture();
    f.rpc('started', 1, method, 'chat');
    f.rpc('finished', 1, method, 'chat', { turn: { id: 'accepted', status: 'inProgress' } });
    assert.equal(f.stops.length, 0);
    f.notify('turn/completed', { threadId: 'chat', turn: { id: 'accepted', status: 'failed' } });
    assert.deepEqual(f.stops, [0]);
  }
});

test('opening/listing already-running chats acquires a blocker without selecting or resuming their writer', () => {
  const f = fixture();
  f.rpc('started', 1, 'thread/list');
  f.rpc('finished', 1, 'thread/list', undefined, { data: [{ id: 'running', status: { type: 'active' } }, { id: 'idle', status: { type: 'idle' } }] });
  assert.equal(f.starts.length, 1); assert.equal(f.lock.active.size, 1);
  f.notify('thread/status/changed', { threadId: 'running', status: { type: 'idle' } });
  assert.deepEqual(f.stops, [0]);
  f.rpc('started', 2, 'thread/read', 'reopened');
  f.rpc('finished', 2, 'thread/read', 'reopened', { thread: { id: 'reopened', status: { type: 'active' } } });
  assert.equal(f.starts.length, 2);
  f.notify('thread/status/changed', { threadId: 'reopened', status: { type: 'systemError' } });
  assert.deepEqual(f.stops, [0, 1]);
});

test('late RPC snapshots and duplicate turn events cannot resurrect finished work or release a newer turn', () => {
  const f = fixture();
  f.rpc('started', 1, 'turn/start', 'chat');
  f.notify('turn/started', { threadId: 'chat', turn: { id: 'old' } });
  f.rpc('started', 2, 'thread/list');
  f.notify('turn/completed', { threadId: 'chat', turn: { id: 'old' } });
  f.rpc('finished', 1, 'turn/start', 'chat', { turn: { id: 'old', status: 'inProgress' } });
  f.rpc('finished', 2, 'thread/list', undefined, { data: [{ id: 'chat', status: { type: 'active' } }] });
  f.notify('turn/started', { threadId: 'chat', turn: { id: 'old' } });
  assert.equal(f.lock.active.size, 0); assert.equal(f.starts.length, 1); assert.deepEqual(f.stops, [0]);
  f.rpc('started', 3, 'thread/read', 'chat');
  f.notify('turn/started', { threadId: 'chat', turn: { id: 'new' } });
  f.notify('turn/completed', { threadId: 'chat', turn: { id: 'old' } });
  f.rpc('finished', 3, 'thread/read', 'chat', { thread: { id: 'chat', status: { type: 'idle' } } });
  assert.equal(f.lock.active.get('chat'), 'new'); assert.equal(f.stops.length, 1);
});

test('terminal errors release the affected chat, while retrying errors and other active chats keep it awake', () => {
  const f = fixture();
  f.notify('turn/started', { threadId: 'one', turn: { id: 'first' } });
  f.notify('turn/started', { threadId: 'two', turn: { id: 'second' } });
  f.notify('error', { threadId: 'one', willRetry: true }); assert.equal(f.lock.active.size, 2);
  f.notify('error', { threadId: 'one', willRetry: false }); assert.equal(f.lock.active.size, 1); assert.equal(f.stops.length, 0);
  f.notify('error', { threadId: 'two', turnId: 'older-error', willRetry: false }); assert.equal(f.lock.active.size, 1);
  f.notify('error', { threadId: 'two', turnId: 'second', willRetry: false }); assert.deepEqual(f.stops, [0]);
});

test('disconnect, reconnect, and app cleanup release every hold and ignore responses from the old connection', () => {
  for (const cleanup of ['disconnected', 'connection/closed', 'quit']) {
    const f = fixture();
    f.rpc('started', 1, 'turn/start', 'chat');
    if (cleanup === 'disconnected') f.connection.emit('disconnected');
    else if (cleanup === 'quit') f.lock.clear();
    else f.notify(cleanup);
    f.rpc('finished', 1, 'turn/start', 'chat', { turn: { id: 'late', status: 'inProgress' } });
    assert.equal(f.lock.active.size, 0); assert.equal(f.lock.pending.size, 0); assert.deepEqual(f.stops, [0]);
    f.notify('turn/started', { threadId: 'new-machine', turn: { id: 'new' } }); assert.equal(f.starts.length, 2);
    f.lock.clear(); assert.deepEqual(f.stops, [0, 1]);
  }
});

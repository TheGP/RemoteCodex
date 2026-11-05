const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CodexConnection } = require('../transport.cjs');
const { ScheduleStore, Scheduler } = require('../scheduler.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-scheduler-live-'));
  const connection = new CodexConnection();
  const messages = [];
  const completed = new Set();
  connection.on('notification', message => {
    if (message.method === 'item/completed') messages.push(message.params);
    if (message.method === 'turn/completed') completed.add(message.params.turn.id);
  });
  const wait = async check => {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Scheduled test did not finish');
  };
  let threadId;
  try {
    const store = new ScheduleStore(path.join(directory, 'schedules.json'));
    await connection.connect({ mode: 'local' });
    const started = await connection.call('thread/start', { cwd: os.tmpdir(), approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6.1-sol' });
    threadId = started.thread.id;
    const servers = await connection.call('mcpServerStatus/list', { limit: 100 });
    assert.ok(!servers.data.some(server => server.name === 'remote_codex_scheduler'), 'Scheduler MCP was exposed to the agent');
    console.log('PASS scheduler MCP stays disabled in native Codex');
    await connection.call('thread/name/set', { threadId, name: 'Scheduled first message test' });
    const text = 'Reply exactly SCHEDULE_DELIVERY_OK. Do not use tools.';
    store.enqueue({ machine: 'access:local', thread: started.thread, text, images: [], input: [{ type: 'text', text }], access: { sandbox: 'read-only', approvalPolicy: 'never' }, mode: 'default', turnSettings: { threadId, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } } }, 1);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].threadId, threadId);
    console.log('PASS scheduled message persists its conversation and settings without sending now');
    const closed = new Promise(resolve => connection.child.once('close', resolve));
    connection.disconnect(); await closed;
    await connection.connect({ mode: 'local' });
    const scheduler = new Scheduler({ store: new ScheduleStore(store.file), connection, available: () => true });
    for (let attempt = 0; attempt < 40; attempt++) {
      await scheduler.tick(Date.now() + 3601000 + attempt * 61000);
      if (scheduler.store.list()[0].status !== 'pending') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(scheduler.store.list()[0].status, 'sent', scheduler.store.list()[0].error || 'Scheduled task was deferred');
    await wait(() => completed.has(scheduler.store.list()[0].turnId));
    assert.ok(messages.some(params => params.threadId === threadId && params.item.type === 'agentMessage' && params.item.text.includes('SCHEDULE_DELIVERY_OK')));
    console.log('PASS persisted overdue task survives a native Codex restart and receives the expected reply in its original chat');
  } finally {
    if (threadId && connection.ready) await connection.call('thread/archive', { threadId }).catch(() => {});
    connection.disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

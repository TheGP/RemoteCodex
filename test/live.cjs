const assert = require('node:assert/strict');
const { CodexConnection } = require('../transport.cjs');

async function main() {
  const connection = new CodexConnection();
  let threadId;
  try {
    await connection.connect({ host: process.env.CODEX_TEST_HOST || 'root@warmer', cwd: '/tmp' });
    console.log('PASS SSH initialization');
    const models = await connection.call('model/list', { limit: 100 });
    assert.ok(models.data.length);
    console.log('PASS model catalog');
    const created = await connection.call('thread/start', { cwd: '/tmp', sandbox: 'read-only', approvalPolicy: 'on-request' });
    threadId = created.thread.id;
    let delta = '', completed;
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inference timed out')), 120000);
      connection.on('notification', message => {
        if (message.params?.threadId !== threadId) return;
        if (message.method === 'item/agentMessage/delta') delta += message.params.delta;
        if (message.method === 'turn/completed') { completed = message.params.turn; clearTimeout(timer); resolve(); }
        if (message.id !== undefined) connection.rejectRequest(message.id);
      });
    });
    await connection.call('turn/start', { threadId, input: [{ type: 'text', text: 'Reply exactly REMOTE_CODEX_OK. Do not call tools.', text_elements: [] }] });
    await completion;
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
    assert.match(delta, /REMOTE_CODEX_OK/);
    console.log('PASS live streamed inference');
    const list = await connection.call('thread/list', { limit: 100, modelProviders: [] });
    assert.ok(list.data.some(thread => thread.id === threadId));
    connection.disconnect();
    await connection.connect({ host: process.env.CODEX_TEST_HOST || 'root@warmer', cwd: '/tmp' });
    await connection.call('thread/resume', { threadId, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request' });
    const history = await connection.call('thread/turns/list', { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    assert.ok(history.data.flatMap(turn => turn.items).some(item => item.text?.includes('REMOTE_CODEX_OK')));
    console.log('PASS reconnect and persisted history');
  } finally {
    if (threadId && connection.ready) await connection.call('thread/archive', { threadId }).catch(error => console.error('Test conversation cleanup:', error.message));
    connection.disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

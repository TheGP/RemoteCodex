const assert = require('node:assert/strict');
const { CodexConnection } = require('../transport.cjs');

async function main() {
  const connection = new CodexConnection();
  const created = [];
  const options = process.env.CODEX_TEST_HOST ? { host: process.env.CODEX_TEST_HOST } : { mode: 'local' };
  const history = async threadId => (await connection.call('thread/turns/list', { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full' })).data.reverse();
  async function send(threadId, text) {
    let listener, timer;
    const completion = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Test turn timed out')), 120000);
      listener = message => {
        if (message.params?.threadId === threadId && message.method === 'turn/completed') resolve(message.params.turn);
        if (message.id !== undefined) connection.rejectRequest(message.id);
      };
      connection.on('notification', listener);
    });
    try {
      await connection.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
      const result = await completion;
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
    } finally { clearTimeout(timer); connection.off('notification', listener); }
  }
  try {
    await connection.connect(options);
    const source = (await connection.call('thread/start', { cwd: '/tmp', sandbox: 'read-only', approvalPolicy: 'on-request' })).thread;
    created.push(source.id);
    await connection.call('thread/name/set', { threadId: source.id, name: 'Temporary clone/edit verification' });
    await send(source.id, 'Reply exactly FIRST_BRANCH_CHECK. Do not use tools.');
    await send(source.id, 'Reply exactly ORIGINAL_SECOND_CHECK. Do not use tools.');
    const original = await history(source.id);
    assert.equal(original.length, 2);
    source.cwd = (await connection.call('thread/read', { threadId: source.id, includeTurns: false })).thread.cwd;
    async function fork(beforeTurnId) {
      const result = await connection.call('thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true, sandbox: 'read-only', approvalPolicy: 'on-request', ...(beforeTurnId ? { beforeTurnId } : {}) });
      created.push(result.thread.id);
      assert.equal(result.thread.cwd, source.cwd);
      assert.equal(result.thread.forkedFromId, source.id);
      return result.thread;
    }
    const cloned = await fork();
    assert.deepEqual((await history(cloned.id)).map(turn => turn.id), original.map(turn => turn.id));
    console.log('PASS clone copies both turns into an independent conversation');
    const edited = await fork(original[1].id);
    assert.deepEqual((await history(edited.id)).map(turn => turn.id), [original[0].id]);
    await send(edited.id, 'Reply exactly EDITED_SECOND_CHECK. Do not use tools.');
    const editedHistory = JSON.stringify(await history(edited.id));
    assert.match(editedHistory, /EDITED_SECOND_CHECK/);
    assert.doesNotMatch(editedHistory, /ORIGINAL_SECOND_CHECK/);
    console.log('PASS edit/resend keeps earlier context and excludes the replaced turn');
    const first = await fork(original[0].id);
    assert.equal((await history(first.id)).length, 0);
    console.log('PASS editing the first turn creates an empty history prefix');
    assert.deepEqual(await history(source.id), original);
    console.log('PASS original conversation history remains unchanged');
  } finally {
    for (const threadId of created.reverse()) if (connection.ready) await connection.call('thread/archive', { threadId });
    connection.disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

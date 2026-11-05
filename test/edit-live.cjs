const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CodexConnection } = require('../transport.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-edit-live-'));
  const connection = new CodexConnection(); const completed = new Set();
  connection.on('notification', message => { if (message.method === 'turn/completed') completed.add(message.params.turn.id); });
  let threadId;
  try {
    await connection.connect({ mode: 'local' });
    const started = await connection.call('thread/start', { cwd: directory, historyMode: 'paginated', sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6.1-sol' });
    threadId = started.thread.id;
    assert.equal(started.thread.historyMode, 'paginated');
    await connection.call('thread/name/set', { threadId, name: 'In-place edit verification' });
    const run = async text => {
      const result = await connection.call('turn/start', { threadId, input: [{ type: 'text', text }] });
      for (let attempt = 0; attempt < 240; attempt++) {
        if (completed.has(result.turn.id)) return result.turn.id;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Edit test turn did not finish');
    };
    const first = await run('Reply exactly ORIGINAL_ONE. Do not use tools.');
    const second = await run('Reply exactly ORIGINAL_TWO. Do not use tools.');
    const sentinel = path.join(directory, 'unchanged.txt'); fs.writeFileSync(sentinel, 'Keep this file change');
    const reverted = await connection.call('thread/revert', { threadId, beforeTurnId: second });
    assert.equal(reverted.thread.id, threadId);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Keep this file change');
    const retained = await connection.call('thread/turns/list', { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    assert.deepEqual(retained.data.map(turn => turn.id), [first]);
    const edited = await run('Reply exactly EDITED_TWO. Do not use tools.');
    const after = await connection.call('thread/turns/list', { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    assert.deepEqual(after.data.map(turn => turn.id), [edited, first]);
    assert.ok(after.data[0].items.some(item => item.type === 'agentMessage' && item.text.includes('EDITED_TWO')));
    const metadata = await connection.call('thread/read', { threadId, includeTurns: false });
    assert.equal(metadata.thread.name, 'In-place edit verification');
    console.log('PASS native edit retains its conversation ID/title, replaces later history, resends the revision, and preserves files');
    await connection.call('thread/revert', { threadId, beforeTurnId: first });
    const empty = await connection.call('thread/turns/list', { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    assert.equal(empty.data.length, 0);
    console.log('PASS native first-message editing rewinds to an empty history in the same conversation');
  } finally {
    if (threadId && connection.ready) await connection.call('thread/archive', { threadId }).catch(() => {});
    connection.disconnect(); fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

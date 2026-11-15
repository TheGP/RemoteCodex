const assert = require('node:assert/strict');
const { CodexConnection } = require('../transport.cjs');

const options = { host: process.env.CODEX_TEST_HOST || 'root@warmer', sharedServer: true };
const first = new CodexConnection(), second = new CodexConnection();
let threadId, turnId;
const timers = new Set();
function waitFor(connection, method, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120000);
    timers.add(timer);
    const listener = message => {
      if (message.params?.threadId !== threadId || message.method !== method || !predicate(message)) return;
      clearTimeout(timer); timers.delete(timer); connection.removeListener('notification', listener); resolve(message);
    };
    connection.on('notification', listener);
  });
}

(async () => {
  try {
    await first.connect(options);
    await second.connect(options);
    console.log('PASS two independent clients connect to the shared daemon');
    const created = await first.call('thread/start', { cwd: '/tmp', sandbox: 'read-only', approvalPolicy: 'never' });
    threadId = created.thread.id;
    await first.call('thread/name/set', { threadId, name: 'Remote Codex shared-server smoke test' });
    const started = waitFor(first, 'item/started', message => message.params.item?.type === 'commandExecution');
    const result = await first.call('turn/start', { threadId, input: [{ type: 'text', text: 'Run sleep 20 once with the shell tool, then reply exactly SHARED_SERVER_OK. Do not read or modify files.' }] });
    turnId = result.turn.id;
    await started;
    const viewed = await second.call('thread/resume', { threadId, excludeTurns: true });
    assert.equal(viewed.thread.status.type, 'active');
    first.disconnect(); second.disconnect();
    console.log('PASS both clients disconnect during the running turn');
    await second.connect(options);
    const completion = waitFor(second, 'turn/completed');
    const resumed = await second.call('thread/resume', { threadId, excludeTurns: true });
    assert.equal(resumed.thread.status.type, 'active');
    console.log('PASS reconnect finds the same running turn');
    const completed = (await completion).params.turn;
    assert.equal(completed.id, turnId);
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
    const history = await second.call('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full' });
    assert.ok(history.data.flatMap(turn => turn.items).some(item => item.text?.includes('SHARED_SERVER_OK')));
    console.log('PASS work completes and its history remains available');
    await second.call('thread/archive', { threadId }); threadId = null;
    const modes = await second.call('collaborationMode/list');
    const plan = modes.data.find(mode => mode.mode === 'plan');
    assert.ok(plan, 'Server lacks Plan mode');
    const models = await second.call('model/list', { limit: 100 });
    const model = plan.model || models.data.find(model => model.isDefault)?.model || models.data[0].model;
    const questionThread = await second.call('thread/start', { cwd: '/tmp', sandbox: 'read-only', approvalPolicy: 'never', model });
    threadId = questionThread.thread.id;
    await second.call('thread/name/set', { threadId, name: 'Remote Codex question recovery smoke test' });
    const question = waitFor(second, 'item/tool/requestUserInput');
    const questionTurn = await second.call('turn/start', {
      threadId, collaborationMode: { mode: 'plan', settings: { model, reasoning_effort: 'low', developer_instructions: null } },
      input: [{ type: 'text', text: 'Use request_user_input now to ask me to choose Alpha or Beta. Ask exactly one question and wait for my answer. Do not call any other tools. After my answer, reply exactly QUESTION_RECOVERED.' }]
    });
    turnId = questionTurn.turn.id;
    await question; second.disconnect();
    await first.connect(options);
    const replay = waitFor(first, 'item/tool/requestUserInput');
    await first.call('thread/resume', { threadId, excludeTurns: true });
    const restored = await replay;
    const answered = waitFor(first, 'turn/completed');
    first.respond(restored.id, { answers: Object.fromEntries(restored.params.questions.map(question => [question.id, { answers: ['Alpha'] }])) });
    assert.equal((await answered).params.turn.status, 'completed');
    console.log('PASS a pending question survives disconnect, reappears, and accepts an answer');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    const cleanup = first.ready ? first : second;
    try {
      if (threadId && cleanup.ready) {
        const read = await cleanup.call('thread/read', { threadId, includeTurns: false });
        if (read.thread.status.type === 'active') await cleanup.call('turn/interrupt', { threadId, turnId });
        await cleanup.call('thread/archive', { threadId });
      }
    } finally { first.disconnect(); second.disconnect(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

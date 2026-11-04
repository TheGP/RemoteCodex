const assert = require('node:assert/strict');
const test = require('node:test');
const { generateTitle, readThreadForTitle } = require('../titles.cjs');

const emptyRollout = () => new Error('failed to read thread: thread-store internal error: failed to read session metadata /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty');

test('title reads wait for new rollout metadata and keep read parameters unchanged', async () => {
  const pauses = []; let calls = 0;
  const ready = { thread: { id: 'new-chat', name: null } };
  const connection = { call: async (method, params) => {
    assert.equal(method, 'thread/read'); assert.deepEqual(params, { threadId: 'new-chat', includeTurns: false });
    if (++calls < 3) throw emptyRollout();
    return ready;
  } };
  assert.equal(await readThreadForTitle(connection, 'new-chat', () => true, async pause => pauses.push(pause)), ready);
  assert.deepEqual(pauses, [100, 250]); assert.equal(calls, 3);
});

test('empty rollout retries are bounded and leave the title available for a later attempt', async () => {
  let calls = 0; const pauses = [];
  const connection = { call: async () => { calls++; throw emptyRollout(); } };
  assert.equal(await readThreadForTitle(connection, 'new-chat', () => true, async pause => pauses.push(pause)), null);
  assert.equal(calls, 6); assert.deepEqual(pauses, [100, 250, 500, 1000, 2000]);
  connection.call = async () => ({ thread: { id: 'new-chat' } });
  assert.equal((await readThreadForTitle(connection, 'new-chat', () => true)).thread.id, 'new-chat');
});

test('title read retries stop when a connection changes or a manual title arrives', async () => {
  for (const reason of ['connection changed', 'manually renamed']) {
    let current = true; let calls = 0;
    const connection = { call: async () => { calls++; throw emptyRollout(); } };
    assert.equal(await readThreadForTitle(connection, reason, () => current, async () => { current = false; }), null);
    assert.equal(calls, 1);
    assert.equal(await readThreadForTitle(connection, reason, () => false), null);
    assert.equal(calls, 1);
  }
});

test('title reads do not retry or hide unrelated thread errors', async () => {
  for (const message of ['thread not found', 'Permission denied', 'OpenRouter returned an empty title response.']) {
    let calls = 0;
    const connection = { call: async () => { calls++; throw new Error(message); } };
    await assert.rejects(readThreadForTitle(connection, 'new-chat', () => true, async () => assert.fail('Unexpected retry')), { message });
    assert.equal(calls, 1);
  }
});

test('titles use a fixed cheap model, bounded output, and isolated prompt data', async () => {
  let calls = 0;
  const title = await generateTitle('Fix the login page', 'test-key', async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openai/gpt-4.1-nano');
    assert.equal(body.max_tokens, calls === 1 ? 40 : 4);
    assert.equal(body.temperature, 0);
    if (calls === 1) {
      assert.equal(body.messages[1].content, 'Fix the login page');
      assert.match(body.messages[0].content, /Never translate/);
    } else {
      assert.deepEqual(JSON.parse(body.messages[1].content), { request: 'Fix the login page', title: 'Login Page Repair' });
      assert.match(body.messages[0].content, /untrusted data/);
    }
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: calls === 1 ? '"Login\nPage Repair."' : 'SAME' } }] }) };
  });
  assert.equal(title, 'Login Page Repair');
  assert.equal(calls, 2);
});

test('a translated title is rejected in favor of the original prompt preview', async () => {
  const prompt = 'we were running 2 ab tests, find conversation in history we have saved here and find context there and tell me how ab tests are doing';
  let calls = 0;
  const title = await generateTitle(prompt, 'test-key', async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (calls === 2) assert.deepEqual(JSON.parse(body.messages[1].content), { request: prompt, title: 'Buscar conversaciones pasadas de pruebas A/B' });
    return { ok: true, json: async () => ({ choices: [{ message: { content: calls === 1 ? 'Buscar conversaciones pasadas de pruebas A/B' : 'DIFFERENT' } }] }) };
  });
  assert.equal(title, prompt.slice(0, 80));
});

test('matching Spanish and Russian titles are kept without forcing English', async () => {
  for (const [prompt, expected] of [['Arregla el error de inicio de sesión', 'Reparar inicio de sesión'], ['Исправь ошибку входа в приложение', 'Исправление ошибки входа']]) {
    let calls = 0;
    const title = await generateTitle(prompt, 'test-key', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ++calls === 1 ? expected : 'SAME' } }] }) }));
    assert.equal(title, expected);
  }
});

test('an uncertain language verdict keeps the prompt language and verification failures do not save a title', async () => {
  let calls = 0;
  const title = await generateTitle('  Check\nthis request  ', 'test-key', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ++calls === 1 ? 'Otra conversación' : 'uncertain' } }] }) }));
  assert.equal(title, 'Check this request');
  calls = 0;
  await assert.rejects(generateTitle('Check this request', 'test-key', async () => ++calls === 1 ? { ok: true, json: async () => ({ choices: [{ message: { content: 'Check this request' } }] }) } : { ok: false, status: 503 }), /HTTP 503/);
});

test('title failures expose status without upstream bodies or credentials', async () => {
  await assert.rejects(generateTitle('test', ''), /key unavailable/);
  await assert.rejects(generateTitle('x'.repeat(4001), 'key'), /Invalid title prompt/);
  await assert.rejects(generateTitle('test', 'key', async () => ({ ok: false, status: 401 })), /HTTP 401/);
  await assert.rejects(generateTitle('test', 'key', async () => ({ ok: true, json: async () => ({ choices: [] }) })), /empty title/);
});

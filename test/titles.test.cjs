const assert = require('node:assert/strict');
const test = require('node:test');
const { generateTitle } = require('../titles.cjs');

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

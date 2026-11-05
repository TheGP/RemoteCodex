const test = require('node:test');
const assert = require('node:assert/strict');
const { openWebLink } = require('../links.cjs');

test('web and localhost links open externally with their path, query, and fragment intact', async () => {
  const opened = [];
  for (const url of ['https://example.com/docs?x=1#section', 'http://localhost:5173/?view=graphs#results', 'http://127.0.0.1:3000/', 'http://[::1]:8080/', ' https://example.com/with a space ']) await openWebLink(url, async value => opened.push(value));
  assert.deepEqual(opened, ['https://example.com/docs?x=1#section', 'http://localhost:5173/?view=graphs#results', 'http://127.0.0.1:3000/', 'http://[::1]:8080/', 'https://example.com/with%20a%20space']);
});

test('non-web, malformed, and control-character links never reach the OS opener', async () => {
  let calls = 0;
  for (const value of [null, {}, '', '/tmp/page.html', '#section', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///Applications/Terminal.app', 'vscode://file/tmp/test', 'mailto:user@example.com', 'https://example.com/\nattack', 'https://example.com/\0', 'https://' + 'a'.repeat(8192)]) await assert.rejects(openWebLink(value, async () => { calls++; }));
  assert.equal(calls, 0);
});

test('browser launch errors are returned to the UI', async () => {
  await assert.rejects(openWebLink('http://localhost:5173', async () => { throw new Error('Browser could not be opened'); }), /Browser could not be opened/);
});

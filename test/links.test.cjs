const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openWebLink, parseFileLink, editorSshHost, openFileLink } = require('../links.cjs');

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

test('file links resolve workspace paths, encoded names, and line/column references', () => {
  for (const link of ['/work/src/a.ts:12:3', 'src/a.ts:12:3', './src/a.ts#L12C3', 'file:///work/src/a.ts#L12C3-L14C7']) assert.deepEqual(parseFileLink(link, '/work'), { file: '/work/src/a.ts', line: 12, column: 3 });
  assert.deepEqual(parseFileLink('a.ts:12', '/work'), { file: '/work/a.ts', line: 12, column: null });
  assert.equal(parseFileLink('src/a%20b%23c.ts', '/work').file, '/work/src/a b#c.ts');
  assert.deepEqual(parseFileLink('file:///C:/work/src/a.ts:8:2', 'C:\\work'), { file: 'C:\\work\\src\\a.ts', line: 8, column: 2 });
  assert.equal(parseFileLink('src\\a.ts', 'C:\\work').file, 'C:\\work\\src\\a.ts');
  for (const value of ['javascript:alert(1)', 'vscode://file/tmp/file', 'https://example.com/a', 'file://server/share/a.ts', '//server/a.ts', '\\\\server\\a.ts', '/work/a.ts%00', '/work/a.ts:0', '/work/a.ts:2:0', '/work/a.ts#bad', '/work/a.ts?command=execute', '#L1', '', null, '/work/a\n.ts']) assert.throws(() => parseFileLink(value, '/work'), String(value));
  assert.throws(() => parseFileLink('src/a.ts', null));
});

test('local file openers receive encoded paths and positions without executing file contents', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-file-links-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'some #code.ts'); fs.writeFileSync(file, 'const value = 1;');
  const opened = []; const revealed = [];
  const options = { cwd: folder, settings: { mode: 'local' }, application: () => 'Editor', openExternal: async url => opened.push(url), reveal: target => revealed.push(target) };
  const link = 'some%20%23code.ts:12:3';
  await openFileLink(link, options);
  assert.equal(opened[0], 'vscode://file' + file.split('/').map(encodeURIComponent).join('/') + ':12:3');
  await openFileLink(link, { ...options, opener: 'antigravity' });
  assert.ok(opened[1].startsWith('antigravity-ide://file/'));
  await openFileLink(link, { ...options, opener: 'reveal' }); assert.deepEqual(revealed, [file]);
  await openFileLink(link, { ...options, opener: 'gitferry' });
  const gitferry = new URL(opened[2]);
  assert.equal(gitferry.protocol, 'gitferry:'); assert.equal(gitferry.hostname, 'open');
  assert.deepEqual(Object.fromEntries(gitferry.searchParams), { file, line: '12', column: '3' });
  await assert.rejects(openFileLink(link, { ...options, application: () => '' }), /Install VS Code/);
  await assert.rejects(openFileLink(link, { ...options, opener: 'gitferry', application: () => '' }), /Install GitFerry/);
  await assert.rejects(openFileLink(link, { ...options, current: () => { throw new Error('Machine changed'); } }), /Machine changed/);
  await assert.rejects(openFileLink('missing.ts', options), /ENOENT/);
  await assert.rejects(openFileLink(folder, options), /not point to a file/);
  assert.equal(opened.length, 3);
});

test('SSH file links target the remote editor and never open a matching local path', async () => {
  const opened = [];
  const options = { cwd: '/remote/project', settings: { mode: 'ssh', host: 'user@server', port: 22 }, application: () => 'Editor', sshHost: settings => editorSshHost(settings, async () => ({ stdout: 'hostname server\nport 22\n' })), openExternal: async url => opened.push(url) };
  await openFileLink('src/a.ts:12', options);
  assert.equal(opened[0], 'vscode://vscode-remote/ssh-remote+user%40server/remote/project/src/a.ts:12:1');
  for (const opener of ['reveal', 'antigravity']) await assert.rejects(openFileLink('src/a.ts', { ...options, opener }), /SSH machine/);
  await assert.rejects(openFileLink('src/a.ts', { ...options, settings: { ...options.settings, port: 2222 } }), /SSH host alias/);
  await openFileLink('src/a.ts:12', { ...options, opener: 'gitferry' });
  assert.deepEqual(Object.fromEntries(new URL(opened[1]).searchParams), { file: 'ssh://user@server/remote/project/src/a.ts', line: '12', column: '1' });
  const customPort = { ...options, settings: { mode: 'ssh', host: 'custom-ssh-alias', port: 2222 }, sshHost: settings => editorSshHost(settings, async () => ({ stdout: 'hostname server\nport 2222\n' })) };
  await openFileLink('src/a.ts:12', customPort);
  assert.ok(opened[2].startsWith('vscode://vscode-remote/ssh-remote+custom-ssh-alias/'));
  await openFileLink('src/a.ts:12', { ...customPort, opener: 'gitferry' });
  assert.equal(new URL(opened[3]).searchParams.get('file'), 'ssh://custom-ssh-alias/remote/project/src/a.ts');
  assert.equal(opened.length, 4);
});

test('remote editors validate the SSH alias port without connecting or ignoring the chat’s port', async () => {
  const calls = [];
  const settings = { mode: 'ssh', host: 'user@my-ssh-alias', port: 2222 };
  const run = async (...args) => { calls.push(args); return { stdout: 'hostname real-host\nport 2222\n' }; };
  assert.equal(await editorSshHost(settings, run), settings.host);
  assert.deepEqual(calls[0][1], ['-G', settings.host]);
  await assert.rejects(editorSshHost({ ...settings, port: 22 }, run), /Port 22/);
  await assert.rejects(editorSshHost(settings, async () => ({ stdout: '' })), /SSH host alias/);
});

test('native GitFerry links preserve encoded names, columns, defaults, and repeated clicks', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-native-gitferry-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, '文 #literal%20+&.ts'); fs.writeFileSync(file, 'first line\nsecond line\n');
  const opened = [];
  const options = { settings: { mode: 'local' }, opener: 'gitferry', application: () => 'GitFerry', openExternal: async value => opened.push(new URL(value)) };
  const link = file.split('/').map(encodeURIComponent).join('/');
  await openFileLink(link + ':2:3', options); await openFileLink(link + ':2:3', options); await openFileLink(link, options);
  assert.equal(opened.length, 3);
  for (const url of opened) { assert.equal(url.hostname, 'open'); assert.equal(url.searchParams.get('file'), file); assert.equal([...url.searchParams.keys()].join(','), 'file,line,column'); }
  assert.equal(opened[0].searchParams.get('column'), '3'); assert.equal(opened[2].searchParams.get('line'), '1'); assert.equal(opened[2].searchParams.get('column'), '1');
  assert.equal(opened[0].href, opened[1].href);
  const remote = [];
  await openFileLink('/remote/文%20%23literal%2520%2B%26.ts:2:3', { ...options, settings: { mode: 'ssh', host: 'my-alias', port: 22 }, sshHost: async settings => settings.host, openExternal: async value => remote.push(new URL(value)) });
  assert.equal(remote[0].searchParams.get('file'), 'ssh://my-alias/remote/文 #literal%20+&.ts');
});

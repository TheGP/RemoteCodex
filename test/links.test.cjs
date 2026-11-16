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

test('diff-derived positions follow the current local file length after shortening without changing explicit links', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-diff-link-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'rewritten #file.ts');
  const link = file.split('/').map(encodeURIComponent).join('/') + '#L67';
  const opened = [];
  const options = { settings: { mode: 'local' }, opener: 'gitferry', clampLine: true, application: () => 'Editor', openExternal: async url => opened.push(new URL(url)) };
  fs.writeFileSync(file, Array.from({ length: 70 }, (_, index) => `line ${index + 1}`).join('\n'));
  await openFileLink(link, options); assert.equal(opened.at(-1).searchParams.get('line'), '67');
  for (const content of ['first\nsecond', 'first\r\nsecond', 'first\rsecond']) {
    fs.writeFileSync(file, content);
    await openFileLink(link, options);
    assert.equal(opened.at(-1).searchParams.get('file'), file);
    assert.equal(opened.at(-1).searchParams.get('line'), '2');
    assert.equal(opened.at(-1).searchParams.get('column'), '1');
  }
  await openFileLink(link, { ...options, clampLine: false }); assert.equal(opened.at(-1).searchParams.get('line'), '67');
  for (const opener of ['vscode', 'antigravity']) {
    await openFileLink(link, { ...options, opener });
    assert.ok(opened.at(-1).href.endsWith(':2:1'));
  }
  fs.writeFileSync(file, '');
  await openFileLink(link, options); assert.equal(opened.at(-1).searchParams.get('line'), '1');
});

test('remote diff positions read the remote file, preserve explicit positions and fail safely on read or machine errors', async () => {
  const opened = [], reads = [];
  const options = { settings: { mode: 'ssh', host: 'test-alias', port: 22 }, cwd: '/remote/project', opener: 'gitferry', clampLine: true, application: () => 'Editor', sshHost: async settings => settings.host, openExternal: async url => opened.push(new URL(url)), readFile: async file => { reads.push(file); return 'first\r\nsecond'; } };
  await openFileLink('rewritten.ts#L67', options);
  assert.deepEqual(reads, ['/remote/project/rewritten.ts']);
  assert.equal(opened[0].searchParams.get('file'), 'ssh://test-alias/remote/project/rewritten.ts');
  assert.equal(opened[0].searchParams.get('line'), '2');
  await openFileLink('rewritten.ts:67:3', { ...options, clampLine: false });
  assert.equal(reads.length, 1); assert.equal(opened[1].searchParams.get('line'), '67'); assert.equal(opened[1].searchParams.get('column'), '3');
  await openFileLink('rewritten.ts#L1', options); assert.equal(reads.length, 1);
  await openFileLink('rewritten.ts#L67', { ...options, readFile: async () => '' });
  assert.equal(opened.at(-1).searchParams.get('line'), '1');
  const before = opened.length;
  await assert.rejects(openFileLink('rewritten.ts#L67', { ...options, readFile: async () => { throw new Error('Remote file unavailable'); } }), /Remote file unavailable/);
  await assert.rejects(openFileLink('rewritten.ts#L67', { ...options, readFile: async () => null }), /Could not read/);
  let changed = false;
  await assert.rejects(openFileLink('rewritten.ts#L67', { ...options, readFile: async () => { changed = true; return 'new file'; }, current: () => { if (changed) throw new Error('Machine changed'); } }), /Machine changed/);
  assert.equal(opened.length, before);
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

test('mapped foreign file links retain positions and literal names for local editors and reveal', async t => {
  const { mapProjectPath } = require('../path-mapping.js');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-mapped-links-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const root = path.join(folder, 'Local 文 +% project'), name = 'name %20 #+&.ts';
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src', name); fs.writeFileSync(file, 'first\nsecond');
  const source = '/foreign/My 文 +% project', foreign = source + '/src/' + name;
  const value = foreign.split('/').map(encodeURIComponent).join('/') + '#L17C9';
  const opened = [], revealed = [], mapped = [];
  const options = { cwd: root, settings: { mode: 'local' }, application: () => 'Stub editor', openExternal: async url => opened.push(url), reveal: file => revealed.push(file), mapPath: file => { mapped.push(file); return mapProjectPath(file, { root, roots: [source] }); } };
  await openFileLink(value, options);
  assert.equal(opened[0], 'vscode://file' + file.split('/').map(encodeURIComponent).join('/') + ':17:9');
  await openFileLink(value, { ...options, opener: 'gitferry' });
  assert.deepEqual(Object.fromEntries(new URL(opened[1]).searchParams), { file, line: '17', column: '9' });
  await openFileLink(value, { ...options, opener: 'reveal' });
  assert.deepEqual(revealed, [file]); assert.deepEqual(mapped, [foreign, foreign, foreign]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond');
});

test('Windows peer file URLs map before local file checks and diff line clamping', async t => {
  const { mapProjectPath } = require('../path-mapping.js');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-mapped-windows-links-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, '文 #+%.ts'); fs.writeFileSync(file, 'first\r\nsecond');
  const opened = [], mapped = [];
  const value = 'file:///C:/Peer%20Project/' + encodeURIComponent(path.basename(file)) + '#L90C7';
  await openFileLink(value, { cwd: folder, settings: { mode: 'local' }, opener: 'gitferry', clampLine: true, application: () => 'Stub editor', openExternal: async url => opened.push(new URL(url)), mapPath: file => { mapped.push(file); return mapProjectPath(file, { root: folder, roots: ['c:\\peer project'] }); } });
  assert.deepEqual(mapped, ['C:\\Peer Project\\文 #+%.ts']);
  assert.deepEqual(Object.fromEntries(opened[0].searchParams), { file, line: '2', column: '1' });
});

test('file mapping cannot bypass link validation or open an editor after mapping fails', async () => {
  let mappings = 0, opened = 0;
  const options = { cwd: '/local/project', settings: { mode: 'local' }, application: () => 'Stub editor', openExternal: async () => { opened++; }, mapPath: () => { mappings++; throw new Error('Mapping unavailable'); } };
  for (const value of ['javascript:alert(1)', 'file://remote-host/path.ts', '/peer/file.ts%00']) await assert.rejects(openFileLink(value, options));
  assert.equal(mappings, 0); assert.equal(opened, 0);
  await assert.rejects(openFileLink('/peer/file.ts:8:2', options), /Mapping unavailable/);
  assert.equal(mappings, 1); assert.equal(opened, 0);
});

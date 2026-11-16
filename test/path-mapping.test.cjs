const test = require('node:test');
const assert = require('node:assert/strict');
const { mapProjectPath } = require('../path-mapping.js');

test('known peer project roots map to the chosen root with their relative file paths', () => {
  const mapping = { root: '/local/project', roots: ['/peer/project', '/another/checkout/'] };
  for (const [file, expected] of [
    ['/peer/project/src/example.ts', '/local/project/src/example.ts'],
    ['/peer/project', '/local/project'],
    ['/another/checkout/deep/folder/file.ts', '/local/project/deep/folder/file.ts'],
    ['/peer/project/src/../lib/./file.ts', '/local/project/lib/file.ts'],
    ['/peer//project///src/file.ts', '/local/project/src/file.ts'],
  ]) assert.equal(mapProjectPath(file, mapping), expected);
  assert.equal(mapProjectPath('/peer/project/vendor/file.ts', { root: '/local/project', roots: ['/peer/project', '/peer/project/vendor'] }), '/local/project/file.ts');
});

test('local paths, unrelated roots and prefix siblings remain unchanged', () => {
  const mapping = { root: '/local/project', roots: ['/peer/project', '/local'] };
  for (const file of ['/local/project/src/file.ts', '/local/project/./src/file.ts', '/elsewhere/file.ts', '/peer/project-sibling/file.ts', '/peer/projects/file.ts', '/Peer/project/file.ts', 'src/file.ts', 'file:///peer/project/file.ts', '//server/share/file.ts']) assert.equal(mapProjectPath(file, mapping), file);
  assert.equal(mapProjectPath('/local/project/vendor/file.ts', { root: '/local/project', roots: ['/local/project/vendor'] }), '/local/project/vendor/file.ts');
  for (const mapping of [undefined, null, {}, { root: '/local/project' }, { root: '', roots: ['/peer/project'] }, { root: 'relative', roots: ['/peer/project'] }]) assert.equal(mapProjectPath('/peer/project/file.ts', mapping), '/peer/project/file.ts');
  assert.equal(mapProjectPath(null, { root: '/local/project', roots: ['/peer/project'] }), null);
});

test('dot segments cannot carry a mapped suffix outside its project root', () => {
  const mapping = { root: '/local/project', roots: ['/peer/project'] };
  for (const file of ['/peer/project/../secret.ts', '/peer/project/src/../../secret.ts', '/peer/project/../../../secret.ts']) assert.equal(mapProjectPath(file, mapping), file);
  assert.equal(mapProjectPath('/peer/project/src/../safe.ts', mapping), '/local/project/safe.ts');
  assert.equal(mapProjectPath('C:\\Peer\\Project\\..\\secret.ts', { root: '/local/project', roots: ['C:\\Peer\\Project'] }), 'C:\\Peer\\Project\\..\\secret.ts');
  assert.equal(mapProjectPath('/peer/project/src/../safe.ts', { root: '/local/project/./nested/..', roots: ['/peer/project'] }), '/local/project/safe.ts');
});

test('Windows roots match drives and separators without case sensitivity across operating systems', () => {
  const posix = { root: '/local/project', roots: ['C:\\Peer\\Project'] };
  assert.equal(mapProjectPath('c:/peer/PROJECT/src/Example.ts', posix), '/local/project/src/Example.ts');
  assert.equal(mapProjectPath('C:\\Peer\\Project\\src\\Example.ts', posix), '/local/project/src/Example.ts');
  assert.equal(mapProjectPath('C:\\Peer\\Project-sibling\\Example.ts', posix), 'C:\\Peer\\Project-sibling\\Example.ts');
  assert.equal(mapProjectPath('D:\\Peer\\Project\\Example.ts', posix), 'D:\\Peer\\Project\\Example.ts');
  const windows = { root: 'D:\\Local Project', roots: ['/peer/project', 'C:/Peer/Project'] };
  assert.equal(mapProjectPath('/peer/project/src/Example.ts', windows), 'D:\\Local Project\\src\\Example.ts');
  assert.equal(mapProjectPath('c:\\peer\\project\\src\\Example.ts', windows), 'D:\\Local Project\\src\\Example.ts');
  assert.equal(mapProjectPath('d:/local project/src/Example.ts', windows), 'd:/local project/src/Example.ts');
  assert.equal(mapProjectPath('/peer/project/src/Example.ts', { root: 'D:/Local Project', roots: ['/peer/project'] }), 'D:/Local Project/src/Example.ts');
});

test('mapping preserves spaces, Unicode and literal percent, hash and plus characters without URL decoding', () => {
  const mapping = { root: '/local/My 文 + % project', roots: ['/peer/My 文 + % project'] };
  assert.equal(mapProjectPath('/peer/My 文 + % project/src/name %20 #+.ts', mapping), '/local/My 文 + % project/src/name %20 #+.ts');
  assert.equal(mapProjectPath('/peer/My 文 + % project/src/name %2F.ts', mapping), '/local/My 文 + % project/src/name %2F.ts');
  assert.equal(mapProjectPath('C:\\Peer 文 +%\\name #+.ts', { root: '/local/文 project', roots: ['c:\\peer 文 +%'] }), '/local/文 project/name #+.ts');
});

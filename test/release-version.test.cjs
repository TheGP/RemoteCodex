const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseVersion } = require('../scripts/release-version.cjs');

test('the first release starts at 0.1.0', () => {
  assert.deepEqual(releaseVersion([], [], '0.1.0'), { version: '0.1.0', tag: 'v0.1.0' });
});

test('releases increment only the patch number and sort it numerically', () => {
  assert.equal(releaseVersion(['v0.1.0'], [], '0.1.0').version, '0.1.1');
  assert.equal(releaseVersion(['v0.1.9', 'v0.1.2', 'v0.1.10'], [], '0.1.0').version, '0.1.11');
  assert.equal(releaseVersion(['v0.1.999'], [], '0.1.0').version, '0.1.1000');
});

test('rerunning the same commit reuses its release version', () => {
  assert.equal(releaseVersion(['v0.1.0', 'v0.1.1'], ['v0.1.0'], '0.1.0').version, '0.1.0');
});

test('unrelated versions, prereleases, and malformed tags do not change the release series', () => {
  const tags = ['v1.0.1', 'v0.2.9', 'v0.1.100-beta', 'v0.1.03', 'v0.1.-1', '0.1.90', 'other'];
  assert.equal(releaseVersion(tags, tags, '0.1.0').version, '0.1.0');
});

test('a deliberate base version increase is respected', () => {
  assert.equal(releaseVersion(['v0.1.1'], [], '0.1.5').version, '0.1.5');
  assert.equal(releaseVersion(['v0.1.99'], [], '0.2.0').version, '0.2.0');
});

test('invalid base versions and unsafe patch numbers fail instead of creating a bad tag', () => {
  for (const base of ['0.1', '0.1.0-beta', '01.1.0', 'bad']) assert.throws(() => releaseVersion([], [], base));
  assert.throws(() => releaseVersion(['v0.1.9007199254740992'], [], '0.1.0'));
  assert.throws(() => releaseVersion(['v0.1.9007199254740991'], [], '0.1.0'));
});

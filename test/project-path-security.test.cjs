const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { stateKey } = require('../sync-state.cjs');

const machine = 'access:local';
const identity = (project = 'project-a', device = 'device-a') => JSON.stringify([project, device]);
const operation = (value, extra = {}) => ({ kind: 'projectPath', machine, id: identity(), value, base: 0, opId: randomUUID(), ...extra });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-project-path-security-'));
  const first = new SharedScheduleDatabase(path.join(directory, 'first.sqlite'));
  const peer = new SharedScheduleDatabase(path.join(directory, 'first.sqlite'));
  const other = new SharedScheduleDatabase(path.join(directory, 'other.sqlite'));
  t.after(() => { first.close(); peer.close(); other.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const push = (database, owner, changes) => database.request('state-push', { operations: Array.isArray(changes) ? changes : [changes] }, owner).result;
  const get = (database, id = identity(), selectedMachine = machine) => database.state.get(stateKey('projectPath', selectedMachine, id));
  return { first, peer, other, push, get };
}

test('project folder records accept bounded absolute roots and preserve literal path characters', t => {
  const f = fixture(t);
  const roots = ['/srv/My Project/世界', 'C:\\Projects\\My Repo', 'D:/Projects/repo', "/srv/quote' $(literal)", '/' + 'a'.repeat(4095)];
  const saved = f.push(f.first, 'device-a', operation({ roots }))[0];
  assert.deepEqual(saved.current.value, { roots });
  assert.deepEqual(f.get(f.peer).value, { roots });
  const maximum = Array.from({ length: 100 }, (_, index) => '/srv/project-' + index);
  f.push(f.first, 'device-a', operation({ roots: maximum }));
  assert.deepEqual(f.get(f.first).value.roots, maximum);
});

test('project folder records reject invalid roots before changing saved state', t => {
  const f = fixture(t);
  f.push(f.first, 'device-a', operation({ roots: ['/srv/original'] }));
  const original = f.get(f.first);
  const invalid = [undefined, {}, [], { roots: [] }, { roots: 'not-an-array' }, { roots: ['/srv/valid', null] },
    { roots: Array(101).fill('/srv/project') }, { roots: ['/' + 'a'.repeat(4096)] }];
  for (const root of ['', 'relative/path', './project', '../project', '~/project', 'C:relative', 'file:///srv/project', '//server/share', '\\\\server\\share']) invalid.push({ roots: [root] });
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) invalid.push({ roots: ['/srv/project' + String.fromCharCode(code)] });
  for (const value of invalid) {
    assert.throws(() => f.push(f.first, 'device-a', operation(value)));
    assert.deepEqual(f.get(f.first), original);
  }
});

test('only the named device can publish or delete its project folder record', t => {
  const f = fixture(t);
  f.push(f.first, 'device-a', operation({ roots: ['/computer-a/project'] }));
  const original = f.get(f.first);
  for (const value of [{ roots: ['/computer-b/overwrite'] }, null]) {
    assert.throws(() => f.push(f.peer, 'device-b', operation(value)), /Only this computer/);
    assert.deepEqual(f.get(f.first), original);
  }
  const own = identity('project-a', 'device-b');
  f.push(f.peer, 'device-b', operation({ roots: ['/computer-b/project'] }, { id: own }));
  f.push(f.peer, 'device-b', operation(null, { id: own }));
  assert.equal(f.get(f.first, own).value, null);
  assert.deepEqual(f.get(f.first), original);
  f.push(f.first, 'device-a', operation(null));
  assert.equal(f.get(f.peer).value, null);
});

test('project folder identities require exactly a valid project and matching writer device', t => {
  const f = fixture(t);
  for (const id of ['not-json', 'null', '{}', '[]', '["project-a"]', '["project-a","device-a","extra"]', '[null,"device-a"]', '["","device-a"]', '["project-a",null]', identity('project-a', 'device-b'), identity('bad\nproject')]) {
    assert.throws(() => f.push(f.first, 'device-a', operation({ roots: ['/srv/project'] }, { id })));
  }
  assert.equal(f.first.request('state-pull', { cursor: 0 }, 'device-a').result.entries.length, 0);
});

test('project folders stay isolated by project, machine, device and storage namespace', t => {
  const f = fixture(t);
  const cases = [
    [f.first, 'device-a', identity(), machine, '/first/a'],
    [f.peer, 'device-b', identity('project-a', 'device-b'), machine, '/first/b'],
    [f.first, 'device-a', identity('project-b'), machine, '/first/other-project'],
    [f.first, 'device-a', identity(), 'access:other-host:22', '/first/other-machine'],
    [f.other, 'device-a', identity(), machine, '/other/a']
  ];
  for (const [database, owner, id, selectedMachine, root] of cases) f.push(database, owner, operation({ roots: [root] }, { id, machine: selectedMachine }));
  for (const [database, , id, selectedMachine, root] of cases) assert.deepEqual(f.get(database, id, selectedMachine).value.roots, [root]);
  f.push(f.peer, 'device-b', operation(null, { id: identity('project-a', 'device-b') }));
  assert.deepEqual(f.get(f.first).value.roots, ['/first/a']);
  assert.deepEqual(f.get(f.other).value.roots, ['/other/a']);
});

test('a foreign project folder delete rejects the entire batch without applying earlier changes', t => {
  const f = fixture(t), own = identity('project-a', 'device-b');
  f.push(f.first, 'device-a', operation({ roots: ['/computer-a/project'] }));
  assert.throws(() => f.push(f.peer, 'device-b', [operation({ roots: ['/computer-b/project'] }, { id: own }), operation(null)]), /Only this computer/);
  assert.equal(f.get(f.first, own), null);
  assert.deepEqual(f.get(f.first).value.roots, ['/computer-a/project']);
});

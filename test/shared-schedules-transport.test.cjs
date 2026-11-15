const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { ScheduleBridge, sharingOptions, serverKey, defaultFolder } = require('../shared-schedules.cjs');
const { spawnSync } = require('node:child_process');

test('storage folders normalize safely while the existing default keeps its server identity', () => {
  const existing = { host: 'root@warmer', port: 22 };
  assert.equal(sharingOptions(existing).folder, defaultFolder);
  assert.equal(serverKey(sharingOptions(existing)), serverKey(existing));
  assert.equal(sharingOptions({ folder: '/srv/sync/./data/../storage/' }).folder, '/srv/sync/storage');
  assert.notEqual(serverKey(sharingOptions({ folder: '/srv/another-folder' })), serverKey(sharingOptions()));
  for (const folder of ['', '/', '~/..', '~/folder/../../outside', 'relative/folder', '/srv/folder\ncommand', '/srv/\0file', 100]) assert.throws(() => sharingOptions({ folder }));
});

test('changing schedule storage during helper installation cannot connect the stale server or close its replacement', async t => {
  const children = [];
  const bridge = new ScheduleBridge('transport-test', (command, args) => {
    const child = new EventEmitter();
    child.command = command; child.args = args; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const installing = args.at(-1).startsWith('node -e');
    let buffer = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      if (!installing) {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
          setImmediate(() => child.stdout.write(JSON.stringify({ id: message.id, result: { protocol: 1 }, serverNow: Date.now() }) + '\n'));
        }
      }
      done();
    } });
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 1)); };
    child.stdin.on('finish', () => { if (installing && !args.includes('old-host')) setImmediate(() => child.emit('close', 0)); });
    children.push(child); return child;
  });
  t.after(() => bridge.close());
  const first = bridge.connect(sharingOptions({ host: 'old-host' })).then(() => null, error => error);
  assert.equal(children.length, 1);
  bridge.close();
  const folder = "/srv/Sync 'folder' $(printf EXPANDED)";
  await bridge.connect(sharingOptions({ host: 'new-host', key: '/keys/key with spaces', folder }));
  assert.ok(await first instanceof Error);
  assert.equal(children[0].killed, true);
  assert.equal(children.length, 3);
  assert.equal(bridge.child, children[2]);
  assert.ok(children[2].args.includes('new-host')); assert.ok(children[2].args.includes('/keys/key with spaces'));
  assert.ok(children[2].args.includes('StrictHostKeyChecking=yes'));
  const argument = children[2].args.at(-1).split('cjs"')[1].trim();
  const parsed = spawnSync('/bin/sh', ['-c', 'printf %s ' + argument], { encoding: 'utf8' });
  assert.equal(parsed.status, 0); assert.equal(parsed.stdout, folder + '/schedules.sqlite');
  children[0].emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.child, children[2]);
  assert.equal(children.filter(child => child.args.at(-1).startsWith('exec node')).length, 1);
  assert.equal((await bridge.call('hello')).protocol, 1);
});

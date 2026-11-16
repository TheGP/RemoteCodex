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

function transportFixture(t, respond = () => ({})) {
  const servers = [];
  const bridge = new ScheduleBridge('transfer-test', (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.blocks = []; child.requests = [];
    const installing = args.at(-1).startsWith('node -e');
    let buffer = '';
    child.reply = (request, result) => child.stdout.write(JSON.stringify({ id: request.id, result, serverNow: Date.now() }) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const deliver = () => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
          child.requests.push(request);
          const result = request.method === 'hello' ? { protocol: 1 } : respond(request, child);
          if (result !== undefined) setImmediate(() => child.reply(request, result));
        }
        done();
      };
      if (installing) done();
      else if (child.holdUploads && (buffer.includes('"method":"blob-put"') || chunk.includes('"method":"blob-put"'))) child.blocks.push(deliver);
      else deliver();
    } });
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 1)); };
    child.stdin.on('finish', () => { if (installing) setImmediate(() => child.emit('close', 0)); });
    if (!installing) servers.push(child);
    return child;
  });
  t.after(() => bridge.close());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const until = async condition => { for (let tries = 0; !condition(); tries++) { assert.ok(tries < 100, 'transport did not advance'); await flush(); } };
  return { bridge, servers, flush, until };
}

test('slow uploads progress beyond 20 seconds while control requests and queued transfers remain usable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = transportFixture(t, request => request.method === 'storage-info' ? { bytes: 42 } : {});
  await f.bridge.connect(sharingOptions());
  // Open the bulk connection before applying backpressure to its upload stream.
  await f.bridge.call('blob-get', { hash: 'warmup' });
  f.servers[1].holdUploads = true;
  let finished = false;
  const upload = f.bridge.call('blob-put', { data: 'a'.repeat(256 * 1024) }).then(() => { finished = true; });
  const queued = f.bridge.call('blob-get', { hash: 'next' });
  await f.until(() => f.servers[1].blocks.length);
  assert.equal(f.bridge.busy, true);
  for (let part = 0; !finished; part++) {
    assert.ok(part < 10);
    t.mock.timers.tick(15000);
    assert.equal((await f.bridge.call('storage-info')).bytes, 42);
    f.servers[1].blocks.shift()();
    await f.flush();
  }
  await upload; await queued;
  assert.equal(f.servers.length, 2);
  assert.equal(f.servers[0].requests.some(request => request.method.startsWith('blob-')), false);
  assert.deepEqual(f.servers[1].requests.map(request => request.method), ['hello', 'blob-get', 'blob-put', 'blob-get']);
  assert.equal(f.bridge.busy, false);
});

test('slow downloads renew their inactivity deadline and a stalled transfer leaves control connected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = transportFixture(t, request => request.method === 'blob-get' ? undefined : { bytes: 42 });
  await f.bridge.connect(sharingOptions());
  const download = f.bridge.call('blob-get', { hash: 'slow' });
  await f.until(() => f.servers[1]?.requests.some(request => request.method === 'blob-get'));
  const server = f.servers[1], request = server.requests.at(-1);
  const response = JSON.stringify({ id: request.id, result: { data: 'downloaded' }, serverNow: Date.now() }) + '\n';
  for (let offset = 0; offset < response.length; offset += 20) {
    t.mock.timers.tick(15000);
    server.stdout.write(response.slice(offset, offset + 20));
    assert.equal((await f.bridge.call('storage-info')).bytes, 42);
  }
  assert.deepEqual(await download, { data: 'downloaded' });
  const stalled = assert.rejects(f.bridge.call('blob-get', { hash: 'stalled' }), /timed out \(blob-get\)/);
  await f.until(() => server.requests.at(-1).params.hash === 'stalled');
  t.mock.timers.tick(20000);
  await stalled;
  assert.equal(server.killed, true);
  assert.equal(f.servers[0].killed, undefined);
  assert.equal((await f.bridge.call('storage-info')).bytes, 42);
  // A late response from the closed transfer must not affect a replacement.
  const recovered = f.bridge.call('blob-put', { data: 'retry' });
  await recovered;
  server.reply(request, { data: 'late' });
  assert.equal((await f.bridge.call('hello')).protocol, 1);
});

test('closing storage rejects active and queued transfers without opening a stale connection', async t => {
  const f = transportFixture(t, () => undefined);
  await f.bridge.connect(sharingOptions());
  const active = assert.rejects(f.bridge.call('blob-get'), /disconnected/);
  const queued = assert.rejects(f.bridge.call('blob-get'), /connection changed/);
  await f.until(() => f.servers[1]?.requests.some(request => request.method === 'blob-get'));
  f.bridge.close();
  await Promise.all([active, queued]);
  assert.equal(f.servers.length, 2);
  assert.ok(f.servers.every(server => server.killed));
  assert.equal(f.bridge.busy, false);
});

test('server upload progress keeps a flushed SSH pipe alive until the final acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = transportFixture(t, request => request.method === 'blob-put' ? undefined : {});
  await f.bridge.connect(sharingOptions());
  const upload = f.bridge.call('blob-put', { data: 'buffered inside SSH' });
  await f.until(() => f.servers[1]?.requests.some(request => request.method === 'blob-put'));
  const server = f.servers[1], request = server.requests.at(-1);
  for (let part = 0; part < 4; part++) {
    t.mock.timers.tick(15000);
    server.stdout.write('{"progress":true}\n');
    await f.bridge.call('storage-info');
  }
  server.reply(request, {});
  await upload;
  assert.equal(f.bridge.busy, false);
});

test('bulk connections preserve custom transport routing and the selected storage folder', async t => {
  const f = transportFixture(t), commands = [], spawn = f.bridge.spawn.bind(f.bridge);
  f.bridge.spawn = (options, command) => { commands.push(command); return spawn(options, command); };
  await f.bridge.connect(sharingOptions({ folder: '/srv/custom sync' }));
  await f.bridge.call('blob-get');
  const servers = commands.filter(command => command.startsWith('exec node'));
  assert.equal(servers.length, 2);
  assert.ok(servers.every(command => command.endsWith(" '/srv/custom sync/schedules.sqlite'")));
});

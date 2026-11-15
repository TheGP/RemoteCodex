// Uses real SSH/SQLite storage and fake native agents; never executes a real prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ScheduleStore } = require('../scheduler.cjs');
const { SharedSchedules, ScheduleBridge, sharingOptions } = require('../shared-schedules.cjs');

async function main() {
  const host = process.env.CODEX_TEST_HOST || 'root@warmer';
  const id = randomUUID();
  const name = `test-${id}.sqlite`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-shared-schedules-live-'));
  const clients = [], starts = [];
  const custom = new ScheduleBridge(`location-${id}`);
  let completed = false;
  try {
    for (const owner of ['first', 'second']) {
      const bridge = new ScheduleBridge(`live-${owner}-${id}`);
      const spawn = bridge.spawn.bind(bridge);
      bridge.spawn = (options, command) => spawn(options, command.startsWith('exec node --no-warnings') ? command + ` "$HOME/.local/share/remote-codex/schedule-sync/${name}"` : command);
      const connection = { ready: true, session: {}, async call(method) {
        if (method === 'turn/start') { starts.push(owner); return { turn: { id: 'fake-turn', status: 'inProgress' } }; }
        return { thread: { id, cwd: '/fake-shared-workspace', status: { type: 'idle' }, turns: completed ? [{ id: 'fake-turn', status: 'completed' }] : [] } };
      } };
      const store = new ScheduleStore(path.join(directory, owner + '-local.json'));
      const client = new SharedSchedules({ file: path.join(directory, owner + '.json'), store, bridge, connection, machine: () => 'access:local', blocked: () => false, dispatching: new Set(), available: () => true });
      clients.push(client);
      await client.configure({ enabled: true, host });
    }
    clients[0].store.add({ id, cwd: '/fake-shared-workspace' }, { prompt: 'Shared scheduling test; fake native agent only.', delay_seconds: 1 }, null, Date.now() - 5000);
    await clients[0].migrate();
    await Promise.all(clients.map(client => client.tick()));
    assert.equal(starts.length, 1);
    let tasks = await clients[0].bridge.call('list');
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'sent'); assert.equal(tasks[0].active, true);
    // A second message cannot pass the first run while its native turn is active.
    clients[1].store.add({ id, cwd: '/fake-shared-workspace' }, { prompt: 'Second fake scheduled task.', delay_seconds: 1 }, null, Date.now() - 5000);
    await Promise.all(clients.map(client => client.tick()));
    assert.equal(starts.length, 1);
    completed = true;
    const sending = clients.find(client => client.state.receipts.length);
    await sending.flushReceipts();
    tasks = await clients[0].bridge.call('list');
    assert.equal(tasks.find(task => task.status === 'sent').active, false);
    // Clean up our remaining pending fake task before removing the isolated database.
    await clients[0].bridge.call('cancel', { id: tasks.find(task => task.status === 'pending').id });
    await custom.connect(sharingOptions({ host, folder: `~/.local/share/remote-codex/schedule-sync/location-${id} space` }));
    const info = await custom.call('storage-info');
    assert.ok(info.directory.endsWith(`/location-${id} space`));
    assert.ok(info.directory.startsWith('/')); assert.ok(info.bytes > 0); assert.equal(info.complete, true);
    console.log('PASS real Warmer SSH: two clients send once, retain active-turn ownership, and release on verified completion.');
    console.log('PASS custom server folder with spaces resolves correctly and reports its folder size.');
  } finally {
    custom.close();
    for (const client of clients) client.close();
    const cleanup = `const fs=require("node:fs"),os=require("node:os"),path=require("node:path");const base=path.join(os.homedir(),".local/share/remote-codex/schedule-sync");for(const file of [path.join(base,"${name}"),path.join(base,"location-${id} space/schedules.sqlite")])for(const suffix of ["","-wal","-shm"]){try{fs.unlinkSync(file+suffix)}catch(e){if(e.code!=="ENOENT")throw e}}try{fs.rmdirSync(path.join(base,"location-${id} space"))}catch(e){if(e.code!=="ENOENT")throw e}`;
    execFileSync('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', host, "node -e '" + cleanup + "'"], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

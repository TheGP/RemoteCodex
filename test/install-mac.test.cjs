const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMac } = require('../scripts/install-mac.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Applications'); fs.mkdirSync(directory);
  const installed = path.join(directory, 'Remote Codex.app');
  const source = path.join(root, 'build/Remote Codex.app');
  const archive = app => path.join(app, 'Contents/Resources/app.asar');
  const app = (folder, content) => {
    fs.mkdirSync(path.dirname(archive(folder)), { recursive: true });
    fs.mkdirSync(path.join(folder, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(archive(folder), content); fs.writeFileSync(path.join(folder, 'Contents/MacOS/Remote Codex'), 'executable');
    return folder;
  };
  app(installed, 'old'); app(source, 'new');
  const run = (command, args) => {
    if (command.endsWith('/ditto') && args[0] === '-c') fs.writeFileSync(args.at(-1), 'zip:' + fs.readFileSync(archive(args.at(-2)), 'utf8'));
    else if (command.endsWith('/ditto')) fs.cpSync(args[0], args[1], { recursive: true });
    else if (command.endsWith('/unzip')) { if (!fs.readFileSync(args[1], 'utf8').startsWith('zip:')) throw new Error('Invalid ZIP'); }
    else if (command.endsWith('/lsof')) return '';
    else throw new Error('Unexpected command');
  };
  return { root, directory, installed, source, archive, app, run, rollback: path.join(directory, '.Remote-Codex-rollback.zip') };
}

test('installs retain one compressed rollback and protect running or unrelated folders', t => {
  const f = fixture(t);
  const obsolete = f.app(path.join(f.directory, '.Remote-Codex-before-test-100'), 'old backup');
  const running = f.app(path.join(f.directory, '.Remote-Codex-before-running-200'), 'running');
  const unrelated = f.app(path.join(f.directory, '.Remote-Codex-before-personal'), 'leave alone');
  const run = (command, args, options) => command.endsWith('/lsof') ? 'n' + f.archive(running) + '\n' : f.run(command, args, options);
  const result = installMac(f.source, f.installed, run);
  assert.equal(fs.readFileSync(f.archive(f.installed), 'utf8'), 'new');
  assert.equal(fs.readFileSync(f.rollback, 'utf8'), 'zip:old');
  assert.ok(!fs.existsSync(obsolete)); assert.ok(fs.existsSync(running)); assert.ok(fs.existsSync(unrelated));
  assert.deepEqual(result.retained, [path.basename(running)]);
  fs.writeFileSync(f.archive(f.source), 'newer'); installMac(f.source, f.installed, f.run);
  assert.equal(fs.readFileSync(f.rollback, 'utf8'), 'zip:new');
  assert.ok(!fs.existsSync(running));
  assert.equal(fs.readdirSync(f.directory).filter(name => name.endsWith('.zip')).length, 1);
  assert.ok(!fs.readdirSync(f.directory).some(name => name.startsWith('.Remote-Codex-update-')));
});

test('archive failures leave the installed app and existing backups intact', t => {
  const f = fixture(t); const backup = f.app(path.join(f.directory, '.Remote-Codex-before-test-100'), 'backup');
  const run = (command, args) => { if (args[0] === '-c') throw new Error('Disk full'); return f.run(command, args); };
  assert.throws(() => installMac(f.source, f.installed, run), /Disk full/);
  assert.equal(fs.readFileSync(f.archive(f.installed), 'utf8'), 'old'); assert.ok(fs.existsSync(backup));
  assert.ok(!fs.existsSync(f.rollback));
  assert.ok(!fs.readdirSync(f.directory).some(name => name.includes('update-') || name.endsWith('.lock')));
});

test('post-swap verification failure restores the old app', t => {
  const f = fixture(t);
  const run = (command, args) => {
    const result = f.run(command, args);
    if (command.endsWith('/unzip')) {
      const staged = fs.readdirSync(f.directory).find(name => name.startsWith('.Remote-Codex-update-'));
      fs.writeFileSync(f.archive(path.join(f.directory, staged)), 'corrupt');
    }
    return result;
  };
  assert.throws(() => installMac(f.source, f.installed, run), /verification failed/);
  assert.equal(fs.readFileSync(f.archive(f.installed), 'utf8'), 'old');
  assert.equal(fs.readFileSync(f.rollback, 'utf8'), 'zip:old');
});

test('cleanup validates the rollback before deleting and rejects concurrent installation', t => {
  const f = fixture(t); const backup = f.app(path.join(f.directory, '.Remote-Codex-before-test-100'), 'backup');
  fs.writeFileSync(f.rollback, 'invalid');
  assert.throws(() => installMac(null, f.installed, f.run), /Invalid ZIP/); assert.ok(fs.existsSync(backup));
  fs.unlinkSync(f.rollback); installMac(null, f.installed, f.run);
  assert.equal(fs.readFileSync(f.rollback, 'utf8'), 'zip:old'); assert.ok(!fs.existsSync(backup));
  const lock = path.join(f.directory, '.Remote-Codex-install.lock'); fs.mkdirSync(lock);
  assert.throws(() => installMac(f.source, f.installed, f.run), /Another install/); assert.ok(fs.existsSync(lock));
});

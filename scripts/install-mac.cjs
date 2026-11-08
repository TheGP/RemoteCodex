const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function appArchive(app) {
  if (!fs.lstatSync(app).isDirectory()) throw new Error('Expected an application directory.');
  const archive = path.join(app, 'Contents/Resources/app.asar');
  fs.accessSync(archive);
  fs.accessSync(path.join(app, 'Contents/MacOS/Remote Codex'));
  return archive;
}

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function archiveApp(app, destination, run = execFileSync) {
  appArchive(app);
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, temporary]);
    run('/usr/bin/unzip', ['-tqq', temporary]);
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function openAppFiles(run = execFileSync) {
  try {
    return run('/usr/sbin/lsof', ['-nP', '-c', 'Remote Codex', '-Fn'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      .split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
  } catch (error) {
    if (error.status === 1 && !String(error.stderr || '').trim()) return [];
    throw error;
  }
}

function pruneBackups(directory, openFiles) {
  const removed = [], retained = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^\.Remote-Codex-before-[\w-]+-\d+(?:\.app)?$/.test(name)) continue;
    const folder = path.join(directory, name);
    if (!fs.lstatSync(folder).isDirectory()) continue;
    try { appArchive(folder); } catch { continue; }
    if (openFiles.some(file => file === folder || file.startsWith(folder + path.sep))) { retained.push(name); continue; }
    fs.rmSync(folder, { recursive: true }); removed.push(name);
  }
  return { removed, retained };
}

function updateMac(source, installed, run) {
  const directory = path.dirname(installed);
  const rollback = path.join(directory, '.Remote-Codex-rollback.zip');
  if (!source) {
    if (!fs.existsSync(rollback)) archiveApp(installed, rollback, run);
    else run('/usr/bin/unzip', ['-tqq', rollback]);
    return pruneBackups(directory, openAppFiles(run));
  }
  const expected = hash(appArchive(source));
  fs.mkdirSync(directory, { recursive: true });
  const staged = path.join(directory, `.Remote-Codex-update-${randomUUID()}.app`);
  const previous = path.join(directory, `.Remote-Codex-before-install-${Date.now()}`);
  try {
    run('/usr/bin/ditto', [source, staged]);
    if (hash(appArchive(staged)) !== expected) throw new Error('Staged application verification failed.');
    const exists = fs.existsSync(installed);
    if (exists) { archiveApp(installed, rollback, run); fs.renameSync(installed, previous); }
    try {
      fs.renameSync(staged, installed);
      if (hash(appArchive(installed)) !== expected) throw new Error('Installed application verification failed.');
    } catch (error) {
      if (fs.existsSync(installed)) fs.renameSync(installed, staged);
      if (exists) fs.renameSync(previous, installed);
      throw error;
    }
    return pruneBackups(directory, openAppFiles(run));
  } finally { fs.rmSync(staged, { recursive: true, force: true }); }
}

function installMac(source, installed, run = execFileSync) {
  const directory = path.dirname(installed);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, '.Remote-Codex-install.lock');
  try { fs.mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another install or cleanup holds .Remote-Codex-install.lock.'); throw error; }
  try { return updateMac(source, installed, run); }
  finally { fs.rmdirSync(lock); }
}

module.exports = { archiveApp, openAppFiles, pruneBackups, installMac };
if (require.main === module) {
  try {
    if (process.platform !== 'darwin') throw new Error('This installer requires macOS.');
    const source = process.argv[2] === '--cleanup' ? null : path.resolve(process.argv[2] || path.join(__dirname, '../dist/Remote Codex-darwin-x64/Remote Codex.app'));
    const result = installMac(source, path.join(os.homedir(), 'Applications/Remote Codex.app'));
    console.log(`${source ? 'Installed app; ' : ''}removed ${result.removed.length} old backups. One compressed rollback retained.`);
    if (result.retained.length) console.log(`Kept ${result.retained.length} backup(s) used by a running app; rerun npm run cleanup:mac after restarting.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

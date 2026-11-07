const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);

async function openWebLink(value, openExternal) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid link.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Use a complete HTTP or HTTPS link.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can open in the browser.');
  await openExternal(url.href);
}

function parseFileLink(value, cwd) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid file link.');
  let file = value.trim(); let fragment = '';
  if (/^file:/i.test(file)) {
    const url = new URL(file);
    if (url.hostname || url.username || url.password || url.search) throw new Error('Use a file path on the conversation’s machine.');
    file = url.pathname.replace(/^\/([a-z]:[\\/])/i, '$1'); fragment = url.hash;
  } else {
    if (/^[\\/]{2}/.test(file) || file.startsWith('#') || file.includes('?')) throw new Error('Unsupported file link.');
    const hash = file.indexOf('#');
    if (hash >= 0) { fragment = file.slice(hash); file = file.slice(0, hash); }
  }
  file = decodeURIComponent(file);
  if (!file || /[\u0000-\u001f\u007f]/.test(file) || /^[\\/]{2}/.test(file)) throw new Error('Invalid file path.');
  const suffix = file.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const anchor = fragment && fragment.match(/^#L?(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i);
  if (fragment && !anchor) throw new Error('Unsupported file line reference.');
  if (suffix) file = suffix[1];
  if (/^[a-z][a-z\d+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) throw new Error('Unsupported file link.');
  const line = anchor ? Number(anchor[1]) : suffix ? Number(suffix[2]) : null;
  const column = anchor?.[2] ? Number(anchor[2]) : suffix?.[3] ? Number(suffix[3]) : null;
  if ([line, column].some(value => value !== null && (!Number.isSafeInteger(value) || value < 1))) throw new Error('Invalid file line or column.');
  const paths = /^[a-z]:[\\/]/i.test(file) || /^[a-z]:[\\/]/i.test(cwd || '') ? path.win32 : path.posix;
  if (!paths.isAbsolute(file) && (typeof cwd !== 'string' || !paths.isAbsolute(cwd))) throw new Error('Open a conversation to resolve relative file links.');
  return { file: paths.isAbsolute(file) ? paths.normalize(file) : paths.resolve(cwd, file), line, column };
}

async function editorSshHost(settings, run = execute) {
  const { stdout } = await run(process.platform === 'win32' ? 'ssh.exe' : '/usr/bin/ssh', ['-G', settings.host], { timeout: 5000, windowsHide: true });
  const port = Number(stdout.match(/^port (\d+)\s*$/m)?.[1]);
  if (port !== settings.port) throw new Error(`Configure an SSH host alias with Port ${settings.port} in your SSH config and use that alias as the app’s SSH host before opening remote files.`);
  return settings.host;
}

async function openFileLink(value, { cwd, settings, opener = 'vscode', openExternal, reveal, application, sshHost = editorSshHost, current = () => {} }) {
  const target = parseFileLink(value, cwd);
  const local = settings.mode === 'local';
  if (!['vscode', 'antigravity', 'gitferry', 'reveal'].includes(opener)) throw new Error('Choose a file opener in Settings.');
  if (local && !(await fs.stat(target.file)).isFile()) throw new Error('This link does not point to a file.');
  current();
  if (opener === 'reveal') {
    if (!local) throw new Error('Choose VS Code or GitFerry to open files on an SSH machine.');
    return reveal(target.file);
  }
  if (!local && opener === 'antigravity') throw new Error('Choose VS Code or GitFerry to open files on an SSH machine.');
  const host = local ? null : await sshHost(settings);
  let url;
  if (opener === 'gitferry') {
    const query = new URLSearchParams({ file: local ? target.file : `ssh://${host}${target.file}`, line: String(target.line || 1), column: String(target.column || 1) });
    url = `gitferry://open?${query}`;
  } else {
    const scheme = opener === 'vscode' ? 'vscode' : 'antigravity-ide';
    const file = target.file.replace(/\\/g, '/');
    const encoded = (file.startsWith('/') ? file : '/' + file).split('/').map(part => encodeURIComponent(part)).join('/');
    const position = target.line ? `:${target.line}:${target.column || 1}` : '';
    url = local ? `${scheme}://file${encoded}${position}` : `vscode://vscode-remote/ssh-remote+${encodeURIComponent(host)}${encoded}${position}`;
  }
  const name = { vscode: 'VS Code', antigravity: 'Antigravity IDE', gitferry: 'GitFerry' }[opener];
  if (!application(url)) throw new Error(`Install ${name} to open file links, or choose another opener in Settings.`);
  current();
  await openExternal(url);
}

module.exports = { openWebLink, parseFileLink, editorSshHost, openFileLink };

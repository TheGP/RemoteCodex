const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { DraftStore, registerDraftIpc } = require('../drafts.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-drafts-desktop-'));
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const store = new DraftStore(path.join(directory, 'drafts'));
  const index = path.resolve(__dirname, '..', 'index.html'); const page = pathToFileURL(index).href;
  const thread = { id: 'desktop-draft-chat', cwd: directory, name: 'Draft conversation', historyMode: 'paginated', status: { type: 'idle' } };
  const calls = []; let window, finishSend;
  registerDraftIpc(ipcMain, store, event => { if (event.sender !== window?.webContents || event.senderFrame?.url !== page) throw new Error('Untrusted draft caller'); });
  ipcMain.handle('settings', () => ({ mode: 'local', localCwd: directory, host: 'unused', cwd: directory, port: 22, key: '', codexPath: '' }));
  ipcMain.handle('preferences', () => ({ theme: 'system', startupProjects: {}, conversationStates: {}, threadOrders: {} }));
  for (const name of ['queues', 'pins', 'scheduled-tasks']) ipcMain.handle(name, () => []);
  ipcMain.handle('connect', () => ({}));
  ipcMain.on('save-conversation-state', event => { event.returnValue = { ok: true }; });
  ipcMain.on('diagnostic', () => {});
  ipcMain.handle('rpc', (_event, method, params) => {
    calls.push(method);
    if (method === 'model/list') return { data: [{ model: 'draft-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
    if (method === 'thread/read' || method === 'thread/resume') return { thread };
    if (method === 'turn/start') return new Promise(resolve => { finishSend = resolve; });
    if (method === 'thread/list') return { data: [thread], nextCursor: null };
    if (method === 'thread/turns/list') return { data: [{ id: 'desktop-edit-turn', status: 'completed', items: [{ id: 'desktop-edit-prompt', type: 'userMessage', content: [{ type: 'text', text: 'Original message' }] }] }], nextCursor: null };
    if (method === 'account/rateLimits/read') return { rateLimits: null };
    return { data: [], nextCursor: null };
  });
  const evaluate = script => window.webContents.executeJavaScript(script);
  const open = async () => {
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '..', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadFile(index);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('state.connected && !state.connecting && !state.loading')) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Draft UI did not initialize: ' + await evaluate("document.getElementById('error-text').textContent"));
  };
  const close = async () => { const closing = window; await new Promise(resolve => { closing.once('closed', resolve); closing.close(); }); window = null; };
  try {
    await open();
    await evaluate("document.getElementById('prompt').value = '  Unsent before restart\\n'; document.getElementById('prompt').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('send-time').value = '24'; document.getElementById('send-time').dispatchEvent(new Event('change', { bubbles: true }));");
    assert.equal(new DraftStore(store.directory).last('access:local').draft.text, '  Unsent before restart\n');
    await evaluate("document.getElementById('prompt').value += 'last change before close';");
    await close();
    assert.equal(new DraftStore(store.directory).last('access:local').draft.text, '  Unsent before restart\nlast change before close');
    await open();
    assert.equal(await evaluate("document.getElementById('prompt').value"), '  Unsent before restart\nlast change before close');
    assert.equal(await evaluate("document.getElementById('send-time').value"), '24');
    console.log('PASS real Electron preload saves input synchronously and before closing; reopening restores a new-chat draft and its send time');
    await evaluate(`openThread(${JSON.stringify(thread)})`);
    await evaluate("document.getElementById('prompt').value = 'Conversation draft'; document.getElementById('prompt').dispatchEvent(new Event('input', { bubbles: true }));");
    await close(); await open();
    assert.equal(await evaluate('state.thread.id'), thread.id);
    assert.equal(await evaluate("document.getElementById('prompt').value"), 'Conversation draft');
    await evaluate("document.querySelector('.edit-message').click(); document.getElementById('edited-message').value = 'Unfinished history edit'; document.getElementById('edited-message').dispatchEvent(new Event('input', { bubbles: true }));");
    await close(); await open();
    assert.equal(await evaluate("document.getElementById('edit-message-dialog').open"), true);
    assert.equal(await evaluate("document.getElementById('edited-message').value"), 'Unfinished history edit');
    assert.equal(await evaluate("document.getElementById('prompt').value"), 'Conversation draft');
    assert.ok(!calls.some(method => ['turn/start', 'turn/steer', 'thread/resume', 'thread/revert'].includes(method)));
    console.log('PASS real renderer restart restores the same conversation, composer and open editor independently without sending or rewriting history');
    await evaluate("document.getElementById('cancel-message-edit').click(); document.getElementById('prompt').value = 'Keep until send is acknowledged'; document.getElementById('send-time').value = '0'; document.getElementById('prompt').dispatchEvent(new Event('input', { bubbles: true })); send(); undefined;");
    for (let attempt = 0; attempt < 100 && !finishSend; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(finishSend);
    await close();
    assert.equal(new DraftStore(store.directory).last('access:local').draft.text, 'Keep until send is acknowledged');
    finishSend({ turn: { id: 'unconfirmed-test-turn', status: 'inProgress' } });
    await open();
    assert.equal(await evaluate("document.getElementById('prompt').value"), 'Keep until send is acknowledged');
    assert.equal(calls.filter(method => method === 'turn/start').length, 1);
    console.log('PASS closing during an unconfirmed send preserves its prompt without automatically retrying it');
    await close(); fs.rmSync(directory, { recursive: true, force: true }); app.exit(0);
  } catch (error) { console.error(error); if (window) window.destroy(); fs.rmSync(directory, { recursive: true, force: true }); app.exit(1); }
});

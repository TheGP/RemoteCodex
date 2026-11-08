/* global marked, DOMPurify */
const controls = new Map([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
const $ = id => controls.get(id);
const api = window.codex;
const projects = { data: [], selected: null, expanded: new Set(), cursors: new Map(), collapsed: new Set(), generation: 0 };
const preferences = { theme: 'system', startupProjects: {}, conversationStates: {}, threadOrders: {}, threadOrderCutoffs: {} };
const imageLoads = new Map();
const linkContexts = new WeakMap();
const completionSound = { audio: null, lastAt: -Infinity };
const schedules = { tasks: [], generation: 0 };
const drafts = { target: null, snapshot: null, images: [], suspended: false, restoring: false };
for (let hours = 1; hours < 24; hours++) $('send-time').add(new Option(`${hours} hour${hours === 1 ? '' : 's'}`, String(hours)));
for (let days = 1; days <= 7; days++) $('send-time').add(new Option(`${days} day${days === 1 ? '' : 's'}`, String(days * 24)));
const threadDrag = { source: null, pending: new Set(), orderPending: new Set(), type: 'application/x-remote-codex-thread' };
const projectDrag = { source: null, pending: null, type: 'application/x-remote-codex-project' };
const queueDrag = { source: null, type: 'application/x-remote-codex-queue' };
const usage = { threads: new Map(), account: null, reading: null, generation: 0, updatedAt: 0, error: null, timer: null };
const state = { owned: new Set(), resuming: new Map(), writerConflicts: new Set(), completions: new Map(), unread: new Set(), queues: new Map(), dispatching: new Set(), finished: new Set(), names: new Map(), titling: new Set(), newThreads: new Set(), titleTask: Promise.resolve(), titleFailed: false, images: [], connected: false, connecting: false, threads: [], pinnedIds: new Set(), pinnedThreads: new Map(), pinning: new Set(), thread: null, threadCursor: null, turnCursor: null, active: new Map(), items: new Map(), requests: new Map(), requestCards: new Map(), models: [], loading: false, sending: false, selection: 0, historyEvents: null, listGeneration: 0, folderPath: null, folderGeneration: 0 };
const slash = { index: 0, matches: [], dismissed: null, skills: [], cwd: null, loading: false, generation: 0, skillOnly: false };
const modes = { plan: false, catalog: [], threads: new Map() };
const slashCommands = [
  { name: 'new', description: 'Start a new conversation' },
  { name: 'model', description: 'Choose a model' },
  { name: 'reasoning', description: 'Choose reasoning effort' },
  { name: 'permissions', description: 'Change access and approvals' },
  { name: 'plan', description: 'Toggle Plan mode' },
  { name: 'review', description: 'Review uncommitted changes' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'skills', description: 'Browse installed skills' },
  { name: 'init', description: 'Create project instructions in AGENTS.md' },
  { name: 'project', description: 'Choose a project folder' },
  { name: 'rename', description: 'Rename this conversation' },
  { name: 'status', description: 'Show conversation settings' },
  { name: 'mcp', description: 'Show MCP servers and tools' }
];

const rpc = (method, params = {}) => api.rpc(method, params);
function trace(event, details) { try { api.log?.(event, details); } catch {} }
function composerTarget() { return { machine: accessKey(), kind: 'composer', threadId: state.thread?.id || null, cwd: state.thread?.cwd || $('workspace').value.trim(), projectId: state.thread?.projectId || projects.selected || null }; }
function composerSnapshot() { return { text: $('prompt').value, hours: Number($('send-time').value), model: $('model').value, effort: $('effort').value, mode: modes.plan ? 'plan' : 'default', access: $('permissions').value }; }
function saveComposerDraft() {
  if (!api.saveDraft || !drafts.target || drafts.suspended || drafts.restoring || state.sending || state.loading) return false;
  const snapshot = composerSnapshot(); const images = state.images.filter(image => image.url);
  const changedImages = images.length !== drafts.images.length || images.some((image, index) => image !== drafts.images[index]?.image || image.url !== drafts.images[index]?.url);
  if (!changedImages && drafts.snapshot && Object.keys(snapshot).every(key => snapshot[key] === drafts.snapshot[key])) return true;
  try {
    api.saveDraft(drafts.target, { ...snapshot, ...(changedImages ? { images } : {}) });
    drafts.snapshot = snapshot; drafts.images = images.map(image => ({ image, url: image.url }));
    return true;
  } catch (error) { trace('draft.save.failed', { threadId: drafts.target.threadId, error: error.message }); showError(`Could not save unsent draft: ${error.message}`); return false; }
}
function clearDraft(target) {
  if (!api.clearDraft || !target) return;
  try { api.clearDraft(target); } catch (error) { showError(`Could not clear saved draft: ${error.message}`); }
}
function editorTarget(kind, thread, itemId) { return { machine: accessKey(), kind, threadId: thread.id, cwd: thread.cwd, projectId: thread.projectId || null, itemId }; }
function editorText(target, text) {
  try { return api.draft?.(target)?.text ?? text; } catch (error) { showError(`Could not restore editor draft: ${error.message}`); return text; }
}
function saveEditorDraft(target, text) {
  if (!target || !api.saveDraft) return;
  try { api.saveDraft(target, { text }); } catch (error) { showError(`Could not save editor draft: ${error.message}`); }
}
function activateComposerDraft() {
  if (!api.draft || drafts.suspended || drafts.target) return;
  const target = composerTarget(); drafts.restoring = true;
  try {
    const saved = api.draft(target);
    drafts.target = target;
    if (saved) {
      $('prompt').value = saved.text; state.images = saved.images; $('send-time').value = String(saved.hours ?? 0);
      if ([...$('model').options].some(option => option.value === saved.model)) $('model').value = saved.model;
      updateEfforts(saved.effort);
      if (['read-only', 'workspace-write', 'danger-full-access'].includes(saved.access)) $('permissions').value = saved.access;
      modes.plan = saved.mode === 'plan'; if (state.thread) modes.threads.set(state.thread.id, modes.plan);
    } else { $('prompt').value = ''; state.images = []; $('send-time').value = '0'; }
    renderImages(); drafts.snapshot = composerSnapshot(); drafts.images = state.images.map(image => ({ image, url: image.url }));
  } catch (error) { showError(`Could not restore unsent draft: ${error.message}`); }
  finally { drafts.restoring = false; }
}
function changeDraftWorkspace() {
  if (state.thread || drafts.suspended) return;
  saveComposerDraft(); drafts.target = null; activateComposerDraft(); updateBusy();
}
async function restoreLastDraft() {
  if (!api.lastDraft) return;
  const options = state.options; const saved = api.lastDraft(accessKey());
  if (saved?.target.threadId) {
    const result = await rpc('thread/read', { threadId: saved.target.threadId, includeTurns: false });
    if (state.options !== options) return;
    await openThread(result.thread);
    if (saved.target.kind === 'edit-message') {
      const find = () => [...state.items.values()].find(record => record.turnId === saved.target.itemId && record.item.type === 'userMessage');
      while (!find() && state.turnCursor) { const cursor = state.turnCursor; await $('older-turns').onclick(); if (cursor === state.turnCursor || state.options !== options) break; }
      if (find() && !state.active.has(result.thread.id)) openMessageEdit(find());
      else if (!$('prompt').value) { $('prompt').value = saved.draft.text; saveComposerDraft(); }
    } else if (saved.target.kind === 'edit-queue') {
      const queue = state.queues.get(queueKey(result.thread.id)); const message = queue?.messages.find(message => message.draftId === saved.target.itemId);
      if (message) editQueuedMessage(queue, message);
      else if (!$('prompt').value) { $('prompt').value = saved.draft.text; saveComposerDraft(); }
    }
  } else {
    if (saved) projects.selected = saved.target.projectId;
    resetThread(saved?.target.cwd);
  }
}
const titleOf = thread => state.names.get(thread.id) || thread.name || thread.preview?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'New conversation';
const isLocal = () => state.options?.mode === 'local';
const connectedStatus = () => isLocal() ? 'Connected locally' : 'Connected via SSH';

function applyTheme(value) {
  const theme = [...$('theme-select').options].some(option => option.value === value) ? value : 'system';
  document.documentElement.dataset.theme = theme; $('theme-select').value = theme;
}
async function savePreferences(patch) {
  const markers = preferences.conversationStates;
  const orders = preferences.threadOrders;
  const cutoffs = preferences.threadOrderCutoffs;
  Object.assign(preferences, await api.savePreferences(patch));
  preferences.conversationStates = markers;
  preferences.threadOrders = orders;
  preferences.threadOrderCutoffs = cutoffs;
}
$('theme-select').onchange = async () => {
  const theme = $('theme-select').value; const previous = document.documentElement.dataset.theme || 'system';
  applyTheme(theme);
  try { await savePreferences({ theme }); }
  catch (error) { if (document.documentElement.dataset.theme === theme) applyTheme(previous); showError(error); }
};
$('file-opener').onchange = async () => {
  const control = $('file-opener'); const previous = preferences.fileOpener || 'vscode';
  control.disabled = true;
  try { await savePreferences({ fileOpener: control.value }); }
  catch (error) { control.value = previous; showError(error); }
  finally { control.disabled = false; }
};
function playCompletionSound(preview = false) {
  if (!preview && (preferences.completionSound === false || performance.now() - completionSound.lastAt < 3000)) return;
  try {
    completionSound.audio ||= new Audio('assets/completion.wav');
    const audio = completionSound.audio; audio.volume = 0.35; audio.pause(); audio.currentTime = 0;
    completionSound.lastAt = performance.now();
    return audio.play().catch(error => api.log?.('completion-sound.failed', { error: error.message }));
  } catch (error) { api.log?.('completion-sound.failed', { error: error.message }); }
}
$('completion-sound').onchange = async () => {
  const control = $('completion-sound'); const previous = preferences.completionSound !== false;
  control.disabled = true;
  try { await savePreferences({ completionSound: control.checked }); if (!control.checked) completionSound.audio?.pause(); }
  catch (error) { control.checked = previous; showError(error); }
  finally { control.disabled = false; }
};
$('preview-completion-sound').onclick = () => playCompletionSound(true);

function connectionLabels() {
  const local = isLocal();
  $('server-host').textContent = local ? 'This machine' : state.options.host;
  $('machine-badge').textContent = local ? 'LOCAL' : 'REMOTE';
  $('welcome-eyebrow').textContent = local ? 'CODEX ON YOUR MACHINE' : 'A LOCAL WINDOW TO YOUR SERVER';
  $('welcome-description').textContent = local ? 'Talk to Codex here. Your code and commands run on this machine.' : 'Talk to Codex here. Your code and commands run on your remote machine.';
  $('workspace-label').textContent = local ? 'Local workspace' : 'Server workspace';
  $('workspace').setAttribute('aria-label', $('workspace-label').textContent);
  $('transport-note').textContent = local ? 'Local connection · Codex runs on this machine' : 'Encrypted SSH connection · Codex runs remotely';
  $('permissions').querySelector('[value="danger-full-access"]').textContent = local ? 'Full local access' : 'Full server access';
  $('permissions').title = 'Full access runs commands without approval prompts.';
  $('folder-title').textContent = local ? 'Choose a local folder' : 'Choose a server folder';
  $('folder-description').textContent = local ? 'Choose where Codex should work on this machine. Any folder can be a project.' : 'Choose where Codex should work on the server. Any folder can be a project.';
  $('folder-label').textContent = local ? 'Local folder path' : 'Server folder path';
  $('folder-list').setAttribute('aria-label', local ? 'Local folders' : 'Server folders');
}

function settingsMode() {
  const local = $('connection-mode').value === 'local';
  $('local-settings').hidden = $('local-settings').disabled = !local;
  $('ssh-settings').hidden = $('ssh-settings').disabled = local;
  updateSettingsActions();
}

function settingsConnectionOptions() {
  return { mode: $('connection-mode').value, host: $('host').value, port: $('port').value, key: $('key').value, cwd: $('default-cwd').value, localCwd: $('local-cwd').value, codexPath: $('codex-path').value };
}
function connectionSettingsChanged() {
  const next = settingsConnectionOptions(); const current = state.options || {};
  const fields = next.mode === 'local' ? ['localCwd', 'codexPath'] : ['host', 'port', 'key', 'cwd'];
  return next.mode !== (current.mode || 'ssh') || fields.some(key => key === 'port' ? Number(next[key]) !== Number(current[key] ?? 22) : String(next[key] || '').trim() !== String(current[key] || '').trim());
}
function connectionBusy() {
  const working = thread => thread?.status?.type === 'active';
  return state.connected && Boolean(state.active.size || state.dispatching.size || state.sending || state.commandBusy || working(state.thread) || state.threads.some(working) || [...state.pinnedThreads.values()].some(working));
}
function updateSettingsActions() {
  $('save-connect').hidden = state.connected && !connectionSettingsChanged();
  $('save-connect').disabled = state.connecting || connectionBusy();
  $('save-connect').title = connectionBusy() ? 'Finish or stop running tasks before changing the connection' : '';
}

function fillSettings(options) {
  $('completion-sound').checked = preferences.completionSound !== false;
  $('file-opener').value = preferences.fileOpener || 'vscode';
  $('file-opener').querySelector('[value="reveal"]').textContent = navigator.platform.includes('Mac') ? 'Show in Finder' : 'Show in file manager';
  $('connection-mode').value = options.mode || 'ssh';
  $('host').value = options.host;
  $('port').value = options.port;
  $('key').value = options.key;
  $('default-cwd').value = options.cwd;
  $('local-cwd').value = options.localCwd || '';
  $('codex-path').value = options.codexPath || '';
  settingsMode();
}

function isWriterConflict(error) { return /already has an active writer/i.test(error.message || String(error)); }
function showError(error) {
  state.retryError = null;
  let message = (error.message || String(error)).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
  if (isWriterConflict(error)) {
    if (state.writerConflicts.has(queueKey(state.thread?.id))) { $('error').hidden = true; updateBusy(); return; }
    message = 'Another Codex session owns this chat.';
  }
  $('error-text').textContent = message; $('error-text').title = message;
  $('error').hidden = false;
}
function status(text) {
  $('server-status').textContent = text;
  $('connection-dot').classList.toggle('online', state.connected);
  $('connect').hidden = state.connected;
  $('connect').textContent = state.connecting ? 'Connecting…' : 'Connect';
  $('connect').disabled = state.connecting;
  $('save-connect').disabled = state.connecting;
  updateSettingsActions();
  updateBusy();
}
function canStopTurn() {
  return state.connected && !state.connecting && !state.sending && !state.loading && !state.commandBusy && state.owned.has(state.thread?.id) && state.active.has(state.thread?.id) && !$('prompt').value.trim() && !state.images.length;
}
function updateSendButton() {
  const stop = canStopTurn();
  const busy = state.owned.has(state.thread?.id) && state.active.has(state.thread?.id);
  const interrupting = Boolean(state.interrupting && state.interrupting.options === state.options && state.interrupting.threadId === state.thread?.id && state.interrupting.turnId === state.active.get(state.thread?.id));
  $('send').hidden = false; $('send').type = stop ? 'button' : 'submit';
  $('send').textContent = stop ? '■' : '↑'; $('send').classList.toggle('stop-send', stop);
  $('send').title = stop ? 'Stop task' : busy ? 'Send after the current turn finishes' : 'Send message';
  $('send').setAttribute('aria-label', stop ? 'Stop task' : 'Send message');
  $('send').disabled = !state.connected || state.connecting || state.sending || state.commandBusy || state.loading || interrupting || queueLocked(state.queues.get(queueKey(state.thread?.id))) || state.images.some(image => !image.url);
  $('send-time').disabled = $('send').disabled;
}
async function stopTurn() {
  if (!canStopTurn()) return;
  const operation = { options: state.options, threadId: state.thread.id, turnId: state.active.get(state.thread.id) };
  if (state.interrupting?.options === operation.options && state.interrupting?.turnId === operation.turnId) return;
  state.interrupting = operation; updateSendButton();
  try { await rpc('turn/interrupt', { threadId: operation.threadId, turnId: operation.turnId }); }
  catch (error) { if (state.options === operation.options) showError(error); }
  finally { if (state.interrupting === operation) state.interrupting = null; updateSendButton(); }
}
function updateBusy() {
  for (const button of $('shortcut-buttons').children) button.disabled = shortcutUnavailable({ mode: button.dataset.mode });
  const busy = state.owned.has(state.thread?.id) && Boolean(state.active.get(state.thread?.id));
  $('writer-notice').hidden = !state.writerConflicts.has(queueKey(state.thread?.id));
  $('activity').hidden = !$('writer-notice').hidden && !busy && !state.sending && !state.loading;
  $('retry-writer').disabled = state.sending || state.loading || !state.connected;
  updateSendButton();
  updateSettingsActions();
  $('attach-images').disabled = state.sending || state.loading;
  $('prompt').disabled = state.loading || state.connecting || drafts.suspended;
  $('prompt').readOnly = state.sending || Boolean(state.commandBusy);
  $('timeline').classList.toggle('loading', state.loading);
  $('activity').classList.toggle('busy', busy);
  $('activity').textContent = state.sending ? 'Sending…' : state.loading ? 'Loading conversation…' : busy ? (isLocal() ? 'Codex is working locally…' : 'Codex is working on the server…') : '';
  $('model').disabled = state.loading || busy;
  $('effort').disabled = state.loading || busy;
  $('permissions').disabled = state.loading || busy;
  $('new-chat').disabled = state.connecting || state.sending || state.commandBusy;
  $('plan-mode').hidden = !modes.plan;
  $('browse-workspace').disabled = !state.connected || state.sending || state.loading;
  $('choose-project').disabled = !state.connected || state.sending || state.loading;
  $('resend-message').disabled = Boolean(state.resending);
  $('cancel-message-edit').disabled = Boolean(state.resending);
  $('edited-message').readOnly = Boolean(state.resending);
  renderQueue();
  renderSchedules();
  renderThreadIndicators();
  renderUsage();
  const turns = new Set();
  for (const button of $('messages').querySelectorAll('.edit-message')) {
    const turnId = button.dataset.turnId;
    button.hidden = turns.has(turnId); turns.add(turnId);
    button.disabled = !state.connected || state.sending || state.commandBusy || state.loading || state.active.has(state.thread?.id);
    button.title = state.active.has(state.thread?.id) ? 'Stop the running task before editing' : 'Edit and resend in this conversation';
  }
  saveComposerDraft();
}
function mergeRateLimit(previous = {}, incoming = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    merged[key] = ['primary', 'secondary', 'credits'].includes(key) ? { ...previous[key], ...Object.fromEntries(Object.entries(value).filter(([, field]) => field != null)) } : value;
  }
  return merged;
}
function applyRateLimit(snapshot) {
  const account = usage.account || {};
  const id = snapshot.limitId || account.rateLimits?.limitId || 'codex';
  const previous = account.rateLimitsByLimitId?.[id] || (id === (account.rateLimits?.limitId || 'codex') ? account.rateLimits : null) || {};
  const merged = mergeRateLimit(previous, snapshot);
  usage.account = { ...account, rateLimits: !account.rateLimits || id === (account.rateLimits.limitId || 'codex') ? merged : account.rateLimits, rateLimitsByLimitId: { ...account.rateLimitsByLimitId, [id]: merged } };
}
async function refreshUsage() {
  if (!state.connected || usage.reading) return;
  const request = { options: state.options, generation: usage.generation, updates: [] }; usage.reading = request;
  renderUsage();
  try {
    const result = await rpc('account/rateLimits/read', { excludeResetCreditDetails: false });
    if (request.options !== state.options || request.generation !== usage.generation || !state.connected) return;
    usage.account = result;
    for (const snapshot of request.updates) applyRateLimit(snapshot);
    usage.updatedAt = Date.now(); usage.error = null;
  } catch (error) {
    if (request.options === state.options && request.generation === usage.generation) usage.error = error.message;
  } finally { if (usage.reading === request) { usage.reading = null; renderUsage(); } }
}
function usageWindowLabel(minutes, fallback) {
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 10080) return 'Week';
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
function usageDateRow(label, timestamp, fallback = 'Not available') {
  const row = document.createElement('div'); row.className = 'usage-reset';
  const caption = document.createElement('span'); caption.className = 'usage-reset-label'; caption.textContent = label; row.append(caption);
  const date = new Date(timestamp * 1000);
  if (Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(date.getTime())) {
    const time = document.createElement('time'); time.dateTime = date.toISOString();
    const day = document.createElement('strong'); day.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    const clock = document.createElement('span'); clock.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    time.append(day, clock); row.append(time);
  } else {
    const unknown = document.createElement('span'); unknown.className = 'muted'; unknown.textContent = fallback; row.append(unknown);
  }
  return row;
}
function renderUsage() {
  const meter = $('usage-meter'); meter.hidden = !state.connected;
  if (!state.connected) { if ($('usage-panel').matches(':popover-open')) $('usage-panel').hidePopover(); $('usage-details').replaceChildren(); return; }
  const tokenUsage = usage.threads.get(state.thread?.id);
  const capacity = tokenUsage?.modelContextWindow; const tokens = tokenUsage?.last?.totalTokens;
  const context = Number.isFinite(capacity) && capacity > 0 && Number.isFinite(tokens) && tokens >= 0 ? Math.round(Math.max(0, Math.min(100, (capacity - tokens) / capacity * 100))) : null;
  const account = usage.account;
  const limit = account?.rateLimitsByLimitId?.[$('model').value] || account?.rateLimitsByLimitId?.codex || account?.rateLimits;
  const windows = ['primary', 'secondary'].flatMap((key, index) => {
    const value = limit?.[key];
    return typeof value?.usedPercent === 'number' && Number.isFinite(value.usedPercent) ? [{ label: usageWindowLabel(value.windowDurationMins, index ? 'Other' : 'Limit'), left: Math.round(Math.max(0, Math.min(100, 100 - value.usedPercent))), resetsAt: value.resetsAt }] : [];
  });
  const tightest = [...windows].sort((a, b) => a.left - b.left)[0];
  const unlimited = !windows.length && limit?.credits?.unlimited === true;
  const rows = [{ label: 'Ctx', left: context, name: 'Conversation context remaining' }, { label: unlimited ? 'Credit' : tightest?.label || 'Quota', left: unlimited ? 100 : tightest?.left ?? null, name: unlimited ? 'Available credits' : 'Account quota remaining', unlimited }];
  meter.replaceChildren();
  for (const value of rows) {
    const row = document.createElement('span'); row.className = 'usage-line' + (value.left != null && value.left <= 10 ? ' critical' : value.left != null && value.left <= 25 ? ' low' : '');
    const label = document.createElement('span'); label.className = 'usage-label'; label.textContent = value.label;
    const track = document.createElement('span'); track.className = 'usage-track'; track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', value.name); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    if (value.left != null) track.setAttribute('aria-valuenow', String(value.left)); else track.setAttribute('aria-valuetext', 'Not reported yet');
    const fill = document.createElement('span'); fill.className = 'usage-fill'; fill.style.width = `${value.left ?? 0}%`; track.append(fill);
    const percent = document.createElement('span'); percent.className = 'usage-percent'; percent.textContent = value.unlimited ? '∞' : value.left == null ? '—' : `${value.left}%`;
    row.append(label, track, percent); meter.append(row);
  }
  const details = windows.map(value => usageDateRow(value.label === 'Week' ? 'Weekly reset' : `${value.label} reset`, value.resetsAt));
  const resets = account?.rateLimitResetCredits;
  if (Number.isSafeInteger(resets?.availableCount) && resets.availableCount >= 0) {
    const section = document.createElement('section'); section.className = 'usage-credits';
    const heading = document.createElement('h3'); heading.textContent = `Early resets · ${resets.availableCount} available`; section.append(heading);
    const available = (resets.credits || []).filter(credit => credit.status === 'available' && (credit.expiresAt == null || credit.expiresAt > Date.now() / 1000))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    for (const credit of available) section.append(usageDateRow(`${credit.title || 'Reset'} · expires`, credit.expiresAt, credit.expiresAt === null ? 'No expiry' : 'Expiry unavailable'));
    if (available.length < resets.availableCount) {
      const unknown = document.createElement('p'); unknown.className = 'muted'; unknown.textContent = 'Some expiry dates unavailable.'; section.append(unknown);
    }
    details.push(section);
  }
  const notices = [];
  if (!windows.length) notices.push(usage.reading ? 'Loading reset times…' : 'No reset time reported.');
  if (account?.ordinaryUsageAllowed === false) notices.push('Usage currently blocked.');
  if (usage.error) notices.push(`Could not refresh: ${usage.error}`);
  for (const text of notices) { const paragraph = document.createElement('p'); paragraph.textContent = text; details.push(paragraph); }
  $('usage-details').replaceChildren(...details);
  positionUsagePanel();
}
function positionUsagePanel() {
  const panel = $('usage-panel');
  if (!panel.matches(':popover-open')) return;
  const anchor = $('usage-meter').getBoundingClientRect(); const bounds = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(12, Math.min(innerWidth - bounds.width - 12, anchor.right - bounds.width))}px`;
  panel.style.bottom = `${Math.max(12, Math.min(innerHeight - bounds.height - 12, innerHeight - anchor.top + 8))}px`;
}
$('usage-meter').onclick = () => {
  if ($('usage-panel').matches(':popover-open')) { $('usage-panel').hidePopover(); return; }
  renderUsage(); $('usage-panel').showPopover(); positionUsagePanel();
  return refreshUsage();
};
$('usage-panel').addEventListener('toggle', event => $('usage-meter').setAttribute('aria-expanded', String(event.newState === 'open')));
$('close-usage').onclick = () => $('usage-panel').hidePopover();
addEventListener('resize', positionUsagePanel);
function scrollToBottom(force = false) {
  const el = $('timeline');
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 180) el.scrollTop = el.scrollHeight;
}
function renderThreads() {
  const focusedThread = $('threads').contains(document.activeElement) ? document.activeElement.closest('.thread')?.dataset.threadId : null;
  const fragment = document.createDocumentFragment();
  const search = $('search').value.trim().toLowerCase();
  const projectIds = new Set(projects.data.map(project => project.id));
  const available = [...new Map([...state.pinnedThreads.values(), ...state.threads].map(thread => [thread.id, thread])).values()];
  const pinned = [...state.pinnedIds].map(id => state.pinnedThreads.get(id) || { id, preview: 'Unavailable conversation' }).filter(thread => !projectIds.has(thread.projectId) && (!search || titleOf(thread).toLowerCase().includes(search)));
  const recent = state.threads.filter(thread => !state.pinnedIds.has(thread.id) && !projectIds.has(thread.projectId));
  const heading = (text, target = fragment) => {
    const label = document.createElement('div'); label.className = 'list-heading thread-group'; label.textContent = text; target.append(label);
  };
  const row = (thread, target = fragment) => {
    const container = document.createElement('div'); container.className = 'thread-row' + (state.pinnedIds.has(thread.id) ? ' pinned-thread' : '');
    const button = document.createElement('button');
    button.className = 'thread' + (state.thread?.id === thread.id ? ' selected' : '');
    button.dataset.threadId = thread.id;
    button.setAttribute('aria-current', state.thread?.id === thread.id ? 'true' : 'false');
    const name = document.createElement('strong');
    name.textContent = titleOf(thread);
    button.append(name);
    button.oncontextmenu = event => { event.preventDefault(); showThreadMenu(thread, event.clientX, event.clientY); };
    button.title = titleOf(thread);
    button.onclick = () => { button.focus({ preventScroll: true }); return openThread(thread).catch(showError); };
    button.draggable = state.connected && !threadDrag.orderPending.has(JSON.stringify([accessKey(), thread.projectId]));
    button.ondragstart = event => {
      if (!button.draggable || threadDrag.pending.has(queueKey(thread.id)) || state.archiving?.threadId === thread.id || !event.dataTransfer) { event.preventDefault(); return; }
      clearThreadDrag();
      clearProjectDrag();
      threadDrag.source = { thread, options: state.options, token: crypto.randomUUID() };
      event.dataTransfer.setData(threadDrag.type, threadDrag.source.token);
      event.dataTransfer.setData('text/plain', titleOf(thread)); event.dataTransfer.effectAllowed = 'move';
      button.classList.add('dragging'); $('thread-menu').hidden = true;
      for (const group of $('threads').querySelectorAll('[data-search-hidden]')) group.hidden = false;
    };
    button.ondragend = clearThreadDrag;
    if (thread.projectId) bindThreadOrder(container, thread);
    const pin = document.createElement('button');
    const isPinned = state.pinnedIds.has(thread.id);
    pin.className = 'pin-thread' + (isPinned ? ' pinned' : '');
    pin.title = isPinned ? 'Unpin conversation' : 'Pin conversation';
    pin.setAttribute('aria-label', `${pin.title}: ${titleOf(thread)}`);
    pin.setAttribute('aria-pressed', String(isPinned));
    pin.disabled = !state.connected || state.pinning.has(thread.id) || state.archiving?.threadId === thread.id;
    pin.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 9V3H8v6l-3 3v2h14v-2l-3-3M12 14v7"/></svg>';
    pin.onclick = () => togglePin(thread).catch(showError);
    container.append(button, pin);
    target.append(container);
  };
  pinned.forEach(thread => row(thread));
  let hasProjectGroups = false;
  for (const project of projects.data) {
    const members = sortProjectThreads(available.filter(thread => thread.projectId === project.id), project.id).filter(thread => !search || titleOf(thread).toLowerCase().includes(search));
    const hiddenBySearch = Boolean(search && !members.length);
    if (!hiddenBySearch) hasProjectGroups = true;
    const group = document.createElement('section'); group.className = 'project-group'; group.dataset.projectId = project.id;
    if (hiddenBySearch) { group.dataset.searchHidden = 'true'; group.hidden = !threadDrag.source; }
    bindThreadDrop(group, project.id);
    const header = document.createElement('div'); header.className = 'project-heading';
    bindProjectDrag(group, header, project);
    header.oncontextmenu = event => { event.preventDefault(); showProjectMenu(project, event.clientX, event.clientY); };
    const toggle = document.createElement('button'); toggle.className = 'project-toggle'; toggle.title = project.roots.map(root => root.path).join('\n');
    const collapsed = !search && projects.collapsed.has(project.id);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const arrow = document.createElement('span'); arrow.className = 'project-arrow' + (collapsed ? '' : ' expanded'); arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';
    const name = document.createElement('strong'); name.textContent = project.name; toggle.append(arrow, name);
    toggle.onclick = () => {
      if (projects.collapsed.has(project.id)) projects.collapsed.delete(project.id); else projects.collapsed.add(project.id);
      localStorage.setItem(accessKey() + ':collapsed-projects', JSON.stringify([...projects.collapsed])); renderThreads();
    };
    const create = document.createElement('button'); create.className = 'project-new'; create.title = `New conversation in ${project.name}`; create.setAttribute('aria-label', create.title);
    create.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    create.disabled = !state.connected || state.sending || Boolean(state.commandBusy); create.onclick = () => startProject(project);
    const menu = document.createElement('button'); menu.className = 'project-menu-button'; menu.textContent = '⋯';
    menu.title = `Manage ${project.name}`; menu.setAttribute('aria-label', menu.title); menu.setAttribute('aria-haspopup', 'menu');
    menu.onclick = event => { event.stopPropagation(); const rect = menu.getBoundingClientRect(); showProjectMenu(project, rect.left, rect.bottom); };
    header.append(toggle, menu, create); group.append(header);
    const conversations = document.createElement('div'); conversations.className = 'project-threads'; conversations.hidden = collapsed;
    members.forEach(thread => row(thread, conversations));
    if (!members.length && !search) { const empty = document.createElement('p'); empty.className = 'project-empty'; empty.textContent = 'No conversations yet'; conversations.append(empty); }
    if (projects.cursors.get(project.id)) {
      const more = document.createElement('button'); more.className = 'project-more'; more.textContent = 'Load more conversations';
      more.onclick = async () => { more.disabled = true; try { await loadThreads(true, project.id); } catch (error) { showError(error); } finally { more.disabled = false; } };
      conversations.append(more);
    }
    group.append(conversations); fragment.append(group);
  }
  if (projects.data.length) {
    const other = document.createElement('section'); other.className = 'other-conversations'; other.setAttribute('aria-label', 'Other conversations');
    bindThreadDrop(other, null); heading('OTHER CONVERSATIONS', other); recent.forEach(thread => row(thread, other));
    if (!recent.length && !pinned.length && !search) { const hint = document.createElement('p'); hint.className = 'project-empty'; hint.textContent = 'Drop conversations here'; other.append(hint); }
    fragment.append(other);
  } else {
    if (recent.length && pinned.length) heading('RECENT');
    recent.forEach(thread => row(thread));
  }
  if (!recent.length && !pinned.length && !hasProjectGroups) {
    const empty = document.createElement('p');
    empty.className = 'muted list-empty';
    empty.textContent = state.connected ? 'No conversations found. Start a new one.' : 'Connect to see your conversations.';
    fragment.append(empty);
  }
  $('threads').replaceChildren(fragment);
  if (focusedThread) [...$('threads').querySelectorAll('.thread')].find(button => button.dataset.threadId === focusedThread)?.focus({ preventScroll: true });
  $('more-threads').hidden = !state.threadCursor;
  renderThreadIndicators();
  for (const thread of available) requestTitle(thread);
}

async function loadProjects() {
  const generation = ++projects.generation; const options = state.options;
  const data = []; let cursor = null;
  do { const page = await rpc('project/list', { limit: 100, cursor, sortKey: 'position', sortDirection: 'asc' }); data.push(...page.data); cursor = page.nextCursor; } while (cursor && state.options === options && generation === projects.generation);
  if (state.options !== options || generation !== projects.generation) return false;
  projects.data = data;
  if (!data.some(project => project.id === projects.selected)) projects.selected = null;
  for (const id of projects.expanded) if (!data.some(project => project.id === id)) projects.expanded.delete(id);
  return true;
}
async function refreshProjects() { if (state.connected && await loadProjects()) await loadThreads(); }
async function expandProject(project, load = true) {
  if (!state.connected || state.sending || state.commandBusy || state.loading || !projects.data.some(entry => entry.id === project.id) || !project.roots[0]?.path) return;
  projects.expanded.add(project.id); projects.collapsed.delete(project.id);
  renderThreads();
  if (load) await loadThreads();
}
async function restoreStartupProject() {
  const project = projects.data.find(entry => entry.id === preferences.startupProjects[accessKey()]);
  if (project) {
    projects.selected = project.id; $('workspace').value = project.roots[0].path;
    await expandProject(project, false);
  }
}
function projectAtPath(path) {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return projects.data.find(project => project.roots.some(root => normalize(root.path) === normalize(path)));
}
function startProject(project) {
  if (!state.connected || state.sending || state.commandBusy || !project.roots[0]?.path) return;
  projects.selected = project.id;
  $('workspace').value = project.roots[0].path;
  projects.collapsed.delete(project.id);
  resetThread();
}
function renderThreadIndicators() {
  const threads = new Map([...state.threads, ...state.pinnedThreads.values()].map(thread => [thread.id, thread]));
  for (const button of $('threads').querySelectorAll('.thread')) {
    const threadId = button.dataset.threadId;
    const thread = threads.get(threadId);
    const working = state.connected && (state.active.has(threadId) || state.dispatching.has(queueKey(threadId)) || thread?.status?.type === 'active');
    const completion = state.completions.get(queueKey(threadId));
    const unread = state.unread.has(queueKey(threadId));
    button.classList.toggle('unread', unread);
    const label = working ? 'Working…' : unread ? 'Unread' : completion === 'completed' ? 'Finished' : completion === 'failed' ? 'Failed' : '';
    const scheduled = scheduledFor(threadId);
    let clock = button.querySelector('.thread-schedule');
    const scheduledLabel = scheduled.length ? `${scheduled.length} scheduled message(s); next ${new Date(scheduled[0].runAt).toLocaleString()}` : '';
    if (!scheduled.length) clock?.remove();
    else {
      if (!clock) {
        clock = document.createElement('span'); clock.className = 'thread-schedule'; clock.setAttribute('role', 'img');
        clock.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
        button.append(clock);
      }
      clock.title = scheduledLabel; clock.setAttribute('aria-label', scheduledLabel);
    }
    const description = [label, scheduledLabel].filter(Boolean).join(' · ');
    const title = button.querySelector('strong').textContent;
    button.title = title + (description ? ' · ' + description : '');
    if (description) button.setAttribute('aria-label', button.title); else button.removeAttribute('aria-label');
    let indicator = button.querySelector('.thread-state');
    if (!label) { indicator?.remove(); continue; }
    if (!indicator) { indicator = document.createElement('span'); indicator.setAttribute('role', 'img'); }
    button.prepend(indicator);
    indicator.className = 'thread-state ' + (working ? 'working' : unread ? 'unread' : completion);
    indicator.setAttribute('aria-label', label); indicator.title = label;
  }
}
function restoreUnread() {
  const machine = accessKey();
  const prefix = accessKey() + ':';
  try {
    let saved = preferences.conversationStates[machine];
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem(machine + ':unread') || '[]');
      saved = { unread: Array.isArray(legacy) ? legacy.filter(id => typeof id === 'string' && id) : [], completions: {} };
      saveConversationMarkers({ machine, ...saved });
    }
    for (const key of state.unread) if (key.startsWith(prefix)) state.unread.delete(key);
    for (const key of state.completions.keys()) if (key.startsWith(prefix)) state.completions.delete(key);
    for (const id of saved.unread) state.unread.add(prefix + id);
    for (const [id, status] of Object.entries(saved.completions)) state.completions.set(prefix + id, status);
  } catch (error) { showError(`Could not load unread markers: ${error.message}`); }
}
function saveConversationMarkers(value) {
  api.saveConversationState(value);
  preferences.conversationStates[value.machine] = { unread: [...value.unread], completions: { ...value.completions } };
}
function conversationMarkers(unread = state.unread, completions = state.completions) {
  const machine = accessKey(); const prefix = machine + ':';
  return { machine, unread: [...unread].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)), completions: Object.fromEntries([...completions].filter(([key]) => key.startsWith(prefix)).map(([key, status]) => [key.slice(prefix.length), status])) };
}
function setUnread(threadId, unread) {
  const key = queueKey(threadId);
  if (state.unread.has(key) === unread) return true;
  const next = new Set(state.unread);
  if (unread) next.add(key); else next.delete(key);
  try {
    saveConversationMarkers(conversationMarkers(next));
    state.unread = next; renderThreadIndicators(); return true;
  } catch (error) { showError(`Could not save unread markers: ${error.message}`); return false; }
}
function setCompletion(threadId, status = null) {
  const key = queueKey(threadId);
  if ((state.completions.get(key) || null) === status) return true;
  const next = new Map(state.completions);
  if (status) next.set(key, status); else next.delete(key);
  try {
    saveConversationMarkers(conversationMarkers(state.unread, next));
    state.completions = next; return true;
  } catch (error) { showError(`Could not save conversation markers: ${error.message}`); return false; }
}
function isViewingLatest(threadId) {
  const timeline = $('timeline');
  return Boolean(threadId && state.thread?.id === threadId && !state.loading && !document.hidden && document.hasFocus() && !document.querySelector('dialog[open]') && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 24);
}
function acknowledgeVisibleThread() {
  if (!isViewingLatest(state.thread?.id)) return;
  const key = queueKey(state.thread.id);
  const completed = state.completions.has(key);
  if (completed) setCompletion(state.thread.id);
  if (state.unread.has(key)) setUnread(state.thread.id, false);
  else if (completed) renderThreadIndicators();
}
function markUnread(thread) {
  if (!thread?.id || state.loading && state.thread?.id === thread.id) return;
  setUnread(thread.id, true);
  $('thread-menu').hidden = true;
}
function unreadShortcut(event) {
  const modified = (event.metaKey || event.ctrlKey) && event.shiftKey;
  const focused = document.activeElement?.closest('#threads .thread');
  const typing = event.target?.closest?.('input,textarea,select,[contenteditable]');
  const plain = !event.metaKey && !event.ctrlKey && !typing && focused?.dataset.threadId === state.thread?.id;
  if (!(modified || plain) || event.altKey || event.isComposing || event.key?.toLowerCase() !== 'u' || document.querySelector('dialog[open]') || !state.thread || state.loading) return;
  event.preventDefault(); markUnread(state.thread);
}
function setThreadRuntimeStatus(threadId, status) {
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.status = status;
}

async function togglePin(thread) {
  if (!state.connected || state.pinning.has(thread.id) || state.archiving?.threadId === thread.id) return;
  const options = state.options;
  state.pinning.add(thread.id);
  renderThreads();
  try {
    const ids = await api.setPin(thread.id, !state.pinnedIds.has(thread.id));
    if (state.options !== options) return;
    state.pinnedIds = new Set(ids);
    if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
    else state.pinnedThreads.delete(thread.id);
  } finally {
    if (state.options === options) { state.pinning.delete(thread.id); renderThreads(); }
  }
}
async function loadThreads(more = false, projectId = null) {
  if (!state.connected) return;
  const generation = more ? state.listGeneration : ++state.listGeneration;
  const searchTerm = $('search').value.trim() || null;
  const query = JSON.stringify([accessKey(), searchTerm, projects.data.map(project => project.id).sort()]);
  const sameQuery = state.threadQuery === query;
  const filters = more ? [projectId] : [null, ...projects.data.map(project => project.id)];
  const pages = await Promise.all(filters.map(async id => {
    const limit = id && !projects.expanded.has(id) ? 5 : 50;
    const loaded = state.threadCoverage?.get(id) || 0;
    const target = !more && sameQuery && limit === 50 ? loaded : 0;
    const data = []; let cursor = more ? (id ? projects.cursors.get(id) : state.threadCursor) : null;
    do {
      const page = await rpc('thread/list', { limit, sortKey: 'updated_at', modelProviders: [], searchTerm, cursor, ...(projects.data.length ? { projectId: id } : {}) });
      data.push(...page.data); cursor = page.nextCursor;
    } while (cursor && data.length < target && generation === state.listGeneration);
    return { data, nextCursor: cursor };
  }));
  if (generation !== state.listGeneration) return;
  const machine = accessKey();
  for (const [index, id] of filters.entries()) {
    const ids = preferences.threadOrders[machine]?.[id];
    if (!id || !ids?.length || preferences.threadOrderCutoffs[machine]?.[id] !== undefined) continue;
    const known = new Set(ids);
    const dates = pages[index].data.filter(thread => known.has(thread.id) && Number.isSafeInteger(thread.createdAt) && thread.createdAt >= 0).map(thread => thread.createdAt);
    if (!dates.length) continue;
    const saved = await api.savePreferences({ threadOrder: { machine, projectId: id, cutoff: Math.max(...dates) } });
    if (generation !== state.listGeneration) return;
    preferences.threadOrderCutoffs[machine] = { ...saved.threadOrderCutoffs[machine], ...preferences.threadOrderCutoffs[machine] };
  }
  const combined = [...(more ? state.threads : []), ...pages.flatMap(page => page.data)];
  if (!searchTerm) {
    const listed = new Set(combined.map(thread => thread.id));
    for (const [index, thread] of [...state.threads, ...(state.thread ? [state.thread] : [])].entries()) {
      if (listed.has(thread.id) || thread.id !== state.thread?.id && (!sameQuery || !state.active.has(thread.id))) continue;
      if (projects.data.length && thread.projectId && !filters.includes(thread.projectId)) continue;
      combined.splice(Math.min(index, combined.length), 0, thread); listed.add(thread.id);
      trace('threads.refresh-retained', { threadId: thread.id, reason: 'open-or-running-chat-missing-from-page' });
    }
  }
  state.threads = [...new Map(combined.map(thread => [thread.id, thread])).values()];
  if (!more || !sameQuery) state.threadCoverage = new Map();
  filters.forEach((id, index) => state.threadCoverage.set(id, (more ? state.threadCoverage.get(id) || 0 : 0) + pages[index].data.length));
  state.threadQuery = query;
  if (!more) projects.cursors.clear();
  filters.forEach((id, index) => { if (id) projects.cursors.set(id, pages[index].nextCursor); else state.threadCursor = pages[index].nextCursor; });
  for (const thread of state.threads) if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
  const missing = [...state.pinnedIds].filter(id => !state.pinnedThreads.has(id));
  const pinned = await Promise.allSettled(missing.map(threadId => rpc('thread/read', { threadId, includeTurns: false })));
  if (generation !== state.listGeneration) return;
  for (const result of pinned) if (result.status === 'fulfilled' && state.pinnedIds.has(result.value.thread.id)) state.pinnedThreads.set(result.value.thread.id, result.value.thread);
  renderThreads();
  updateSettingsActions();
}
function resetThread(folder) {
  saveComposerDraft(); drafts.target = null;
  clearQueueDrag();
  imageLoads.clear(); $('image-preview-dialog').close();
  state.selection++;
  const project = projects.data.find(project => project.id === projects.selected);
  if (typeof folder === 'string') $('workspace').value = folder;
  else if (project?.roots[0]?.path) $('workspace').value = project.roots[0].path;
  modes.plan = false; hideSlash();
  state.images = [];
  renderImages();
  state.historyEvents = null;
  state.loading = false;
  state.thread = null;
  $('send-time').value = '0';
  state.items.clear();
  state.turnCursor = null;
  $('messages').replaceChildren();
  $('welcome').hidden = false;
  $('older-turns').hidden = true;
  $('thread-title').textContent = 'New conversation';
  $('thread-path').textContent = $('workspace').value;
  $('prompt').value = '';
  activateComposerDraft();
  renderThreads();
  renderRequests();
  updateBusy();
  $('prompt').focus();
}
function setThread(thread) {
  if (state.thread?.id !== thread.id) { saveComposerDraft(); drafts.target = null; modes.plan = modes.threads.get(thread.id) || false; $('send-time').value = '0'; }
  state.thread = thread;
  projects.selected = thread.projectId || null;
  if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
  $('thread-title').textContent = titleOf(thread);
  $('thread-path').textContent = thread.cwd;
  $('welcome').hidden = true;
  const keepDraftSettings = api.draft && drafts.target && ($('prompt').value || state.images.length);
  if (!keepDraftSettings) {
    if (thread.model && [...$('model').options].some(option => option.value === thread.model)) $('model').value = thread.model;
    updateEfforts(thread.reasoningEffort);
  }
  activateComposerDraft();
  renderThreads();
  renderRequests();
  updateBusy();
}
async function openThread(thread, allowBusy = false) {
  if (!state.connected || state.sending || state.commandBusy && !allowBusy) return;
  if (state.thread?.id !== thread.id) { saveComposerDraft(); drafts.target = null; }
  const selection = ++state.selection;
  imageLoads.clear(); $('image-preview-dialog').close();
  $('error').hidden = true;
  if (state.thread?.id !== thread.id) { state.images = []; renderImages(); }
  state.loading = true;
  state.items.clear();
  state.historyEvents = [];
  $('messages').replaceChildren();
  try {
    setThread(thread);
    const result = await rpc('thread/read', { threadId: thread.id, includeTurns: false });
    if (selection !== state.selection) return;
    setThread(result.thread);
    const history = await rpc('thread/turns/list', { threadId: thread.id, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    if (selection !== state.selection) return;
    state.turnCursor = history.nextCursor;
    $('older-turns').hidden = !state.turnCursor;
    state.active.delete(thread.id);
    for (const turn of [...history.data].reverse()) {
      for (const item of turn.items || []) renderItem(item, false, turn.id);
      if (turn.status === 'inProgress') state.active.set(thread.id, turn.id);
    }
    const buffered = state.historyEvents;
    state.historyEvents = null;
    for (const event of buffered) {
      if (event.receivedSequence > history.receivedSequence) handleNotification(event);
    }
    await Promise.allSettled([...$('messages').querySelectorAll('img')].map(image => image.decode()));
    if (selection !== state.selection) return;
    scrollToBottom(true);
    setUnread(thread.id, false);
    setCompletion(thread.id); renderThreadIndicators();
  } finally {
    if (selection === state.selection) { state.loading = false; state.historyEvents = null; updateBusy(); flushQueue(thread.id).catch(showError); }
  }
}
function imagePath(source) {
  if (source.startsWith('sandbox:')) source = source.slice(8);
  if (/^[a-z]:[\\/]/i.test(source)) source = 'file:///' + source.replace(/\\/g, '/');
  const cwd = (state.thread?.cwd || $('workspace').value || '/').replace(/\\/g, '/');
  const base = 'file://' + (cwd.startsWith('/') ? '' : '/') + encodeURI(cwd).replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/\/$/, '') + '/';
  const url = new URL(source, base);
  if (url.protocol !== 'file:' || url.hostname) throw new Error('Only images on the connected machine are supported.');
  return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
}
function messageImage(source, alt = 'Image') {
  const figure = document.createElement('figure'); figure.className = 'message-figure';
  const image = document.createElement('img'); image.className = 'message-image'; image.alt = alt;
  const caption = document.createElement('figcaption'); caption.textContent = 'Loading image…';
  figure.append(caption);
  const options = state.options;
  const ready = (async () => {
    if (typeof source !== 'string' || !source) throw new Error('Image source is missing.');
    let url = source;
    if (!source.startsWith('data:')) {
      const file = imagePath(source);
      if (!imageLoads.has(file)) {
        if (imageLoads.size >= 20) imageLoads.delete(imageLoads.keys().next().value);
        const request = api.readImage(file).catch(error => { if (imageLoads.get(file) === request) imageLoads.delete(file); throw error; });
        imageLoads.set(file, request);
      }
      url = await imageLoads.get(file);
    }
    if (options !== state.options) return;
    if (typeof url !== 'string' || url.length > 28 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) throw new Error('Unsupported or oversized image.');
    const atBottom = $('timeline').scrollHeight - $('timeline').scrollTop - $('timeline').clientHeight < 180;
    image.src = url; figure.prepend(image);
    await image.decode();
    if (options !== state.options) return;
    image.tabIndex = 0; image.setAttribute('role', 'button'); image.title = 'Click to enlarge';
    image.onclick = event => { event.preventDefault(); $('image-preview').src = url; $('image-preview').alt = alt; $('image-preview-title').textContent = alt; $('image-preview-dialog').showModal(); };
    image.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); image.click(); } };
    figure.replaceChildren(image);
    if (atBottom && figure.isConnected) scrollToBottom(true);
  })().catch(error => { if (options === state.options) { caption.textContent = `Could not load image: ${error.message}`; figure.replaceChildren(caption); } });
  figure.imageReady = ready;
  return figure;
}
$('close-image-preview').onclick = () => $('image-preview-dialog').close();
$('image-preview-dialog').onclose = () => $('image-preview').removeAttribute('src');
function markdown(element, text) {
  const images = [];
  const renderer = new marked.Renderer();
  renderer.link = function(token) {
    if (/^[^/\\:?#]+\.[^/\\:?#]+:\d+(?::\d+)?$/.test(token.href)) token = { ...token, href: './' + token.href };
    return marked.Renderer.prototype.link.call(this, token);
  };
  renderer.image = token => { const index = images.push(token) - 1; return `<span data-codex-image="${index}"></span>`; };
  element.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { breaks: true, renderer }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'a', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'span'],
    ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'data-codex-image'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|file):|[a-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
  for (const link of element.querySelectorAll('a[href]')) linkContexts.set(link, { machine: accessKey(), cwd: state.thread?.cwd || $('workspace').value });
  for (const placeholder of element.querySelectorAll('[data-codex-image]')) {
    const token = images[Number(placeholder.dataset.codexImage)];
    if (token) placeholder.replaceWith(messageImage(token.href, token.text || 'Image')); else placeholder.remove();
  }
}
function diffWordRanges(before, after) {
  if (before === after || before.length > 2400 || after.length > 2400) return [[], []];
  const words = text => [...text.matchAll(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu)];
  const a = words(before), b = words(after);
  if (a.length > 180 || b.length > 180) return [[], []];
  const scores = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    scores[i][j] = a[i][0] === b[j][0] ? scores[i + 1][j + 1] + 1 : Math.max(scores[i + 1][j], scores[i][j + 1]);
  const removed = [], added = [];
  const addRange = (ranges, word) => {
    const end = word.index + word[0].length;
    if (ranges.at(-1)?.end === word.index) ranges.at(-1).end = end;
    else ranges.push({ start: word.index, end });
  };
  let i = 0, j = 0, common = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i][0] === b[j][0]) { common += a[i][0].trim().length; i++; j++; }
    else if (j < b.length && (i === a.length || scores[i][j + 1] >= scores[i + 1][j])) addRange(added, b[j++]);
    else addRange(removed, a[i++]);
  }
  const total = before.replace(/\s/g, '').length + after.replace(/\s/g, '').length;
  return total && 2 * common / total < 0.4 ? [[], []] : [removed, added];
}
function renderDiff(patch) {
  let inHunk = false;
  const rows = patch.split('\n').map(line => {
    if (line.startsWith('diff --git ')) inHunk = false;
    if (line.startsWith('@@')) inHunk = true;
    const kind = line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') && (inHunk || !line.startsWith('+++')) ? 'diff-added' : line.startsWith('-') && (inHunk || !line.startsWith('---')) ? 'diff-removed' : '';
    return { line, kind, ranges: [] };
  });
  for (let index = 0; patch.length <= 180000 && index < rows.length;) {
    if (rows[index].kind !== 'diff-removed') { index++; continue; }
    const start = index;
    while (rows[index]?.kind === 'diff-removed') index++;
    const added = index;
    while (rows[index]?.kind === 'diff-added') index++;
    for (let pair = 0; pair < Math.min(added - start, index - added); pair++) {
      const before = rows[start + pair], after = rows[added + pair];
      [before.ranges, after.ranges] = diffWordRanges(before.line.slice(1), after.line.slice(1));
    }
  }
  const pre = document.createElement('pre');
  for (const { line, kind, ranges } of rows) {
    const span = document.createElement('span'); span.className = kind;
    let offset = 0;
    for (const range of ranges) {
      span.append(document.createTextNode(line.slice(offset, range.start + 1)));
      const changed = document.createElement('span'); changed.className = 'diff-word-change'; changed.textContent = line.slice(range.start + 1, range.end + 1);
      span.append(changed); offset = range.end + 1;
    }
    span.append(document.createTextNode(line.slice(offset) + '\n')); pre.append(span);
  }
  return pre;
}
function moveDiffElement(parent, element, before) {
  // Native moves keep focus but collapse text selections.
  const selection = getSelection();
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  const selected = element.contains(anchorNode) || element.contains(focusNode);
  parent.moveBefore(element, before);
  if (selected && anchorNode?.isConnected && focusNode?.isConnected) selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}
function updateFileDiff(entry, context) {
  const file = entry.file;
  let body = entry.querySelector('.changed-file-content');
  if (!body) {
    body = document.createElement('div'); body.className = 'changed-file-content';
    const diff = document.createElement('div'); diff.className = 'changed-file-diff'; diff.tabIndex = 0;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'subtle open-changed-file'; open.textContent = 'Open in editor';
    open.onclick = async () => {
      const href = entry.file.path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
      try { await api.openLink(href, context); } catch (error) { showError(error); }
    };
    body.append(diff, open); entry.append(body);
  }
  const diff = body.firstElementChild;
  const top = diff.scrollTop, left = diff.scrollLeft;
  const patches = file.diffs.length ? file.diffs : ['No textual diff reported.'];
  for (const [index, patch] of patches.entries()) {
    if (entry.renderedDiffs?.[index] === patch) continue;
    const pre = renderDiff(patch);
    if (diff.children[index]) diff.children[index].replaceWith(pre); else diff.append(pre);
  }
  while (diff.children.length > patches.length) diff.lastElementChild.remove();
  entry.renderedDiffs = patches;
  diff.setAttribute('aria-label', `Changes in ${file.path}`);
  body.lastElementChild.disabled = file.kind === 'delete';
  diff.scrollTop = top; diff.scrollLeft = left;
}
function renderFileSummary(turnId) {
  if (!turnId) return;
  let card = [...$('messages').querySelectorAll('.changed-files')].find(element => element.dataset.turnId === turnId);
  const files = new Map();
  const records = [...state.items.values()].filter(record => record.turnId === turnId && record.item.type === 'fileChange' && record.item.status === 'completed')
    .sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  for (const record of records) {
    for (const [index, change] of (record.item.changes || []).entries()) {
      if (typeof change.path !== 'string') continue;
      const path = change.kind?.move_path || change.path;
      const file = files.get(change.path) || files.get(path) || { id: JSON.stringify([record.item.id, index]), added: 0, removed: 0, diffs: [], kind: change.kind?.type };
      if (change.kind?.move_path) files.delete(change.path);
      file.path = path;
      if (change.kind?.type === 'delete' || change.kind?.type === 'add') file.kind = change.kind.type;
      else if (change.kind?.move_path) file.kind = 'rename';
      let diff = typeof change.diff === 'string' ? change.diff.replace(/\r\n/g, '\n') : '';
      if (diff && ['add', 'delete'].includes(change.kind?.type)) {
        const lines = diff.replace(/\n$/, '').split('\n'); const added = change.kind.type === 'add';
        diff = `@@ ${added ? '-0,0 +1,' : '-1,'}${lines.length}${added ? '' : ' +0,0'} @@\n` + lines.map(line => (added ? '+' : '-') + line).join('\n');
      }
      let hunk = false;
      for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) hunk = true;
        if (line.startsWith('diff --git ')) hunk = false;
        if (line.startsWith('+') && (hunk || !line.startsWith('+++'))) file.added++;
        if (line.startsWith('-') && (hunk || !line.startsWith('---'))) file.removed++;
      }
      if (diff) file.diffs.push(diff);
      files.set(path, file);
    }
  }
  if (!files.size) { card?.remove(); return; }
  if (!card) {
    card = document.createElement('details'); card.className = 'changed-files'; card.dataset.turnId = turnId; card.open = true;
    card.append(document.createElement('summary'), document.createElement('div')); $('messages').append(card);
  }
  const counts = (added, removed) => {
    const span = document.createElement('span'); span.className = 'change-counts'; span.title = 'Lines added and removed by recorded edits';
    const plus = document.createElement('span'); plus.className = 'diff-added'; plus.textContent = `+${added}`;
    const minus = document.createElement('span'); minus.className = 'diff-removed'; minus.textContent = `−${removed}`;
    span.append(plus, minus); return span;
  };
  card.firstElementChild.replaceChildren(document.createTextNode(`${files.size} file${files.size === 1 ? '' : 's'} changed`), counts([...files.values()].reduce((sum, file) => sum + file.added, 0), [...files.values()].reduce((sum, file) => sum + file.removed, 0)));
  const rows = card.lastElementChild;
  const entries = new Map([...rows.children].map(entry => [entry.dataset.fileId, entry]));
  let next = rows.firstElementChild;
  const context = { machine: accessKey(), cwd: state.thread?.cwd || $('workspace').value };
  for (const file of files.values()) {
    let entry = entries.get(file.id);
    entries.delete(file.id);
    if (!entry) {
      entry = document.createElement('details'); entry.className = 'changed-file-entry'; entry.dataset.fileId = file.id;
      const summary = document.createElement('summary'); summary.className = 'changed-file'; entry.append(summary);
      entry.ontoggle = () => { if (entry.open) updateFileDiff(entry, context); };
    }
    entry.file = file; entry.dataset.path = file.path;
    const fileSummary = entry.firstElementChild; fileSummary.title = file.path;
    const name = document.createElement('span'); name.className = 'changed-file-name';
    const prefix = (context.cwd || '').replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const path = file.path.replace(/\\/g, '/'); name.textContent = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const kind = document.createElement('small'); kind.textContent = file.kind === 'add' ? 'Added' : file.kind === 'delete' ? 'Deleted' : file.kind === 'rename' ? 'Renamed' : 'Modified';
    fileSummary.replaceChildren(name, kind, counts(file.added, file.removed));
    if (entry !== next) {
      if (entry.parentNode === rows) moveDiffElement(rows, entry, next); else rows.insertBefore(entry, next);
    }
    next = entry.nextElementSibling;
    if (entry.open) updateFileDiff(entry, context);
  }
  for (const entry of entries.values()) entry.remove();
}
function renderItem(item, prepend = false, turnId = null) {
  if (!item?.id) return;
  let record = state.items.get(item.id);
  const isMessage = ['userMessage', 'agentMessage', 'plan', 'exitedReviewMode', 'imageView', 'imageGeneration'].includes(item.type);
  if (!isMessage && !['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'reasoning', 'webSearch', 'collabAgentToolCall', 'functionCallOutput'].includes(item.type)) return;
  if (!record) {
    const element = document.createElement(isMessage ? 'article' : 'details');
    element.className = isMessage ? `message ${item.type}` : 'tool';
    const label = document.createElement(isMessage ? 'div' : 'summary');
    label.className = 'message-label';
    const body = document.createElement(isMessage ? 'div' : 'pre');
    body.className = 'message-body';
    element.append(label, body);
    record = { element, label, body, item };
    state.items.set(item.id, record);
    if (isMessage) {
      if (prepend) $('messages').prepend(element); else $('messages').append(element);
    } else {
      let neighbor = $('messages')[prepend ? 'firstElementChild' : 'lastElementChild'];
      if (neighbor?.classList.contains('changed-files')) neighbor = neighbor[prepend ? 'nextElementSibling' : 'previousElementSibling'];
      let group = neighbor?.classList.contains('activity-log') && neighbor.dataset.turnId === (turnId || '') ? neighbor : null;
      if (!group) {
        group = document.createElement('details'); group.className = 'activity-log'; group.dataset.turnId = turnId || '';
        const summary = document.createElement('summary'); summary.title = 'Show or hide full activity log';
        const entries = document.createElement('div'); entries.className = 'activity-items';
        group.append(summary, entries);
        if (prepend) $('messages').prepend(group); else $('messages').append(group);
      }
      group.lastElementChild[prepend ? 'prepend' : 'append'](element);
      record.group = group;
    }
  }
  record.item = { ...record.item, ...item };
  if (turnId) { record.turnId = turnId; record.element.dataset.turnId = turnId; }
  item = record.item;
  if (item.type === 'userMessage') {
    record.label.textContent = 'You';
    if (record.turnId) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit-message'; edit.textContent = 'Edit & resend';
      edit.dataset.turnId = record.turnId;
      edit.onclick = () => openMessageEdit(record);
      record.label.append(edit);
    }
    record.body.replaceChildren();
    for (const part of item.content || []) {
      if (part.type === 'text') record.body.append(document.createTextNode(part.text));
      else if (part.type === 'image' || part.type === 'localImage') record.body.append(messageImage(part.url || part.path, 'Attached image'));
    }
  } else if (isMessage) {
    record.label.replaceChildren();
    const mark = document.createElement('span');
    mark.className = 'mini-mark'; mark.textContent = '›_';
    record.label.append(mark, document.createTextNode(item.type === 'plan' ? 'Plan' : 'Codex'));
    if (item.type === 'imageView' || item.type === 'imageGeneration') {
      record.body.replaceChildren();
      const source = item.path || item.savedPath || (item.result ? `data:image/png;base64,${item.result}` : null);
      if (source) record.body.append(messageImage(source, item.type === 'imageView' ? 'Image preview' : 'Generated image'));
      else record.body.textContent = item.failure?.message || (item.status === 'inProgress' ? 'Generating image…' : 'Image is unavailable.');
    } else markdown(record.body, item.type === 'exitedReviewMode' ? item.review : item.text);
  } else if (item.type === 'commandExecution') {
    const command = item.command || 'Command';
    record.label.textContent = `${item.status === 'inProgress' ? '◌' : item.exitCode ? '×' : '✓'} ${command.split(/\r?\n/)[0]}`;
    record.label.title = 'Expand command and output';
    record.body.textContent = command + '\n\n' + (item.aggregatedOutput || (isLocal() ? 'Running locally…' : 'Running on the server…'));
  } else if (item.type === 'fileChange') {
    record.label.textContent = `Files · ${item.status || 'Updating'}`;
    record.body.textContent = item.changes?.map(change => `${change.path}\n${change.diff || ''}`).join('\n\n') || '';
  } else if (item.type === 'reasoning') {
    record.label.textContent = 'Thinking';
    record.body.textContent = (item.summary || []).join('\n');
  } else {
    record.label.textContent = item.type === 'functionCallOutput' ? `${item.namespace || ''} ${item.name || 'Tool result'}` : `${item.server || ''} ${item.tool || item.type} · ${item.status || ''}`;
    const output = item.result || item.output || item.contentItems || item.arguments || item;
    const content = Array.isArray(output) ? output : output.content || [];
    const images = Array.isArray(content) ? content.filter(part => ['image', 'input_image', 'inputImage'].includes(part.type)) : [];
    record.body.textContent = JSON.stringify(output, (key, value) => value && ['image', 'input_image', 'inputImage'].includes(value.type) ? { type: value.type, image: '[Image data]' } : value, 2);
    for (const part of images) record.body.append(messageImage(part.image_url || part.imageUrl || part.url || (part.data ? `data:${part.mimeType};base64,${part.data}` : null), 'Tool image'));
    if (images.length && !record.hasImages) {
      record.element.open = true;
      record.group.open = true;
      record.hasImages = true;
    }
  }
  if (record.group) record.group.firstElementChild.textContent = record.group.lastElementChild.lastElementChild.firstElementChild.textContent;
  if (item.type === 'fileChange') renderFileSummary(record.turnId);
  const card = [...$('messages').querySelectorAll('.changed-files')].find(element => element.dataset.turnId === record.turnId);
  const last = [...$('messages').children].findLast(element => element !== card && element.dataset.turnId === record.turnId);
  if (card && last && last.nextElementSibling !== card) moveDiffElement($('messages'), card, last.nextElementSibling);
  return record;
}

function renderImages() {
  $('attachments').replaceChildren();
  $('attachments').hidden = !state.images.length;
  for (const entry of state.images) {
    const card = document.createElement('div'); card.className = 'attachment';
    if (entry.url) {
      const image = document.createElement('img'); image.src = entry.url; image.alt = entry.name; card.append(image);
    }
    const label = document.createElement('span'); label.textContent = entry.url ? entry.name : 'Reading…'; card.append(label);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${entry.name}`);
    remove.onclick = () => { if (state.sending) return; state.images = state.images.filter(image => image !== entry); renderImages(); updateBusy(); };
    card.append(remove); $('attachments').append(card);
  }
  saveComposerDraft();
}
function addImages(files) {
  if (state.sending || state.loading) return;
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { showError('Choose PNG, JPEG, WebP, or GIF images.'); continue; }
    if (!file.size || state.images.length >= 10 || file.size + state.images.reduce((total, image) => total + image.size, 0) > 20 * 1024 * 1024) { showError('Attach up to 10 images, 20 MB total.'); continue; }
    const entry = { name: file.name, size: file.size, url: null };
    state.images.push(entry); renderImages(); updateBusy();
    const reader = new FileReader();
    reader.onload = () => { if (state.images.includes(entry)) { entry.url = reader.result; renderImages(); updateBusy(); } };
    reader.onerror = () => { if (state.images.includes(entry)) { state.images = state.images.filter(image => image !== entry); renderImages(); updateBusy(); showError(`Could not read ${file.name}.`); } };
    reader.readAsDataURL(file);
  }
}

function hideSlash() {
  $('slash-menu').hidden = true; $('prompt').setAttribute('aria-expanded', 'false'); $('prompt').removeAttribute('aria-activedescendant');
  slash.dismissed = $('prompt').value; slash.skillOnly = false;
}
async function loadSkills(force = false) {
  if (!state.connected) return;
  const cwd = state.thread?.cwd || $('workspace').value.trim();
  if (!force && slash.cwd === cwd) return;
  const generation = ++slash.generation;
  const options = state.options;
  slash.cwd = cwd; slash.loading = true; slash.skills = [];
  try {
    const result = await rpc('skills/list', { cwds: [cwd], forceReload: force });
    if (generation !== slash.generation || options !== state.options) return;
    slash.skills = (result.data || []).flatMap(entry => entry.skills || []).filter(skill => skill.enabled !== false && typeof skill.path === 'string');
  } catch (error) {
    if (generation === slash.generation && options === state.options) { slash.cwd = null; showError(error); }
  } finally {
    if (generation === slash.generation) { slash.loading = false; updateSlash(false); }
  }
}
function updateSlash(fetchSkills = true) {
  const match = $('prompt').value.match(/^\/([\w:.-]*)$/);
  if (!match || slash.dismissed === $('prompt').value) { hideSlash(); return; }
  if (fetchSkills) loadSkills().catch(showError);
  const query = match[1].toLowerCase();
  const commands = slash.skillOnly ? [] : slashCommands.filter(command => command.name.includes(query));
  const skills = slash.skills.filter(skill => skill.name.toLowerCase().includes(query)).map(skill => ({ name: skill.name, description: skill.interface?.shortDescription || skill.description || 'Use this skill', skill }));
  slash.matches = [...commands, ...skills];
  slash.index = Math.max(0, Math.min(slash.index, slash.matches.length - 1));
  const menu = $('slash-menu'); menu.replaceChildren();
  const group = label => { const heading = document.createElement('div'); heading.className = 'slash-heading'; heading.textContent = label; menu.append(heading); };
  for (let index = 0; index < slash.matches.length; index++) {
    if (index === 0 && commands.length) group('Commands');
    if (index === commands.length && skills.length) group('Skills');
    const entry = slash.matches[index];
    const button = document.createElement('button'); button.type = 'button'; button.className = 'slash-option'; button.id = 'slash-option-' + index;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === slash.index));
    const name = document.createElement('strong'); name.textContent = (entry.skill ? '$' : '/') + entry.name;
    const description = document.createElement('small'); description.textContent = entry.description;
    button.append(name, description);
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => chooseSlash(entry).catch(showError);
    menu.append(button);
  }
  if (!slash.matches.length) {
    const empty = document.createElement('div'); empty.className = 'slash-empty'; empty.textContent = slash.loading ? 'Loading skills…' : 'No matching commands or skills'; menu.append(empty);
  }
  menu.hidden = false; $('prompt').setAttribute('aria-expanded', 'true');
  if (slash.matches.length) $('prompt').setAttribute('aria-activedescendant', 'slash-option-' + slash.index);
  else $('prompt').removeAttribute('aria-activedescendant');
}
async function chooseSlash(entry) {
  if (!entry) return;
  if (entry.skill) { $('prompt').value = '$' + entry.name + ' '; hideSlash(); $('prompt').focus(); return; }
  await executeSlash('/' + entry.name);
}
function promptKeydown(event) {
  if (event.isComposing) return;
  if (!$('slash-menu').hidden) {
    if (event.key === 'Escape') { event.preventDefault(); hideSlash(); slash.skillOnly = false; return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && slash.matches.length) {
      event.preventDefault(); slash.index = (slash.index + (event.key === 'ArrowDown' ? 1 : -1) + slash.matches.length) % slash.matches.length;
      updateSlash(false); document.getElementById('slash-option-' + slash.index)?.scrollIntoView({ block: 'nearest' }); return;
    }
    if (((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') && slash.matches.length) { event.preventDefault(); chooseSlash(slash.matches[slash.index]).catch(showError); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
}
function selectControl(id, value = '') {
  const control = $(id);
  if (control.disabled) throw new Error('Change this setting after the current turn finishes.');
  if (value) {
    const option = [...control.options].find(option => option.value === value || option.textContent.toLowerCase() === value.toLowerCase());
    if (!option) throw new Error('Choose one of the available options.');
    control.value = option.value; control.dispatchEvent(new Event('change')); return;
  }
  control.focus();
  try { control.showPicker(); } catch {}
}
function skillInputs(text, existing = [], cwd = state.thread?.cwd || $('workspace').value.trim()) {
  const available = slash.cwd === cwd ? slash.skills : [];
  return [...new Map([...existing, ...available].map(skill => [skill.path, skill])).values()].filter(skill => text.split(/\s+/).includes('$' + skill.name)).map(skill => ({ type: 'skill', name: skill.name, path: skill.path }));
}
function collaborationParams(message) {
  if (!modes.catalog.length) return {};
  const preset = modes.catalog.find(entry => entry.mode === message.mode);
  const model = message.model || message.thread.model || state.models.find(model => model.isDefault)?.model;
  if (!preset || !model) throw new Error('Select a model before using Plan mode.');
  return { collaborationMode: { mode: message.mode, settings: { model, reasoning_effort: message.effort || preset.reasoning_effort || null, developer_instructions: null } } };
}
function showCommandInfo(title, text) {
  $('command-title').textContent = title; $('command-info').textContent = text;
  if (!$('command-dialog').open) $('command-dialog').showModal();
}
async function executeSlash(value) {
  if (state.sending || state.commandBusy || state.loading) return;
  const match = value.match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i);
  if (!match) { slash.dismissed = null; updateSlash(); return; }
  const command = match[1].toLowerCase(); const args = match[2]?.trim() || '';
  if (!slashCommands.some(entry => entry.name === command)) { showError('Unknown command. Type / to see available commands.'); return; }
  state.commandBusy = true; hideSlash(); $('prompt').value = ''; updateBusy();
  try {
    if (command === 'new') { resetThread(); $('prompt').value = args; }
    else if (command === 'model') selectControl('model', args);
    else if (command === 'reasoning') selectControl('effort', args);
    else if (command === 'permissions') selectControl('permissions', ({ full: 'danger-full-access', workspace: 'workspace-write', read: 'read-only' })[args] || args);
    else if (command === 'project') await openProjectPicker();
    else if (command === 'rename') {
      if (!state.thread) throw new Error('Open a conversation to rename it.');
      state.contextThread = state.thread; openRename();
    } else if (command === 'status') {
      showCommandInfo('Conversation status', `Machine: ${isLocal() ? 'This machine' : state.options.host}\nProject: ${state.thread?.cwd || $('workspace').value}\nModel: ${$('model').selectedOptions[0]?.textContent}\nReasoning: ${$('effort').selectedOptions[0]?.textContent}\nAccess: ${$('permissions').selectedOptions[0]?.textContent}\nMode: ${modes.plan ? 'Plan' : 'Default'}\nConversation: ${state.thread?.id || 'New conversation'}\nQueued: ${state.queues.get(queueKey(state.thread?.id))?.messages.length || 0}`);
    } else if (command === 'skills') {
      await loadSkills(true); slash.skillOnly = true; slash.dismissed = null; $('prompt').value = '/'; updateSlash(false);
    } else if (command === 'plan') {
      if (!state.connected) throw new Error('Connect to Codex first.');
      if (!modes.catalog.length) modes.catalog = (await rpc('collaborationMode/list')).data;
      if (!modes.catalog.some(entry => entry.mode === 'plan')) throw new Error('Plan mode is unavailable on this machine.');
      modes.plan = args === 'off' ? false : args ? true : !modes.plan;
      if (state.thread) modes.threads.set(state.thread.id, modes.plan);
      if (args && !['on', 'off'].includes(args)) { $('prompt').value = args; await send(null, false, {}); }
    } else if (command === 'compact') {
      if (!state.thread) throw new Error('Open a conversation to compact it.');
      await ensureWritable(state.thread.id);
      if (state.active.has(state.thread.id)) throw new Error('Finish or stop the running turn before compacting.');
      await rpc('thread/compact/start', { threadId: state.thread.id });
    } else if (command === 'review') {
      if (state.images.length) throw new Error('Remove attachments before starting a review.');
      if (args) throw new Error('Use /review without arguments to review uncommitted changes.');
      if (state.thread) await ensureWritable(state.thread.id);
      if (state.active.has(state.thread?.id)) throw new Error('Finish or stop the running turn before starting a review.');
      $('prompt').value = 'Review uncommitted changes'; await send(null, false, { review: true });
    } else if (command === 'init') {
      $('prompt').value = 'Inspect this project and create an AGENTS.md with concise guidance for coding agents. Preserve any useful existing instructions.'; await send(null, false, {});
    } else if (command === 'mcp') {
      const servers = []; let cursor = null;
      do { const result = await rpc('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly', ...(state.thread ? { threadId: state.thread.id } : {}) }); servers.push(...result.data); cursor = result.nextCursor; } while (cursor);
      showCommandInfo('MCP servers', servers.map(server => `${server.name} · ${server.authStatus}\n${Object.keys(server.tools || {}).length} tools`).join('\n\n') || 'No MCP servers configured.');
    }
  } catch (error) { if (!$('prompt').value) $('prompt').value = value; showError(error); }
  finally { state.commandBusy = false; updateBusy(); }
}
function editQueuedMessage(queue, message) {
  if (state.dispatching.has(queue.key) || queue.saving || queueLocked(queue)) return;
  if (!message.draftId) { message.draftId = crypto.randomUUID(); api.saveQueue({ key: queue.key, machine: queue.machine, thread: queue.thread, messages: queue.messages, paused: queue.paused }).catch(showError); }
  const draftTarget = editorTarget('edit-queue', queue.thread, message.draftId);
  state.queueEdit = { queue, message, draftTarget }; queue.editing = true;
  $('queued-text').value = editorText(draftTarget, message.text);
  $('queued-attachments').textContent = message.images.length ? message.images.map(image => image.name).join(', ') : '';
  $('edit-queue-dialog').showModal(); $('queued-text').focus();
}
$('edit-queue-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.queueEdit; const text = $('queued-text').value.trim();
  if (!target || target.queue.saving || (!text && !target.message.images.length)) return;
  const previous = { text: target.message.text, input: target.message.input };
  target.message.text = text;
  target.message.input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...target.message.input.filter(part => part.type !== 'text' && part.type !== 'skill'), ...skillInputs(text, target.message.input.filter(part => part.type === 'skill'), target.queue.thread.cwd)];
  try { await persistQueue(target.queue); clearDraft(target.draftTarget); target.queue.editing = false; $('edit-queue-dialog').close(); renderQueue(); if (target.queue.machine === accessKey()) await flushQueue(target.queue.thread.id); }
  catch (error) { Object.assign(target.message, previous); showError(error); }
};
$('cancel-queue-edit').onclick = () => { clearDraft(state.queueEdit?.draftTarget); $('edit-queue-dialog').close(); };
$('edit-queue-dialog').oncancel = () => clearDraft(state.queueEdit?.draftTarget);
$('queued-text').oninput = () => saveEditorDraft(state.queueEdit?.draftTarget, $('queued-text').value);
$('edit-queue-dialog').onclose = () => {
  const target = state.queueEdit; state.queueEdit = null;
  if (target) { target.queue.editing = false; if (target.queue.machine === accessKey()) flushQueue(target.queue.thread.id).catch(showError); }
};
$('close-command-dialog').onclick = () => $('command-dialog').close();

function policy() {
  const sandbox = $('permissions').value;
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw new Error('Choose a valid access mode.');
  return { approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request', sandbox };
}
async function refreshSchedules() {
  if (!api.scheduledTasks) return;
  const generation = ++schedules.generation;
  const tasks = await api.scheduledTasks();
  if (generation !== schedules.generation) return;
  schedules.tasks = tasks; renderSchedules(); renderThreadIndicators();
}
function scheduledFor(threadId) {
  return schedules.tasks.filter(task => (task.machine || 'access:local') === accessKey() && task.threadId === threadId && ['pending', 'sending', 'unconfirmed'].includes(task.status)).sort((a, b) => a.runAt.localeCompare(b.runAt));
}
function renderSchedules() {
  const container = $('scheduled-messages');
  container.replaceChildren();
  const tasks = state.thread ? scheduledFor(state.thread.id) : [];
  container.hidden = !tasks.length;
  for (const task of tasks) {
    const row = document.createElement('div'); row.className = 'scheduled-message';
    const label = document.createElement('span'); label.className = 'scheduled-copy';
    const date = new Date(task.runAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const status = task.status === 'sending' ? 'Sending scheduled message' : task.status === 'unconfirmed' ? 'Unconfirmed; check history' : `Scheduled · ${date}`;
    label.textContent = `${status} · ${task.prompt}`;
    label.title = `${new Date(task.runAt).toLocaleString()}\n${task.prompt}${task.error ? '\n' + task.error : ''}`;
    row.append(label);
    if (task.status === 'pending') {
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'subtle'; cancel.textContent = '×';
      cancel.title = 'Cancel scheduled message'; cancel.setAttribute('aria-label', cancel.title);
      cancel.onclick = async () => {
        cancel.disabled = true;
        try { await api.cancelScheduledTask(task.id); await refreshSchedules(); }
        catch (error) { showError(error); renderSchedules(); }
      };
      row.append(cancel);
    }
    container.append(row);
  }
}
function queueKey(threadId) { return accessKey() + ':' + threadId; }
async function persistQueue(queue) {
  queue.saving = (queue.saving || 0) + 1; renderQueue();
  try { await api.saveQueue({ key: queue.key, machine: queue.machine, thread: queue.thread, messages: queue.messages, paused: queue.paused }); }
  catch (error) { trace('queue.save.failed', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, error: error.message }); queue.paused = true; renderQueue(); throw new Error(`Could not save queued messages: ${error.message}`); }
  finally { queue.saving--; renderQueue(); }
}
async function restoreQueues() {
  const saved = await api.queues();
  for (const queue of saved) {
    let changed = false;
    for (const message of queue.messages) if (!message.draftId) { message.draftId = crypto.randomUUID(); changed = true; }
    queue.paused = true;
    if (changed) await api.saveQueue(queue);
    state.queues.set(queue.key, { ...queue, editing: false }); trace('queue.restored', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, paused: true });
  }
}
function pauseQueue(queue, reason = 'requested') { trace('queue.paused', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, reason }); queue.paused = true; queue.retry = null; return persistQueue(queue); }
function pauseQueues(reason = 'reconnect') {
  for (const queue of state.queues.values()) if (queue.machine === accessKey() && queue.messages.length) pauseQueue(queue, reason).catch(showError);
}
async function retryQueue(queue) {
  if (queueLocked(queue)) return;
  trace('queue.retry', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length });
  const retry = {}; queue.retry = retry;
  await ensureWritable(queue.thread.id);
  if (queue.retry !== retry || !state.connected || queue.machine !== accessKey()) return;
  queue.paused = false; await persistQueue(queue); renderQueue(); await flushQueue(queue.thread.id);
}
function renderQueue() {
  const queue = state.queues.get(queueKey(state.thread?.id));
  if (queueDrag.source) {
    if (queueDrag.source.queue === queue && queueDrag.source.options === state.options && queueDrag.source.selection === state.selection) return;
    clearQueueDrag(); return;
  }
  $('queued-messages').replaceChildren();
  $('queued-messages').hidden = !queue?.messages.length;
  for (const message of queue?.messages || []) {
    const row = document.createElement('div'); row.className = 'queued-message';
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'queue-drag-handle';
    handle.title = 'Drag to reorder queued message'; handle.setAttribute('aria-label', handle.title);
    handle.disabled = queue.messages.length < 2 || state.sending || state.loading || state.dispatching.has(queue.key) || queue.saving || queue.editing || queue.reordering;
    handle.draggable = !handle.disabled;
    handle.innerHTML = '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="8" cy="12" r="1"/></svg>';
    handle.ondragstart = event => {
      if (handle.disabled || !event.dataTransfer || queueLocked(queue) || state.queues.get(queue.key) !== queue) { event.preventDefault(); return; }
      clearThreadDrag(); clearProjectDrag();
      queueDrag.source = { queue, message, options: state.options, selection: state.selection, token: crypto.randomUUID() };
      queue.dragging = true;
      event.dataTransfer.setData(queueDrag.type, queueDrag.source.token); event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setDragImage(row, 12, row.getBoundingClientRect().height / 2);
      row.classList.add('queue-dragging'); updateBusy();
    };
    handle.ondragend = () => clearQueueDrag();
    bindQueueDrop(row, queue, message); row.append(handle);
    const label = document.createElement('button'); label.type = 'button'; label.className = 'queued-copy';
    label.title = 'Edit queued message';
    label.disabled = state.dispatching.has(queue.key) || Boolean(queue.saving) || queueLocked(queue);
    label.onclick = () => editQueuedMessage(queue, message);
    label.textContent = (queue.paused ? 'Waiting · ' : 'Queued · ') + (message.text || `${message.images.length} image(s)`);
    row.append(label);
    const action = (text, run) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle'; button.textContent = text;
      button.disabled = state.sending || state.dispatching.has(queue.key) || Boolean(queue.saving) || queueLocked(queue) || !state.connected;
      button.onclick = () => { if (!queueLocked(queue)) return run().catch(showError); }; row.append(button);
    };
    action('Edit', async () => editQueuedMessage(queue, message));
    if (state.owned.has(queue.thread.id) && state.active.has(queue.thread.id)) action('Steer', async () => { await sendQueued(queue, message, true); await flushQueue(queue.thread.id); });
    else if (queue.paused) action('Retry', async () => retryQueue(queue));
    action('×', async () => { const previous = queue.messages; queue.messages = queue.messages.filter(entry => entry !== message); try { await persistQueue(queue); } catch (error) { queue.messages = previous; throw error; } finally { renderQueue(); } });
    row.lastChild.setAttribute('aria-label', 'Remove queued message');
    $('queued-messages').append(row);
  }
}
function queueLocked(queue) { return Boolean(queue?.dragging || queue?.reordering); }
function clearQueueDrag(resume = true) {
  const source = queueDrag.source;
  if (!source) return;
  queueDrag.source = null; source.queue.dragging = false;
  for (const row of $('queued-messages').querySelectorAll('.queue-dragging,.queue-drop-before,.queue-drop-after')) row.classList.remove('queue-dragging', 'queue-drop-before', 'queue-drop-after');
  updateBusy();
  if (resume && source.queue.machine === accessKey()) flushQueue(source.queue.thread.id).catch(showError);
}
function bindQueueDrop(row, queue, message) {
  const valid = event => {
    const source = queueDrag.source;
    return source && source.queue === queue && source.message !== message && source.options === state.options && source.selection === state.selection && queue.machine === accessKey() && state.queues.get(queue.key) === queue && queue.messages.includes(source.message) && queue.messages.includes(message) && !queue.saving && !queue.editing && !queue.reordering && !state.dispatching.has(queue.key) && event.dataTransfer?.types.includes(queueDrag.type);
  };
  const below = event => event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  row.ondragover = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    for (const item of $('queued-messages').querySelectorAll('.queue-drop-before,.queue-drop-after')) item.classList.remove('queue-drop-before', 'queue-drop-after');
    row.classList.add(below(event) ? 'queue-drop-after' : 'queue-drop-before');
  };
  row.ondragleave = event => { if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget)) row.classList.remove('queue-drop-before', 'queue-drop-after'); };
  row.ondrop = async event => {
    if (!valid(event) || event.dataTransfer.getData(queueDrag.type) !== queueDrag.source.token) return;
    event.preventDefault(); event.stopPropagation();
    const source = queueDrag.source;
    try { await reorderQueuedMessage(queue, source.message, message, below(event), source.options); }
    catch (error) { if (source.options === state.options) showError(error); }
    finally { if (queueDrag.source === source) clearQueueDrag(); }
  };
}
async function reorderQueuedMessage(queue, source, target, after, options = state.options) {
  if (options !== state.options || state.queues.get(queue.key) !== queue || queue.machine !== accessKey() || queue.reordering || queue.editing || queue.saving || state.dispatching.has(queue.key) || !queue.messages.includes(source) || !queue.messages.includes(target) || source === target) return;
  const previous = queue.messages; const next = previous.filter(message => message !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  if (previous.every((message, index) => next[index] === message)) return;
  queue.reordering = true; clearQueueDrag(false); queue.messages = next;
  try { await persistQueue(queue); }
  catch (error) { queue.messages = previous; throw error; }
  finally { queue.reordering = false; updateBusy(); }
  if (options === state.options) await flushQueue(queue.thread.id);
}
function turnSettings(message) {
  return {
    threadId: message.thread.id, ...collaborationParams(message),
    ...(message.model ? { model: message.model } : {}), ...(message.effort ? { effort: message.effort } : {}),
    approvalPolicy: message.access.approvalPolicy,
    sandboxPolicy: message.access.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [message.thread.cwd], networkAccess: true } : { type: message.access.sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess' }
  };
}
async function ensureWritable(threadId) {
  if (state.owned.has(threadId)) { state.writerConflicts.delete(queueKey(threadId)); return; }
  if (state.resuming.has(threadId)) return state.resuming.get(threadId);
  const options = state.options;
  const key = queueKey(threadId);
  const pending = (async () => {
    try {
      const result = await rpc('thread/resume', { threadId, excludeTurns: true });
      if (state.options !== options || !state.connected) throw new Error('Connection changed before the conversation was ready.');
      state.owned.add(threadId); state.writerConflicts.delete(key);
      if (result.thread.status?.type !== 'active') state.active.delete(threadId);
      else if (!state.active.has(threadId)) {
        const history = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
        if (state.options === options) {
          const turn = history.data.find(turn => turn.status === 'inProgress');
          if (turn && !state.finished.has(turn.id)) state.active.set(threadId, turn.id);
        }
      }
    } catch (error) {
      if (state.options === options && isWriterConflict(error)) state.writerConflicts.add(key);
      throw error;
    }
  })().finally(() => { if (state.resuming.get(threadId) === pending) state.resuming.delete(threadId); });
  state.resuming.set(threadId, pending);
  return pending;
}

async function submitMessage(message, steer = false) {
  const key = message.machine + ':' + message.thread.id;
  if (state.dispatching.has(key)) throw new Error('A message is already being sent.');
  const turnId = state.active.get(message.thread.id);
  if (steer && !turnId) throw new Error('This turn finished. Send the message as a follow-up.');
  if (accessKey() === message.machine) setCompletion(message.thread.id);
  state.dispatching.add(key); updateBusy();
  trace('message.dispatch', { machine: message.machine, threadId: message.thread.id, turnId, steer, owned: state.owned.has(message.thread.id) });
  const visible = () => accessKey() === message.machine && state.thread?.id === message.thread.id;
  const temporary = 'pending-' + crypto.randomUUID();
  if (visible()) { renderItem({ type: 'userMessage', id: temporary, content: message.input }); scrollToBottom(true); }
  try {
    if (!state.owned.has(message.thread.id)) await ensureWritable(message.thread.id);
    if (steer) await rpc('turn/steer', { threadId: message.thread.id, input: message.input, expectedTurnId: turnId });
    else {
      const settings = turnSettings(message);
      if (message.review) await rpc('thread/settings/update', settings);
      const result = message.review ? await rpc('review/start', { threadId: message.thread.id, target: { type: 'uncommittedChanges' }, delivery: 'inline' }) : await rpc('turn/start', { ...settings, input: message.input });
      if (accessKey() === message.machine && result.turn.status === 'inProgress' && !state.finished.has(result.turn.id)) state.active.set(message.thread.id, result.turn.id);
    }
    if (accessKey() === message.machine) { state.newThreads.delete(message.thread.id); requestTitle({ ...message.thread, preview: message.text }); }
    trace('message.accepted', { machine: message.machine, threadId: message.thread.id, steer });
  } catch (error) {
    trace('message.failed', { machine: message.machine, threadId: message.thread.id, steer, error: error.message });
    if (visible()) { state.items.get(temporary)?.element.remove(); state.items.delete(temporary); }
    throw error;
  } finally { state.dispatching.delete(key); updateBusy(); }
}
async function sendQueued(queue, message, steer = false) {
  const ready = () => state.connected && accessKey() === queue.machine && state.queues.get(queue.key) === queue && (steer ? queue.messages.includes(message) : queue.messages[0] === message) && !state.sending && !state.dispatching.has(queue.key) && !queue.saving && !queueLocked(queue) && (steer || !queue.paused && !queue.editing && !state.active.has(queue.thread.id));
  const deferred = phase => trace('queue.deferred', { machine: queue.machine, threadId: queue.thread.id, phase, connected: state.connected, working: state.active.has(queue.thread.id), paused: queue.paused, queueLength: queue.messages.length });
  if (!ready()) return;
  try {
    await persistQueue(queue);
    if (!ready()) { deferred('after-save'); return; }
    if (!state.owned.has(queue.thread.id)) await ensureWritable(queue.thread.id);
    if (!ready()) { deferred('after-resume'); return; }
    await submitMessage(message, steer);
    queue.messages = queue.messages.filter(entry => entry !== message);
    await persistQueue(queue);
  } catch (error) {
    trace('queue.failed', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, error: error.message });
    await pauseQueue(queue, 'send-failed').catch(showError);
    showError(`Queued message was not confirmed: ${error.message} Check history before retrying.`);
  }
  renderQueue();
}
async function flushQueue(threadId) {
  const queue = state.queues.get(queueKey(threadId));
  if (!queue || queue.paused || queue.editing || queue.saving || queueLocked(queue) || !state.connected || state.sending || state.dispatching.has(queue.key) || state.active.has(threadId) || (state.loading && state.thread?.id === threadId)) return;
  const message = queue.messages[0];
  if (!message) return;
  await sendQueued(queue, message);
  if (!queue.paused && queue.messages.length && !state.active.has(threadId)) await flushQueue(threadId);
}
function shortcutUnavailable(shortcut) {
  if (shortcut?.mode === 'fill') return state.connecting || state.sending || state.loading || state.commandBusy || drafts.suspended;
  return !state.connected || state.connecting || state.sending || state.loading || state.commandBusy || state.images.some(image => !image.url) || queueLocked(state.queues.get(queueKey(state.thread?.id)));
}
function promptSkillNames(text) { return [...new Set(text.split(/\s+/).filter(token => /^\$[a-zA-Z_][\w:.-]*$/.test(token)).map(token => token.slice(1)))]; }
async function resolvePromptSkills(text, required = false) {
  const names = promptSkillNames(text);
  if (!names.length) return [];
  const cwd = state.thread?.cwd || $('workspace').value.trim();
  const result = await rpc('skills/list', { cwds: [cwd], forceReload: false });
  const skills = (result.data || []).flatMap(entry => entry.skills || []).filter(skill => skill.enabled !== false && typeof skill.path === 'string');
  if (required) for (const name of names) if (!skills.some(skill => skill.name === name)) throw new Error(`Skill $${name} is unavailable in this conversation.`);
  return skills;
}
async function runShortcut(shortcut) {
  if (shortcutUnavailable(shortcut)) return;
  if (shortcut.mode === 'fill') {
    const prompt = $('prompt');
    prompt.value += (prompt.value && !/\s$/.test(prompt.value) ? '\n' : '') + shortcut.prompt;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus(); prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    return;
  }
  const options = state.options; const selection = state.selection;
  let skills = [];
  state.sending = true; updateBusy();
  try { skills = await resolvePromptSkills(shortcut.prompt, true); }
  catch (error) { showError(error); return; }
  finally { state.sending = false; updateBusy(); }
  if (options === state.options && selection === state.selection && state.connected) await send(null, false, { shortcut: shortcut.prompt, skills });
}
const defaultShortcuts = [{ id: 'review', label: 'Review', prompt: '$cr ur changes' }];
function promptShortcuts() { return preferences.shortcuts ?? defaultShortcuts; }
function editShortcut(shortcut = null) {
  state.shortcutEdit = shortcut;
  $('shortcut-label').value = shortcut?.label || ''; $('shortcut-prompt').value = shortcut?.prompt || '';
  $('shortcut-mode').value = shortcut?.mode || 'send';
  $('delete-shortcut').hidden = !shortcut; $('shortcut-error').hidden = true;
  $('shortcut-dialog').showModal(); $('shortcut-label').focus();
}
function renderShortcuts() {
  $('shortcut-buttons').replaceChildren();
  for (const shortcut of promptShortcuts()) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = shortcut.label;
    button.dataset.mode = shortcut.mode || 'send'; button.disabled = shortcutUnavailable(shortcut);
    button.title = `${shortcut.prompt}\n${shortcut.mode === 'fill' ? 'Fill prompt only' : 'Send or queue immediately'} · Right-click to edit`;
    button.onclick = () => runShortcut(shortcut);
    button.oncontextmenu = event => { event.preventDefault(); editShortcut(shortcut); };
    $('shortcut-buttons').append(button);
  }
}
async function persistShortcuts(shortcuts) {
  if (state.savingShortcut) return;
  state.savingShortcut = true;
  for (const button of $('shortcut-form').querySelectorAll('button')) button.disabled = true;
  try { await savePreferences({ shortcuts }); renderShortcuts(); updateBusy(); $('shortcut-dialog').close(); }
  catch (error) { $('shortcut-error').textContent = error.message; $('shortcut-error').hidden = false; }
  finally { state.savingShortcut = false; for (const button of $('shortcut-form').querySelectorAll('button')) button.disabled = false; }
}
$('add-shortcut').onclick = () => editShortcut();
$('cancel-shortcut').onclick = () => $('shortcut-dialog').close();
$('shortcut-dialog').oncancel = event => { if (state.savingShortcut) event.preventDefault(); };
$('shortcut-form').onsubmit = event => {
  event.preventDefault();
  const shortcut = { id: state.shortcutEdit?.id || crypto.randomUUID(), label: $('shortcut-label').value.trim(), prompt: $('shortcut-prompt').value, mode: $('shortcut-mode').value };
  if (!shortcut.label || !shortcut.prompt.trim()) return;
  return persistShortcuts(state.shortcutEdit ? promptShortcuts().map(item => item.id === shortcut.id ? shortcut : item) : [...promptShortcuts(), shortcut]);
};
$('delete-shortcut').onclick = () => persistShortcuts(promptShortcuts().filter(item => item.id !== state.shortcutEdit?.id));
renderShortcuts();
async function send(event, steer = false, action = null) {
  event?.preventDefault();
  if (state.connecting || queueLocked(state.queues.get(queueKey(state.thread?.id)))) return;
  const shortcut = typeof action?.shortcut === 'string';
  const rawText = shortcut ? action.shortcut : $('prompt').value; const text = rawText.trim();
  if (!action && !steer && /^\/[a-z-]*(?:\s|$)/i.test(text)) { await executeSlash(text); return; }
  if (state.commandBusy && !action) return;
  const images = shortcut ? [] : [...state.images];
  if ((!text && !images.length) || images.some(image => !image.url) || !state.connected || state.sending || state.loading) return;
  saveComposerDraft(); const originalDraft = drafts.target;
  const delayHours = !steer && !action ? Number($('send-time').value) : 0;
  const input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'image', url: image.url })), ...skillInputs(text, action?.skills)];
  const access = policy();
  const message = { draftId: crypto.randomUUID(), text, images, input, access, review: Boolean(action?.review), mode: modes.plan ? 'plan' : 'default', model: $('model').value, effort: $('effort').value, machine: accessKey(), thread: state.thread };
  const options = state.options; const selection = state.selection;
  trace('send.requested', { machine: message.machine, threadId: state.thread?.id, delayHours, working: state.active.has(state.thread?.id), status: state.thread?.status?.type, queueLength: state.queues.get(queueKey(state.thread?.id))?.messages.length || 0, paused: Boolean(state.queues.get(queueKey(state.thread?.id))?.paused) });
  state.sending = true; updateBusy();
  try {
    if (!action?.skills && promptSkillNames(text).length) {
      const skills = await resolvePromptSkills(text);
      if (options !== state.options || selection !== state.selection || !state.connected) return;
      message.input = [...input.filter(part => part.type !== 'skill'), ...skillInputs(text, skills)];
    }
    if (!state.thread) {
      const result = await rpc('thread/start', { cwd: $('workspace').value.trim(), historyMode: 'paginated', ...access, ...(projects.selected ? { projectId: projects.selected } : {}), ...(message.model ? { model: message.model } : {}) });
      if (originalDraft && api.moveDraft) api.moveDraft(originalDraft, { machine: message.machine, kind: 'composer', threadId: result.thread.id, cwd: result.thread.cwd, projectId: result.thread.projectId || projects.selected || null });
      if (!result.thread.preview?.trim()) result.thread.preview = text || 'Image';
      state.newThreads.add(result.thread.id);
      state.owned.add(result.thread.id);
      modes.threads.set(result.thread.id, message.mode === 'plan');
      setThread(result.thread);
      state.threads.unshift(result.thread); renderThreads();
      message.thread = result.thread;
      if (delayHours) {
        const name = (text || 'Scheduled image').replace(/\s+/g, ' ').slice(0, 80);
        await rpc('thread/name/set', { threadId: result.thread.id, name });
        applyName(result.thread.id, name);
      }
    } else if (!delayHours && !state.owned.has(state.thread.id)) await ensureWritable(state.thread.id);
    if (delayHours) {
      await api.scheduleMessage({ ...message, turnSettings: turnSettings(message) }, delayHours);
      trace('send.scheduled', { machine: message.machine, threadId: message.thread.id, delayHours });
      $('prompt').value = ''; hideSlash(); state.images = []; renderImages(); $('send-time').value = '0';
      await refreshSchedules().catch(showError);
      return;
    }
    const key = queueKey(state.thread.id);
    if (!steer && (state.active.has(state.thread.id) || state.dispatching.has(key) || state.queues.get(key)?.messages.length)) {
      const queue = state.queues.get(key) || { key, machine: message.machine, thread: state.thread, messages: [], paused: false };
      if (!queue.messages.length) queue.paused = false;
      queue.messages.push(message); state.queues.set(key, queue);
      try { await persistQueue(queue); } catch (error) { queue.messages = queue.messages.filter(entry => entry !== message); throw error; }
      trace('send.queued', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, paused: queue.paused });
      if (!shortcut) { $('prompt').value = ''; hideSlash(); state.images = []; renderImages(); }
      return;
    }
    if (!shortcut) { $('prompt').value = ''; hideSlash(); state.images = []; renderImages(); }
    await submitMessage(message, steer);
  } catch (error) {
    trace('send.failed', { machine: message.machine, threadId: message.thread?.id, error: error.message });
    if (delayHours) $('send-time').value = String(delayHours);
    if (!shortcut && options === state.options && selection === state.selection) { if (!$('prompt').value) $('prompt').value = rawText; state.images = images; renderImages(); }
    showError(error);
  } finally {
    state.sending = false; updateBusy();
    if (options === state.options && selection === state.selection && originalDraft && drafts.target && JSON.stringify(originalDraft) !== JSON.stringify(drafts.target) && saveComposerDraft()) clearDraft(originalDraft);
    for (const queue of state.queues.values()) if (queue.machine === accessKey()) flushQueue(queue.thread.id).catch(showError);
  }
}
function applyName(threadId, name) {
  if (typeof name !== 'string' || !name.trim()) return;
  state.names.set(threadId, name);
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.name = name;
  if (state.thread?.id === threadId) $('thread-title').textContent = name;
  renderThreads();
}
function requestTitle(thread) {
  if (!api.title || !thread.preview?.trim() || thread.name || state.names.has(thread.id) || state.titling.has(thread.id) || state.newThreads.has(thread.id) || state.titleFailed) return;
  const options = state.options;
  state.titling.add(thread.id);
  state.titleTask = state.titleTask.catch(() => {}).then(async () => {
    if (state.options !== options || state.titleFailed) return;
    try {
      const name = await api.title(thread.id, thread.preview.slice(0, 4000));
      if (state.options === options) {
        if (name && !state.names.has(thread.id)) applyName(thread.id, name);
        else if (!name) state.titling.delete(thread.id);
      }
    } catch (error) {
      if (state.options === options) { state.titleFailed = true; showError(error); }
    }
  });
}
function showThreadMenu(thread, x, y) {
  $('project-menu').hidden = true;
  state.contextThread = thread;
  const menu = $('thread-menu'); menu.hidden = false;
  $('clone-conversation').disabled = !state.connected || state.sending || state.commandBusy || state.loading;
  $('mark-unread').disabled = state.unread.has(queueKey(thread.id)) || state.loading && state.thread?.id === thread.id;
  $('archive-conversation').disabled = !canArchiveConversation(thread);
  $('archive-conversation').title = state.active.has(thread.id) || thread.status?.type === 'active' ? 'Stop the running task before archiving' : state.queues.get(queueKey(thread.id))?.messages.length ? 'Send or remove queued messages before archiving' : scheduledFor(thread.id).some(task => task.status === 'pending') ? 'Cancel scheduled messages before archiving' : '';
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
  $('clone-conversation').focus();
}
function canArchiveConversation(thread) {
  const key = queueKey(thread?.id);
  const queue = state.queues.get(key);
  return Boolean(thread?.id && state.connected && !state.connecting && !state.sending && !state.commandBusy && !state.loading && !state.pinning.has(thread.id) && !state.active.has(thread.id) && thread.status?.type !== 'active' && !state.dispatching.has(key) && !queue?.messages.length && !queue?.saving && !scheduledFor(thread?.id).some(task => task.status === 'pending'));
}
async function archiveConversation(thread) {
  if (!canArchiveConversation(thread)) return;
  const operation = { threadId: thread.id, options: state.options };
  state.archiving = operation; state.commandBusy = true;
  $('thread-menu').hidden = true; updateBusy(); renderThreads();
  try {
    await rpc('thread/archive', { threadId: thread.id });
    if (state.archiving !== operation || state.options !== operation.options) return;
    state.listGeneration++;
    state.threads = state.threads.filter(entry => entry.id !== thread.id);
    state.pinnedIds.delete(thread.id); state.pinnedThreads.delete(thread.id);
    state.owned.delete(thread.id); state.names.delete(thread.id);
    setCompletion(thread.id); state.writerConflicts.delete(queueKey(thread.id));
    setUnread(thread.id, false);
    if (state.thread?.id === thread.id) resetThread(); else renderThreads();
    await loadThreads();
  } catch (error) { if (state.archiving === operation && state.options === operation.options) showError(error); }
  finally { if (state.archiving === operation) { state.archiving = null; state.commandBusy = false; updateBusy(); renderThreads(); } }
}
function openMessageEdit(record) {
  if (!state.connected || state.sending || state.commandBusy || state.loading || !record.turnId || state.items.get(record.item.id) !== record) return;
  const queue = state.queues.get(queueKey(state.thread.id));
  if (state.active.has(state.thread.id) || state.dispatching.has(queueKey(state.thread.id)) || queue?.saving || queueLocked(queue)) { showError('Wait for the running task before editing earlier messages.'); return; }
  const draftTarget = editorTarget('edit-message', state.thread, record.turnId);
  state.messageEdit = { thread: state.thread, turnId: record.turnId, content: record.item.content || [], options: state.options, queue, draftTarget };
  if (queue) queue.editing = true;
  $('edit-message-error').textContent = ''; $('edit-message-error').hidden = true;
  $('edited-message').value = editorText(draftTarget, state.messageEdit.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  const count = state.messageEdit.content.filter(part => part.type !== 'text' && part.type !== 'skill').length;
  $('edited-message-attachments').textContent = count ? `${count} attachment(s) will be kept.` : '';
  $('edit-message-dialog').showModal(); $('edited-message').focus();
}
async function resendMessage(target, text) {
  if (!target || !state.connected || state.sending || state.commandBusy || state.loading || target.options !== state.options || target.thread.id !== state.thread?.id) return;
  const thread = target.thread; const machine = accessKey(); const key = queueKey(thread.id);
  const operation = {}; state.resending = operation; state.commandBusy = true; updateBusy();
  const current = () => state.resending === operation && state.options === target.options && state.connected && state.thread?.id === thread.id;
  let lock, queue, reverted = false, saved = false;
  $('edit-message-error').textContent = ''; $('edit-message-error').hidden = true;
  try {
    const message = { draftId: crypto.randomUUID(), text, images: [], input: [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...target.content.filter(part => !['text', 'skill'].includes(part.type)), ...skillInputs(text, target.content.filter(part => part.type === 'skill'), thread.cwd)], access: policy(), mode: modes.plan ? 'plan' : 'default', model: $('model').value, effort: $('effort').value, machine, thread };
    if (state.active.has(thread.id)) throw new Error('Stop the running task before editing earlier messages.');
    if (thread.historyMode === 'legacy' || thread.ephemeral) throw new Error('This conversation uses a history format that Codex cannot edit in place.');
    lock = await api.editLock(thread.id);
    if (!current()) return;
    await ensureWritable(thread.id);
    if (!current()) return;
    if (state.active.has(thread.id)) throw new Error('Stop the running task before editing earlier messages.');
    queue = state.queues.get(key);
    if (queue?.messages.length) await pauseQueue(queue, 'history-edit');
    if (!current()) return;
    const result = await rpc('thread/revert', { threadId: thread.id, beforeTurnId: target.turnId });
    reverted = true;
    trace('edit.reverted', { machine, threadId: thread.id, turnId: target.turnId });
    queue = state.queues.get(key) || { key, machine, thread, messages: [], paused: true };
    queue.messages.unshift(message); queue.paused = true; state.queues.set(key, queue);
    await persistQueue(queue);
    saved = true;
    if (!current()) return;
    clearDraft(target.draftTarget);
    $('edit-message-dialog').close();
    await openThread(result.thread, true);
    if (!current()) return;
    await submitMessage(message);
    const previous = queue.messages;
    queue.messages = queue.messages.filter(entry => entry !== message);
    try { await persistQueue(queue); } catch (error) { queue.messages = previous; throw error; }
  } catch (error) {
    trace('edit.failed', { machine, threadId: thread.id, error: error.message });
    if (state.resending === operation && state.options === target.options) {
      const message = reverted ? saved ? `Edited message was not confirmed; its draft is saved in this conversation's paused queue. Check history before retrying. ${error.message}` : `History was updated, but the draft could not be saved. Keep the edited text before closing. ${error.message}` : error.message || String(error);
      if ($('edit-message-dialog').open) { $('edit-message-error').textContent = message; $('edit-message-error').hidden = false; }
      else showError(message);
    }
  } finally {
    if (lock) await api.editLock(thread.id, lock).catch(error => trace('edit.unlock.failed', { threadId: thread.id, error: error.message }));
    if (state.resending === operation) { state.resending = null; state.commandBusy = false; updateBusy(); }
  }
}
async function cloneConversation(source) {
  if (!source || !state.connected || state.sending || state.commandBusy || state.loading) return;
  const options = state.options; const selection = state.selection;
  const mode = source.id === state.thread?.id ? modes.plan : modes.threads.get(source.id) || false;
  const operation = {}; state.branching = operation;
  const current = () => state.branching === operation && state.options === options && state.connected;
  state.commandBusy = true; hideSlash(); updateBusy();
  try {
    const result = await rpc('thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true, ...policy() });
    if (!current()) return;
    const fork = result.thread;
    const name = titleOf(source).slice(0, 110) + ' (copy)';
    fork.name = name;
    state.owned.add(fork.id); modes.threads.set(fork.id, mode); state.threads.unshift(fork); renderThreads();
    await rpc('thread/name/set', { threadId: fork.id, name });
    if (!current()) return;
    applyName(fork.id, name);
    if (source.projectId && fork.projectId !== source.projectId) {
      await rpc('thread/metadata/update', { threadId: fork.id, projectId: source.projectId });
      if (!current()) return;
      fork.projectId = source.projectId;
    }
    if (selection === state.selection) await openThread(fork, true);
    return fork;
  } catch (error) { if (current()) showError(error); }
  finally { if (state.branching === operation) { state.branching = null; state.commandBusy = false; updateBusy(); } }
}
function openRename() {
  if (!state.contextThread) return;
  state.renaming = { thread: state.contextThread, machine: accessKey() };
  $('conversation-name').value = titleOf(state.contextThread);
  $('rename-dialog').showModal(); $('conversation-name').select();
}
function updateEfforts(preferred) {
  const previous = preferred || $('effort').value;
  const model = state.models.find(model => model.model === $('model').value);
  $('effort').replaceChildren(new Option('Default reasoning', ''));
  for (const entry of model?.supportedReasoningEfforts || []) $('effort').add(new Option(entry.reasoningEffort, entry.reasoningEffort));
  if ([...$('effort').options].some(option => option.value === previous)) $('effort').value = previous;
}
async function connect(options) {
  if (state.connecting) return;
  if (connectionBusy()) { showError('Finish or stop running tasks before changing the connection.'); return; }
  saveComposerDraft();
  state.connecting = true; status('Connecting…'); updateBusy();
  try { await api.connect(options); }
  catch (error) {
    state.connecting = false; status(state.connected ? connectedStatus() : 'Not connected'); updateBusy();
    $('settings-error').textContent = error.message;
    if (!state.connected && !$('settings-dialog').open) $('settings-dialog').showModal();
    showError(error); return;
  }
  drafts.target = null; drafts.suspended = true;
  clearQueueDrag(false);
  clearThreadDrag();
  clearProjectDrag(); $('project-menu').hidden = true;
  pauseQueues();
  state.connected = false;
  state.options = options;
  usage.generation++; usage.threads.clear(); usage.account = null; usage.reading = null; usage.updatedAt = 0; usage.error = null;
  state.commandBusy = false; state.branching = null; state.resending = null; state.archiving = null;
  projects.generation++; projects.data = []; projects.selected = null; projects.expanded.clear(); projects.cursors.clear(); projects.collapsed.clear();
  try { const saved = JSON.parse(localStorage.getItem(accessKey() + ':collapsed-projects') || '[]'); if (Array.isArray(saved)) projects.collapsed = new Set(saved.filter(id => typeof id === 'string')); } catch {}
  $('project-dialog').close(); state.projectDraft = null; $('move-project-dialog').close(); $('project-view-dialog').close();
  state.owned.clear(); state.resuming.clear();
  state.names.clear(); state.titling.clear(); state.newThreads.clear(); state.titleFailed = false;
  slash.generation++; slash.skills = []; slash.cwd = null; slash.loading = false; modes.catalog = []; modes.threads.clear();
  $('edit-queue-dialog').close();
  $('thread-menu').hidden = true; $('rename-dialog').close(); $('edit-message-dialog').close();
  restoreAccess();
  restoreUnread();
  state.threads = [];
  state.pinnedIds.clear();
  state.pinnedThreads.clear();
  state.pinning.clear();
  state.threadCursor = null;
  state.threadQuery = null;
  state.threadCoverage = new Map();
  state.listGeneration++;
  state.folderGeneration++;
  $('folder-dialog').close();
  state.active.clear();
  state.requests.clear();
  connectionLabels();
  $('workspace').value = isLocal() ? options.localCwd : options.cwd;
  resetThread();
  status('Connecting…');
  renderRequests();
  $('settings-error').textContent = '';
  try {
    state.connected = true;
    $('workspace').value = isLocal() ? options.localCwd : options.cwd;
    $('thread-path').textContent = $('workspace').value;
    $('settings-dialog').close();
    $('error').hidden = true;
    resetThread();
    status(connectedStatus());
    refreshUsage();
    const models = await rpc('model/list', { limit: 100 });
    state.models = models.data;
    modes.catalog = (await rpc('collaborationMode/list')).data;
    $('model').replaceChildren(new Option(isLocal() ? 'Local default model' : 'Server default model', ''));
    for (const model of state.models) $('model').add(new Option(model.displayName || model.model, model.model));
    updateEfforts();
    try { state.pinnedIds = new Set(await api.pins()); } catch (error) { showError(error); }
    await loadProjects();
    await restoreStartupProject();
    await loadThreads();
  } catch (error) {
    if (!state.connected) {
      status('Connection failed');
      $('settings-error').textContent = error.message;
      if (!$('settings-dialog').open) $('settings-dialog').showModal();
    }
    showError(error);
  } finally {
    drafts.suspended = false;
    if (state.connected) { try { await restoreLastDraft(); } catch (error) { showError(`Could not reopen saved draft: ${error.message}`); } }
    else activateComposerDraft();
    state.connecting = false; status(state.connected ? connectedStatus() : 'Not connected');
  }
}
function handleNotification(message) {
  if (message.method === 'scheduler/updated') { refreshSchedules().catch(showError); return; }
  const { method, params = {}, id } = message;
  const retry = state.retryError;
  const progress = ['turn/completed', 'item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta'].includes(method)
    || method === 'item/started' && params.item?.type && params.item.type !== 'userMessage'
    || method === 'item/completed' && ['agentMessage', 'reasoning', 'plan'].includes(params.item?.type);
  if (retry && retry.threadId === params.threadId && retry.turnId === (params.turnId || params.turn?.id) && progress) {
    state.retryError = null; $('error').hidden = true;
  }
  if (method === 'thread/tokenUsage/updated') {
    if (state.connected && typeof params.threadId === 'string' && params.tokenUsage) { usage.threads.set(params.threadId, params.tokenUsage); renderUsage(); }
    return;
  }
  if (method === 'account/rateLimits/updated') {
    if (state.connected && params.rateLimits) {
      if (usage.reading) usage.reading.updates.push(params.rateLimits);
      applyRateLimit(params.rateLimits); usage.updatedAt = Date.now(); renderUsage();
    }
    return;
  }
  if (method === 'account/updated') {
    usage.generation++; usage.account = null; usage.reading = null; usage.error = null; usage.updatedAt = 0;
    renderUsage(); refreshUsage(); return;
  }
  if (method === 'connection/closed') {
    clearQueueDrag(false);
    clearThreadDrag();
    clearProjectDrag(); $('project-menu').hidden = true;
    pauseQueues('connection-closed');
    state.connected = false; state.owned.clear(); state.resuming.clear(); state.active.clear(); state.requests.clear();
    state.selection++; state.loading = false; state.historyEvents = null;
    $('folder-dialog').close();
    status('Disconnected'); renderRequests(); showError(params.message);
    return;
  }
  if (id !== undefined) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (supported.includes(method)) { state.requests.set(id, message); renderRequests(); }
    else { api.respond(id, {}).catch(showError); showError(`Codex requested an unsupported interaction: ${method}`); }
    return;
  }
  if (method === 'thread/name/updated') { applyName(params.threadId, params.threadName || params.name); return; }
  if (method === 'project/changed') { refreshProjects().catch(showError); return; }
  if (method === 'thread/project/updated') { applyProject(params.threadId, params.projectId); loadThreads().catch(showError); return; }
  if (method === 'serverRequest/resolved') { state.requests.delete(params.requestId); renderRequests(); return; }
  if (method === 'thread/status/changed') { setThreadRuntimeStatus(params.threadId, params.status); renderThreadIndicators(); updateSettingsActions(); return; }
  if (method === 'turn/started' && !state.finished.has(params.turn.id)) {
    state.owned.add(params.threadId); state.writerConflicts.delete(queueKey(params.threadId));
    setCompletion(params.threadId);
    setThreadRuntimeStatus(params.threadId, { type: 'active' });
    state.active.set(params.threadId, params.turn.id); updateBusy();
  }
  if (method === 'turn/completed') {
    const activeTurn = state.active.get(params.threadId);
    if (!state.finished.has(params.turn.id) && (!activeTurn || activeTurn === params.turn.id)) {
      setThreadRuntimeStatus(params.threadId, { type: 'idle' });
      if (['completed', 'failed'].includes(params.turn.status)) {
        if (isViewingLatest(params.threadId)) { setCompletion(params.threadId); setUnread(params.threadId, false); }
        else setCompletion(params.threadId, params.turn.status);
      }
      const queue = state.queues.get(queueKey(params.threadId));
      if (state.connected && params.turn.status === 'completed' && (!queue?.messages.length || queue.paused)) playCompletionSound();
      if (queue && ['failed', 'interrupted'].includes(params.turn.status)) pauseQueue(queue, 'turn-' + params.turn.status).catch(showError);
    }
    state.finished.add(params.turn.id);
    if (state.finished.size > 1000) state.finished.delete(state.finished.values().next().value);
    if (state.active.get(params.threadId) === params.turn.id) state.active.delete(params.threadId);
    updateBusy();
    for (const [key, request] of state.requests) if (request.params.threadId === params.threadId) state.requests.delete(key);
    renderRequests();
    if (params.turn.error) showError(params.turn.error.message || params.turn.error);
    loadThreads().catch(showError);
    flushQueue(params.threadId).catch(showError);
  }
  if (method === 'error') {
    const queue = state.queues.get(queueKey(params.threadId));
    if (queue && !params.willRetry) { pauseQueue(queue, 'native-error').catch(showError); renderQueue(); }
    showError(params.error?.message || params.message || 'Codex reported an error.');
    if (params.willRetry && params.threadId && params.turnId) state.retryError = { threadId: params.threadId, turnId: params.turnId };
  }
  if (!state.thread || params.threadId !== state.thread.id) return;
  if (state.historyEvents && (method.startsWith('item/') || method === 'turn/completed' || method === 'turn/started')) { state.historyEvents.push(message); return; }
  if (method === 'item/started' || method === 'item/completed') {
    if (params.item.type === 'userMessage') {
      for (const [key, record] of state.items) if (key.startsWith('pending-')) { record.element.remove(); state.items.delete(key); }
    }
    renderItem(params.item, false, params.turnId);
    updateBusy();
  }
  if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
    const previous = state.items.get(params.itemId)?.item;
    renderItem({ id: params.itemId, type: method.includes('/plan/') ? 'plan' : 'agentMessage', text: (previous?.text || '') + params.delta });
  }
  if (method === 'item/commandExecution/outputDelta') {
    const previous = state.items.get(params.itemId)?.item;
    renderItem({ ...previous, id: params.itemId, type: 'commandExecution', aggregatedOutput: (previous?.aggregatedOutput || '') + params.delta }, false, params.turnId);
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    const previous = state.items.get(params.itemId)?.item;
    const summary = [...(previous?.summary || [])];
    summary[params.summaryIndex || 0] = (summary[params.summaryIndex || 0] || '') + params.delta;
    renderItem({ id: params.itemId, type: 'reasoning', summary }, false, params.turnId);
  }
  scrollToBottom();
}
function renderRequests() {
  for (const [id, card] of state.requestCards) {
    if (!state.requests.has(id)) { card.remove(); state.requestCards.delete(id); }
    else {
      const threadId = state.requests.get(id).params.threadId;
      card.hidden = Boolean(threadId && threadId !== state.thread?.id);
    }
  }
  for (const [id, request] of state.requests) {
    if (request.params.threadId && request.params.threadId !== state.thread?.id) continue;
    const existing = state.requestCards.get(id);
    if (existing) { existing.hidden = false; continue; }
    const card = document.createElement('div'); card.className = 'request-card';
    const heading = document.createElement('strong');
    heading.textContent = request.method.includes('requestUserInput') ? 'Codex has a question' : 'Codex needs your approval';
    const reason = document.createElement('p'); reason.textContent = request.params.reason || request.params.message || '';
    card.append(heading, reason);
    const actions = document.createElement('div'); actions.className = 'request-actions';
    const action = (label, result) => {
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = async () => {
        try {
          button.disabled = true;
          const answer = typeof result === 'function' ? result() : result;
          await api.respond(id, answer);
          state.requests.delete(id); renderRequests();
        } catch (error) { button.disabled = false; showError(error); }
      };
      actions.append(button);
    };
    if (request.method === 'item/tool/requestUserInput') {
      const answers = [];
      for (const question of request.params.questions) {
        const label = document.createElement('label'); label.textContent = question.question;
        const input = document.createElement('input'); input.placeholder = 'Your answer';
        if (question.isSecret) input.type = 'password';
        if (question.options?.length) {
          const choices = document.createElement('select'); choices.add(new Option('Choose an option…', ''));
          for (const option of question.options) choices.add(new Option(`${option.label}${option.description ? ' — ' + option.description : ''}`, option.label));
          choices.onchange = () => { input.value = choices.value; };
          card.append(label, choices, input);
        } else card.append(label, input);
        answers.push([question.id, input]);
      }
      action('Send answer', () => {
        if (answers.some(([, input]) => !input.value.trim())) throw new Error('Answer each question before sending.');
        return { answers: Object.fromEntries(answers.map(([key, input]) => [key, { answers: [input.value] }])) };
      });
    } else if (request.method === 'item/permissions/requestApproval') {
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(request.params.permissions, null, 2); card.append(pre);
      action('Allow this turn', { permissions: request.params.permissions, scope: 'turn' });
      action('Decline', { permissions: {} });
    } else if (request.method === 'mcpServer/elicitation/request') {
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(request.params.requestedSchema || request.params.url || {}, null, 2); card.append(pre);
      const input = document.createElement('textarea'); input.placeholder = 'Response as JSON'; card.append(input);
      action('Submit', () => ({ action: 'accept', content: JSON.parse(input.value || '{}') }));
      action('Decline', { action: 'decline' });
    } else {
      const pre = document.createElement('pre'); pre.textContent = request.params.command || request.params.grantRoot || 'Apply the proposed file changes shown above.'; card.append(pre);
      const available = request.params.availableDecisions;
      if (!available || available.includes('accept')) action('Allow once', { decision: 'accept' });
      action('Decline', { decision: 'decline' });
    }
    card.append(actions); $('requests').append(card);
    state.requestCards.set(id, card);
  }
  $('requests').hidden = ![...state.requestCards.values()].some(card => !card.hidden);
}
async function browseFolders(path) {
  const generation = ++state.folderGeneration;
  state.folderPath = null;
  $('use-folder').disabled = true;
  $('folder-error').textContent = '';
  $('folder-list').replaceChildren();
  $('folder-status').textContent = isLocal() ? 'Loading local folders…' : 'Loading server folders…';
  try {
    path = path.trim();
    if (isLocal()) path = path.replace(/\\/g, '/');
    if ((!path.startsWith('/') && !(isLocal() && /^[a-z]:\//i.test(path))) || path.includes('\0')) throw new Error('Enter an absolute folder path.');
    $('folder-location').value = path;
    const result = await rpc('fs/readDirectory', { path });
    if (generation !== state.folderGeneration || !$('folder-dialog').open) return;
    state.folderPath = path;
    const entries = result.entries.filter(entry => entry.isDirectory).sort((a, b) => Number(a.fileName.startsWith('.')) - Number(b.fileName.startsWith('.')) || a.fileName.localeCompare(b.fileName));
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.folderName = entry.fileName;
      const icon = document.createElement('span'); icon.textContent = '▱';
      const name = document.createElement('span'); name.textContent = entry.fileName;
      const arrow = document.createElement('span'); arrow.textContent = '›';
      button.append(icon, name, arrow);
      button.onclick = () => browseFolders(path.replace(/\/$/, '') + '/' + entry.fileName);
      $('folder-list').append(button);
    }
    $('folder-status').textContent = entries.length ? `${entries.length} subfolders · select one to open it` : 'No subfolders. You can use this folder.';
    $('parent-folder').disabled = path === '/' || /^[a-z]:\/$/i.test(path);
    $('use-folder').disabled = false;
  } catch (error) {
    if (generation !== state.folderGeneration) return;
    $('folder-status').textContent = '';
    $('folder-error').textContent = error.message;
  }
}
async function openProjectPicker(purpose = 'conversation') {
  if (!state.connected || state.sending) return;
  state.folderPurpose = purpose === 'project' ? 'project' : 'conversation';
  $('folder-host').textContent = $('server-host').textContent;
  $('use-folder').textContent = state.folderPurpose === 'project' ? 'Add this folder as a project →' : state.thread ? 'Start a new conversation in this folder →' : 'Use this folder →';
  $('folder-dialog').showModal();
  await browseFolders(state.thread?.cwd || $('workspace').value || '/');
}
$('browse-workspace').onclick = openProjectPicker;
$('choose-project').onclick = openProjectPicker;
$('close-folders').onclick = () => $('folder-dialog').close();
$('folder-dialog').onclose = () => { state.folderGeneration++; state.folderPath = null; };
$('folder-form').onsubmit = event => { event.preventDefault(); browseFolders($('folder-location').value); };
$('folder-location').oninput = () => { state.folderGeneration++; state.folderPath = null; $('use-folder').disabled = true; };
$('parent-folder').onclick = () => browseFolders(($('folder-location').value.replace(/\/+$/, '').replace(/\/[^/]*$/, '')) || '/');
$('use-folder').onclick = () => {
  if (!state.folderPath || !state.connected) return;
  if (state.folderPurpose === 'project') {
    state.projectDraft = { path: state.folderPath, options: state.options, idempotencyKey: crypto.randomUUID() };
    $('save-project').disabled = false;
    $('project-title').textContent = $('save-project').textContent = 'Add project';
    $('project-path').value = state.folderPath;
    $('project-name').value = state.folderPath.replace(/\/+$/, '').split('/').pop() || 'Project';
    $('project-error').textContent = ''; $('folder-dialog').close(); $('project-dialog').showModal(); $('project-name').select();
    return;
  }
  projects.selected = projectAtPath(state.folderPath)?.id || null;
  $('workspace').value = state.folderPath;
  $('thread-path').textContent = state.folderPath;
  if (state.thread) resetThread();
  else changeDraftWorkspace();
  $('folder-dialog').close();
  $('prompt').focus();
};
$('cancel-project').onclick = () => $('project-dialog').close();
$('project-form').onsubmit = async event => {
  event.preventDefault();
  const draft = state.projectDraft; const name = $('project-name').value.trim();
  if (!draft || draft.options !== state.options || !name || name.length > 120 || !state.connected || $('save-project').disabled) return;
  $('save-project').disabled = true; $('project-error').textContent = '';
  try {
    const existing = !draft.projectId && projectAtPath(draft.path);
    const project = draft.projectId
      ? (await rpc('project/update', { projectId: draft.projectId, name })).project
      : existing || (await rpc('project/create', { name, roots: [{ path: draft.path }], idempotencyKey: draft.idempotencyKey })).project;
    if (draft.options !== state.options || draft !== state.projectDraft) return;
    const index = projects.data.findIndex(entry => entry.id === project.id);
    if (index < 0) projects.data.push(project); else projects.data[index] = project;
    $('project-dialog').close();
    if (draft.projectId) renderThreads(); else startProject(project);
    await refreshProjects().catch(showError);
  } catch (error) { if (draft.options === state.options && draft === state.projectDraft) $('project-error').textContent = error.message; }
  finally { if (draft === state.projectDraft) $('save-project').disabled = false; }
};
function showProjectMenu(project, x, y) {
  state.contextProject = { project, options: state.options };
  $('thread-menu').hidden = true;
  const menu = $('project-menu'); menu.hidden = false;
  const index = projects.data.findIndex(entry => entry.id === project.id);
  $('open-project').disabled = !state.connected || state.sending || state.commandBusy || state.loading;
  $('open-project').textContent = projects.expanded.has(project.id) ? 'Show fewer conversations' : 'Expand conversations';
  $('rename-project').disabled = !state.connected;
  $('move-project-up').disabled = !state.connected || projectDrag.pending === state.options || index <= 0;
  $('move-project-down').disabled = !state.connected || projectDrag.pending === state.options || index < 0 || index === projects.data.length - 1;
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
  $('rename-project').focus();
}
$('open-project').onclick = async () => {
  const target = state.contextProject;
  if (!target || target.options !== state.options || !state.connected || state.sending || state.commandBusy || state.loading) return;
  try {
    if (projects.expanded.has(target.project.id)) { projects.expanded.delete(target.project.id); await loadThreads(); }
    else await expandProject(target.project);
  } catch (error) { showError(error); }
};
$('project-settings').onclick = () => {
  const target = state.contextProject;
  if (!target || target.options !== state.options) return;
  state.projectView = target;
  $('project-view-name').textContent = target.project.name;
  $('project-view-path').textContent = target.project.roots.map(root => root.path).join('\n');
  $('startup-project').checked = preferences.startupProjects[accessKey()] === target.project.id;
  $('startup-project').disabled = false; $('project-view-error').textContent = '';
  $('project-view-dialog').showModal();
};
$('close-project-view').onclick = () => $('project-view-dialog').close();
$('startup-project').onchange = async () => {
  const target = state.projectView;
  if (!target || target.options !== state.options) return;
  const machine = accessKey(); const projectId = $('startup-project').checked ? target.project.id : null;
  $('startup-project').disabled = true; $('project-view-error').textContent = '';
  try { await savePreferences({ startupProject: { machine, projectId } }); }
  catch (error) { if (state.projectView === target) { $('startup-project').checked = preferences.startupProjects[machine] === target.project.id; $('project-view-error').textContent = error.message; } }
  finally { if (state.projectView === target) $('startup-project').disabled = false; }
};
$('open-project-view').onclick = async () => {
  const target = state.projectView;
  if (!target || target.options !== state.options) return;
  $('project-view-dialog').close();
  try { await expandProject(target.project); } catch (error) { showError(error); }
};
$('rename-project').onclick = () => {
  const target = state.contextProject;
  if (!state.connected || !target || target.options !== state.options) return;
  const project = projects.data.find(entry => entry.id === target.project.id);
  if (!project) return;
  state.projectDraft = { projectId: project.id, options: state.options };
  $('save-project').disabled = false;
  $('project-title').textContent = 'Rename project'; $('save-project').textContent = 'Save';
  $('project-name').value = project.name; $('project-path').value = project.roots.map(root => root.path).join(', ');
  $('project-error').textContent = ''; $('project-dialog').showModal(); $('project-name').select();
};
for (const direction of ['up', 'down']) $(`move-project-${direction}`).onclick = () => {
  const target = state.contextProject;
  if (!target || target.options !== state.options) return;
  const index = projects.data.findIndex(project => project.id === target.project.id);
  if (index < 0 || direction === 'up' && index === 0 || direction === 'down' && index === projects.data.length - 1) return;
  moveProject(target.project.id, projects.data[index + (direction === 'up' ? -1 : 2)]?.id || null, target.options).catch(showError);
};
async function moveProject(projectId, beforeProjectId, options = state.options) {
  if (!state.connected || options !== state.options || projectDrag.pending === options || projectId === beforeProjectId) return;
  const index = projects.data.findIndex(project => project.id === projectId);
  if (index < 0 || beforeProjectId && !projects.data.some(project => project.id === beforeProjectId) || (projects.data[index + 1]?.id || null) === beforeProjectId) return;
  projectDrag.pending = options;
  try {
    await rpc('project/move', { projectId, beforeProjectId });
    if (options === state.options && await loadProjects()) renderThreads();
  } finally { if (projectDrag.pending === options) projectDrag.pending = null; }
}
function clearProjectDrag() {
  projectDrag.source = null;
  for (const element of $('threads').querySelectorAll('.project-dragging,.drop-before,.drop-after')) element.classList.remove('project-dragging', 'drop-before', 'drop-after');
}
function bindProjectDrag(group, header, project) {
  header.draggable = state.connected;
  header.ondragstart = event => {
    if (!state.connected || projectDrag.pending === state.options || event.target.closest('.project-new,.project-menu-button') || !event.dataTransfer) { event.preventDefault(); return; }
    clearThreadDrag(); clearProjectDrag();
    projectDrag.source = { projectId: project.id, options: state.options, token: crypto.randomUUID() };
    event.dataTransfer.setData(projectDrag.type, projectDrag.source.token); event.dataTransfer.effectAllowed = 'move';
    group.classList.add('project-dragging'); $('project-menu').hidden = true; $('thread-menu').hidden = true;
  };
  header.ondragend = clearProjectDrag;
  const valid = event => state.connected && projectDrag.source && projectDrag.source.options === state.options && projectDrag.source.projectId !== project.id && event.dataTransfer?.types.includes(projectDrag.type);
  const after = event => event.clientY >= header.getBoundingClientRect().top + header.getBoundingClientRect().height / 2;
  group.addEventListener('dragover', event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    for (const target of $('threads').querySelectorAll('.drop-before,.drop-after')) target.classList.remove('drop-before', 'drop-after');
    group.classList.add(after(event) ? 'drop-after' : 'drop-before');
  });
  group.addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof Node) || !group.contains(event.relatedTarget)) group.classList.remove('drop-before', 'drop-after'); });
  group.addEventListener('drop', event => {
    if (!valid(event) || event.dataTransfer.getData(projectDrag.type) !== projectDrag.source.token) return;
    event.preventDefault(); event.stopPropagation();
    const source = projectDrag.source;
    const index = projects.data.findIndex(entry => entry.id === project.id);
    const beforeProjectId = after(event) ? projects.data[index + 1]?.id || null : project.id;
    clearProjectDrag(); moveProject(source.projectId, beforeProjectId, source.options).catch(showError);
  });
}
function applyProject(threadId, projectId) {
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.projectId = projectId;
  if (state.thread?.id === threadId) projects.selected = projectId;
  renderThreads();
}
function clearThreadDrag() {
  threadDrag.source = null;
  for (const element of $('threads').querySelectorAll('.drop-target,.dragging')) element.classList.remove('drop-target', 'dragging');
  for (const element of $('threads').querySelectorAll('.thread-row.drop-before,.thread-row.drop-after')) element.classList.remove('drop-before', 'drop-after');
  for (const group of $('threads').querySelectorAll('[data-search-hidden]')) group.hidden = true;
}
function sortProjectThreads(threads, projectId) {
  const ids = preferences.threadOrders[accessKey()]?.[projectId] || [];
  const rank = new Map(ids.map((id, index) => [id, index]));
  const cutoff = preferences.threadOrderCutoffs[accessKey()]?.[projectId] ?? Infinity;
  const position = thread => rank.get(thread.id) ?? (Number.isFinite(thread.createdAt) && thread.createdAt >= cutoff ? -1 : Number.MAX_SAFE_INTEGER);
  return threads.sort((a, b) => Number(state.pinnedIds.has(b.id)) - Number(state.pinnedIds.has(a.id)) || position(a) - position(b));
}
function bindThreadOrder(row, thread) {
  const valid = event => {
    const source = threadDrag.source;
    return state.connected && source && source.options === state.options && source.thread.id !== thread.id && source.thread.projectId === thread.projectId && state.pinnedIds.has(source.thread.id) === state.pinnedIds.has(thread.id) && !threadDrag.orderPending.has(JSON.stringify([accessKey(), thread.projectId])) && !state.pinning.has(source.thread.id) && !state.pinning.has(thread.id) && state.archiving?.threadId !== thread.id && event.dataTransfer?.types.includes(threadDrag.type);
  };
  const after = event => event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  row.ondragover = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    for (const element of $('threads').querySelectorAll('.thread-row.drop-before,.thread-row.drop-after')) element.classList.remove('drop-before', 'drop-after');
    row.classList.add(after(event) ? 'drop-after' : 'drop-before');
  };
  row.ondragleave = event => { if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget)) row.classList.remove('drop-before', 'drop-after'); };
  row.ondrop = async event => {
    if (!valid(event) || event.dataTransfer.getData(threadDrag.type) !== threadDrag.source.token) return;
    event.preventDefault(); event.stopPropagation();
    const source = threadDrag.source; const below = after(event); clearThreadDrag();
    try { await reorderThread(source.thread, thread, below, source.options); } catch (error) { if (source.options === state.options) showError(error); }
  };
}
async function reorderThread(source, target, after, options = state.options) {
  if (!state.connected || options !== state.options || !source.projectId || source.projectId !== target.projectId || source.id === target.id || state.pinnedIds.has(source.id) !== state.pinnedIds.has(target.id)) return;
  const machine = accessKey(); const projectId = source.projectId;
  const key = JSON.stringify([machine, projectId]);
  if (threadDrag.orderPending.has(key)) return;
  const members = sortProjectThreads([...new Map([...state.pinnedThreads.values(), ...state.threads].map(thread => [thread.id, thread])).values()].filter(thread => thread.projectId === projectId), projectId);
  if (![source.id, target.id].every(id => members.some(thread => thread.id === id))) return;
  const saved = preferences.threadOrders[machine]?.[projectId] || [];
  const known = new Set(saved); const ids = [...saved];
  for (let index = 0; index < members.length; index++) {
    if (known.has(members[index].id)) continue;
    const nextKnown = members.slice(index + 1).find(thread => known.has(thread.id));
    ids.splice(nextKnown ? ids.indexOf(nextKnown.id) : ids.length, 0, members[index].id);
  }
  const next = ids.filter(id => id !== source.id);
  next.splice(next.indexOf(target.id) + (after ? 1 : 0), 0, source.id);
  if (ids.every((id, index) => next[index] === id)) return;
  threadDrag.orderPending.add(key); renderThreads();
  try {
    const cutoff = Math.max(preferences.threadOrderCutoffs[machine]?.[projectId] || 0, ...members.map(thread => Number.isSafeInteger(thread.createdAt) && thread.createdAt >= 0 ? thread.createdAt : 0));
    await api.savePreferences({ threadOrder: { machine, projectId, ids: next, cutoff } });
    preferences.threadOrders[machine] = { ...preferences.threadOrders[machine], [projectId]: next };
    preferences.threadOrderCutoffs[machine] = { ...preferences.threadOrderCutoffs[machine], [projectId]: cutoff };
  } finally { threadDrag.orderPending.delete(key); if (machine === accessKey()) renderThreads(); }
}
function bindThreadDrop(target, projectId) {
  const valid = event => state.connected && threadDrag.source && threadDrag.source.options === state.options && event.dataTransfer?.types.includes(threadDrag.type) && (threadDrag.source.thread.projectId || null) !== projectId && (!projectId || projects.data.some(project => project.id === projectId));
  target.ondragover = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; target.classList.add('drop-target');
  };
  target.ondragleave = event => { if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) target.classList.remove('drop-target'); };
  target.ondrop = async event => {
    if (!valid(event) || event.dataTransfer.getData(threadDrag.type) !== threadDrag.source.token) return;
    event.preventDefault(); event.stopPropagation();
    const source = threadDrag.source; clearThreadDrag();
    try { await moveThreadToProject(source.thread, projectId, source.options); } catch (error) { showError(error); }
  };
}
async function moveThreadToProject(thread, projectId, options = state.options) {
  if (!state.connected || options !== state.options || (thread.projectId || null) === projectId || projectId && !projects.data.some(project => project.id === projectId)) return;
  const key = queueKey(thread.id);
  if (threadDrag.pending.has(key)) return;
  threadDrag.pending.add(key);
  try {
    await rpc('thread/metadata/update', { threadId: thread.id, projectId: projectId || '' });
    if (options !== state.options) return;
    if (projectId) projects.collapsed.delete(projectId);
    applyProject(thread.id, projectId);
    await loadThreads().catch(showError);
    if (options === state.options && !state.threads.some(entry => entry.id === thread.id)) { state.threads.unshift(thread); renderThreads(); }
  } finally { threadDrag.pending.delete(key); }
}
$('move-conversation').onclick = () => {
  if (!state.contextThread || !state.connected) return;
  state.moving = { thread: state.contextThread, options: state.options };
  $('conversation-project').replaceChildren(new Option('No project', ''));
  for (const project of projects.data) $('conversation-project').add(new Option(project.name, project.id));
  $('conversation-project').value = state.contextThread.projectId || '';
  $('move-project-error').textContent = ''; $('move-project-dialog').showModal();
};
$('cancel-move-project').onclick = () => $('move-project-dialog').close();
$('move-project-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.moving; const projectId = $('conversation-project').value || null;
  if (!target || target.options !== state.options || !state.connected || $('save-move-project').disabled) return;
  if (projectId && !projects.data.some(project => project.id === projectId)) return;
  $('save-move-project').disabled = true; $('move-project-error').textContent = '';
  try {
    await moveThreadToProject(target.thread, projectId, target.options);
    if (target.options !== state.options) return;
    $('move-project-dialog').close();
  } catch (error) { if (target.options === state.options) $('move-project-error').textContent = error.message; }
  finally { $('save-move-project').disabled = false; }
};
function openSettings() { fillSettings(state.options); $('settings-error').textContent = ''; $('settings-dialog').showModal(); }
$('connection-mode').onchange = settingsMode;
$('open-settings').onclick = openSettings;
$('close-settings').onclick = () => $('settings-dialog').close();
$('settings-done').onclick = () => $('settings-dialog').close();
$('dismiss-error').onclick = () => { $('error').hidden = true; };
$('browse-key').onclick = async () => { try { const key = await api.chooseKey(); if (key) { $('key').value = key; updateSettingsActions(); } } catch (error) { showError(error); } };
$('settings-form').addEventListener('input', updateSettingsActions);
$('settings-form').addEventListener('change', updateSettingsActions);
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  if (state.connected && !connectionSettingsChanged()) { $('settings-dialog').close(); return; }
  await connect(settingsConnectionOptions());
};
$('connect').onclick = async () => { try { await connect(await api.settings()); } catch (error) { showError(error); } };
$('new-chat').onclick = resetThread;
$('retry-writer').onclick = async () => {
  const threadId = state.thread?.id;
  if (!threadId || state.sending || state.loading) return;
  state.sending = true; updateBusy();
  try { await ensureWritable(threadId); } catch (error) { showError(error); }
  finally { state.sending = false; updateBusy(); }
};
$('composer').onsubmit = send;
$('mark-unread').onclick = () => markUnread(state.contextThread);
$('unread-shortcut').textContent = navigator.platform.includes('Mac') ? 'U · ⌘⇧U' : 'U · Ctrl+Shift+U';
$('mark-unread').setAttribute('aria-keyshortcuts', navigator.platform.includes('Mac') ? 'U Meta+Shift+U' : 'U Control+Shift+U');
$('clone-conversation').onclick = () => cloneConversation(state.contextThread);
$('archive-conversation').onclick = () => archiveConversation(state.contextThread);
$('cancel-message-edit').onclick = () => { clearDraft(state.messageEdit?.draftTarget); $('edit-message-dialog').close(); };
$('edit-message-dialog').oncancel = event => { if (state.resending) event.preventDefault(); else clearDraft(state.messageEdit?.draftTarget); };
$('edited-message').oninput = () => saveEditorDraft(state.messageEdit?.draftTarget, $('edited-message').value);
$('edit-message-dialog').onclose = () => {
  if ($('edit-message-dialog').open) return;
  const target = state.messageEdit; state.messageEdit = null;
  if (target?.queue) { target.queue.editing = false; if (target.options === state.options && state.connected && !state.commandBusy) flushQueue(target.thread.id).catch(showError); }
};
$('edit-message-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.messageEdit; const text = $('edited-message').value.trim();
  if (!target || !text && !target.content.some(part => !['text', 'skill'].includes(part.type))) return;
  saveEditorDraft(target.draftTarget, $('edited-message').value);
  await resendMessage(target, text);
};
$('rename-conversation').onclick = openRename;
$('cancel-rename').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.renaming;
  const name = $('conversation-name').value.trim();
  if (!name || !target || target.machine !== accessKey() || !state.connected) return;
  $('save-rename').disabled = true;
  try {
    await rpc('thread/name/set', { threadId: target.thread.id, name });
    if (target.machine === accessKey()) { applyName(target.thread.id, name); $('rename-dialog').close(); }
  } catch (error) { showError(error); } finally { $('save-rename').disabled = false; }
};

$('attach-images').onclick = () => $('image-files').click();
$('image-files').onchange = () => { addImages($('image-files').files); $('image-files').value = ''; };
$('prompt').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); addImages(files); }
});
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  if (type === 'drop' && event.target.closest('main') && !document.querySelector('dialog[open]')) addImages(event.dataTransfer.files);
});
$('permissions').onchange = () => { localStorage.setItem(accessKey(), $('permissions').value); };
function accessKey() { return 'access:' + (isLocal() ? 'local' : `${state.options?.host || ''}:${state.options?.port || 22}`); }
function restoreAccess() {
  const saved = localStorage.getItem(accessKey());
  $('permissions').value = ['read-only', 'workspace-write', 'danger-full-access'].includes(saved) ? saved : 'workspace-write';
}
$('prompt').oninput = () => { slash.dismissed = null; slash.index = 0; slash.skillOnly = false; saveComposerDraft(); updateSendButton(); updateSlash(); };
$('prompt').onkeydown = promptKeydown;
$('plan-mode').onclick = () => { modes.plan = false; if (state.thread) modes.threads.set(state.thread.id, false); updateBusy(); };
$('model').onchange = () => { updateEfforts(); usage.threads.delete(state.thread?.id); renderUsage(); };
$('workspace').oninput = () => { $('thread-path').textContent = $('workspace').value; projects.selected = projectAtPath($('workspace').value.trim())?.id || null; changeDraftWorkspace(); };
$('composer').addEventListener('change', () => saveComposerDraft());
addEventListener('beforeunload', () => {
  saveComposerDraft();
  if ($('edit-queue-dialog').open) saveEditorDraft(state.queueEdit?.draftTarget, $('queued-text').value);
  if ($('edit-message-dialog').open) saveEditorDraft(state.messageEdit?.draftTarget, $('edited-message').value);
});
$('refresh').onclick = () => refreshProjects().catch(showError);
$('more-threads').onclick = async () => {
  $('more-threads').disabled = true;
  try { await loadThreads(true); } catch (error) { showError(error); } finally { $('more-threads').disabled = false; }
};
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadThreads().catch(showError), 250); };
$('send').onclick = event => { if (canStopTurn()) { event.preventDefault(); return stopTurn(); } };
$('older-turns').onclick = async () => {
  const selection = state.selection;
  const height = $('timeline').scrollHeight;
  $('older-turns').disabled = true;
  try {
    const result = await rpc('thread/turns/list', { threadId: state.thread.id, cursor: state.turnCursor, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    if (selection !== state.selection) return;
    for (const turn of result.data) for (const item of [...(turn.items || [])].reverse()) renderItem(item, true, turn.id);
    state.turnCursor = result.nextCursor;
    $('older-turns').hidden = !result.nextCursor;
    $('timeline').scrollTop += $('timeline').scrollHeight - height;
  } catch (error) { showError(error); } finally { $('older-turns').disabled = false; updateBusy(); }
};
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }; });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); if (!state.connecting && !state.sending && !state.commandBusy) resetThread(); } });
document.addEventListener('keydown', unreadShortcut);
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  const editor = event.target?.closest?.('dialog[open] textarea');
  if (!editor?.form || editor.disabled || editor.readOnly) return;
  event.preventDefault();
  if (event.repeat) return;
  const submit = editor.form.querySelector('button[type="submit"],input[type="submit"]');
  if (submit && !submit.matches(':disabled') && !submit.hidden) editor.form.requestSubmit(submit);
});
globalThis.addEventListener('focus', acknowledgeVisibleThread);
globalThis.addEventListener('focus', () => { if (usage.timer && state.connected && Date.now() - usage.updatedAt > 60000) refreshUsage(); });
document.addEventListener('visibilitychange', acknowledgeVisibleThread);
document.addEventListener('close', acknowledgeVisibleThread, true);
$('timeline').addEventListener('scroll', acknowledgeVisibleThread);
$('timeline').addEventListener('pointerdown', acknowledgeVisibleThread);
document.addEventListener('click', event => { if (!event.target.closest('#composer')) hideSlash(); $('thread-menu').hidden = true; $('project-menu').hidden = true; });
async function openMessageLink(event) {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button > 1 || event.type === 'auxclick' && event.button !== 1) return;
  event.preventDefault();
  try { await api.openLink(link.getAttribute('href'), linkContexts.get(link)); } catch (error) { showError(error); }
}
document.addEventListener('click', openMessageLink);
document.addEventListener('auxclick', openMessageLink);
document.addEventListener('contextmenu', async event => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented) return;
  event.preventDefault();
  try { await api.linkMenu(link.getAttribute('href'), linkContexts.get(link)); } catch (error) { showError(error); }
});
document.addEventListener('drop', event => { if (threadDrag.source && event.dataTransfer?.types.includes(threadDrag.type)) { event.preventDefault(); clearThreadDrag(); } });
document.addEventListener('drop', event => { if (queueDrag.source && event.dataTransfer?.types.includes(queueDrag.type)) { event.preventDefault(); clearQueueDrag(); } });
document.addEventListener('drop', event => { if (projectDrag.source && event.dataTransfer?.types.includes(projectDrag.type)) { event.preventDefault(); clearProjectDrag(); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('thread-menu').hidden = true; $('project-menu').hidden = true; clearProjectDrag(); } });
async function init() {
  if (!api) { showError('Open Remote Codex as a desktop app to connect to Codex.'); return; }
  api.onNotification(handleNotification);
  Object.assign(preferences, await api.preferences()); applyTheme(preferences.theme); renderShortcuts();
  await restoreQueues();
  await refreshSchedules();
  const options = await api.settings();
  fillSettings(options);
  await connect(options);
  usage.timer = setInterval(() => { if (state.connected && !document.hidden) refreshUsage(); }, 60000);
}
init().catch(showError);

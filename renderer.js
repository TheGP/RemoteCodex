/* global marked, DOMPurify */
const controls = new Map([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
const $ = id => controls.get(id);
const api = window.agent;
const agents = { available: [] };
const projects = { data: [], selected: null, expanded: new Set(), cursors: new Map(), collapsed: new Set(), generation: 0 };
const preferences = { theme: 'system', startupProjects: {}, conversationStates: {}, threadOrders: {}, threadOrderCutoffs: {} };
const imageLoads = new Map();
const linkContexts = new WeakMap();
const completionSound = { audio: null, lastAt: -Infinity };
const messageDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const schedules = { tasks: [], generation: 0 };
const drafts = { target: null, snapshot: null, images: [], suspended: false, restoring: false, pending: new Map(), dirty: false, timer: null, autosave: null, indicators: null, syncedRevision: null };
const composerAutosaveDelay = 3000;
const editorDrafts = new Map();
const timelineView = { following: true, reading: null };
const recentTimelines = new Map();
const initialTurnLimit = 8, olderTurnLimit = 25;
const cachedTimelineLimit = 4, historyRefreshPageLimit = 4;
const pinnedMessages = { saving: false, jumping: null };
const conversationSync = { paths: {}, pathsMachine: null, status: null, statusOptions: null, refreshing: false, again: false, ownership: new Map(), historyEnabled: false };
const observedTurns = new Map();
const pinIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 9V3H8v6l-3 3v2h14v-2l-3-3M12 14v7"/></svg>';
for (let hours = 1; hours < 24; hours++) $('send-time').add(new Option(`${hours} hour${hours === 1 ? '' : 's'}`, String(hours)));
for (let days = 1; days <= 7; days++) $('send-time').add(new Option(`${days} day${days === 1 ? '' : 's'}`, String(days * 24)));
const threadDrag = { source: null, marker: null, renderPending: false, pending: new Set(), orderPending: new Set(), type: 'application/x-remote-codex-thread' };
const projectDrag = { source: null, pending: null, type: 'application/x-remote-codex-project' };
const queueDrag = { source: null, type: 'application/x-remote-codex-queue' };
const usage = { threads: new Map(), account: null, reading: null, generation: 0, updatedAt: 0, error: null, timer: null, model: null };
const state = { owned: new Set(), resuming: new Map(), writerConflicts: new Set(), completions: new Map(), unread: new Set(), manualUnread: null, queues: new Map(), nativeQueues: new Map(), dispatching: new Set(), finished: new Set(), names: new Map(), titling: new Map(), newThreads: new Set(), titleTask: Promise.resolve(), titleRetries: new Map(), images: [], connected: false, connecting: false, threads: [], pinnedIds: new Set(), pinnedThreads: new Map(), failedPins: new Set(), pinning: new Set(), thread: null, threadCursor: null, turnCursor: null, active: new Map(), items: new Map(), requests: new Map(), requestCards: new Map(), models: [], loading: false, historyLoadFailed: false, sending: false, selection: 0, historyEvents: null, listGeneration: 0, folderPath: null, folderGeneration: 0 };
const slash = { index: 0, matches: [], dismissed: null, skills: [], cwd: null, loading: false, generation: 0, skillOnly: false };
const modes = { plan: false, catalog: [], threads: new Map() };
const compacting = new Map();
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

const identityProvider = value => /^agent:([a-z][a-z0-9-]*):/.exec(value || '')?.[1] || 'codex';
const threadProvider = thread => thread?.provider || identityProvider(thread?.id);
const selectedProvider = () => state.thread ? threadProvider(state.thread) : identityProvider($('model').value);
const agentMetadata = provider => state.options?.agents?.find(agent => agent.id === provider) || agents.available.find(agent => agent.id === provider) || (state.options?.agent?.id === provider ? state.options.agent : null);
const agentName = (provider = selectedProvider()) => agentMetadata(provider)?.name || (provider === 'codex' ? 'Codex' : provider);
function modelUnavailable(model = $('model').value, provider = selectedProvider()) {
  const option = [...$('model').options].find(option => option.value === model);
  const agent = agentMetadata(provider);
  return !option || option.dataset.unavailable === 'true' || Boolean(model && identityProvider(model) !== provider) || agent?.connected === false || agent?.enabled === false || agent?.available === false;
}
const supports = (method, provider = selectedProvider()) => !agentMetadata(provider)?.methods || agentMetadata(provider).methods.includes(method);
const supportsAny = method => (state.options?.agents || agents.available).some(agent => supports(method, agent.id)) || (!(state.options?.agents || agents.available).length && supports(method));
const catalogMethods = new Set(['model/list', 'collaborationMode/list', 'thread/list', 'project/list']);
function rpc(method, params = {}, repairReasoning = false) {
  const aggregate = catalogMethods.has(method) && !params.provider && !params.projectId && !params.threadId;
  const provider = params.provider || (params.threadId ? identityProvider(params.threadId) : params.model ? identityProvider(params.model) : params.projectId ? identityProvider(params.projectId) : selectedProvider());
  if (!aggregate && method !== 'thread/archive' && !supports(method, provider)) return Promise.reject(new Error(`${agentName(provider)} does not support ${method}.`));
  return api.rpc(method, params, aggregate ? undefined : { provider, ...(repairReasoning ? { repairReasoning: true } : {}) });
}
function reportProviderErrors(errors = []) {
  if (!errors.length) return;
  const message = [...new Set(errors.map(error => `${error.provider ? agentName(error.provider) + ': ' : ''}${error.message}`))].join('\n');
  if (state.providerError === message) return;
  showError(message); state.providerError = message;
}
async function refreshAgentCatalogs() {
  const generation = agents.generation = (agents.generation || 0) + 1, options = state.options;
  const results = await Promise.allSettled([rpc('model/list', { limit: 100 }), supportsAny('collaborationMode/list') ? rpc('collaborationMode/list') : Promise.resolve({ data: [] })]);
  if (options !== state.options || generation !== agents.generation) return;
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') { showError(result.reason); continue; }
    const previous = index === 0 ? state.models : modes.catalog;
    const failed = new Set([
      ...(result.value.errors || []).map(error => error.provider),
      ...(state.options?.agents || []).filter(agent => agent.connected === false).map(agent => agent.id)
    ]);
    const data = [...result.value.data, ...previous.filter(entry => failed.has(entry.provider || identityProvider(entry.model)))];
    if (index === 0) state.models = data; else modes.catalog = data;
    reportProviderErrors(result.value.errors);
  }
  renderModels();
}
function syncComposerAgent() {
  const provider = selectedProvider();
  for (const option of $('model').options) option.disabled = option.dataset.unavailable === 'true' || Boolean(state.thread && identityProvider(option.value) !== provider) || agentMetadata(identityProvider(option.value))?.connected === false;
  if (state.thread && identityProvider($('model').value) !== provider) $('model').value = agentMetadata(provider)?.defaultModel ?? (provider === 'codex' ? '' : `agent:${provider}:model:`);
  const changedProvider = agents.current !== provider;
  const usageModel = provider === 'zcode' ? $('model').value : null;
  if (changedProvider) {
    agents.current = provider;
    slash.generation++; slash.skills = []; slash.cwd = null; slash.loading = false; hideSlash();
    if ($('usage-panel').matches(':popover-open')) $('usage-panel').hidePopover();
  }
  if (changedProvider || usage.model !== usageModel) {
    usage.model = usageModel;
    usage.generation++; usage.account = null; usage.reading = null; usage.error = null; usage.updatedAt = 0;
    if (state.connected && !state.connecting) refreshUsage();
  }
  connectionLabels();
}
function renderModels() {
  const previous = $('model').value;
  const available = (state.options?.agents || agents.available).filter(agent => agent.available !== false && (agent.enabled !== false && agent.connected !== false || agent.id === selectedProvider()));
  if (!available.length) available.push({ id: 'codex', name: 'Codex' });
  $('model').replaceChildren();
  for (const agent of available) {
    const group = document.createElement('optgroup'); group.label = agent.name;
    group.append(new Option(available.length > 1 ? `${agent.name} default` : isLocal() ? 'Local default model' : 'Server default model', agent.defaultModel ?? (agent.id === 'codex' ? '' : `agent:${agent.id}:model:`)));
    for (const model of state.models.filter(model => (model.provider || identityProvider(model.model)) === agent.id)) group.append(new Option(model.displayName || model.nativeModel || model.model, model.model));
    $('model').append(group);
  }
  if (previous || [...$('model').options].some(option => option.value === previous)) selectSavedModel(previous);
  syncComposerAgent(); updateEfforts(); updateBusy();
}
function selectSavedModel(model) {
  if (![...$('model').options].some(option => option.value === model)) {
    const option = new Option(`${agentName(identityProvider(model))} · saved model unavailable`, model);
    option.dataset.unavailable = 'true'; option.disabled = true;
    $('model').append(option);
  }
  $('model').value = model;
}
function trace(event, details) { try { api.log?.(event, details); } catch {} }
function composerTarget() { return { machine: accessKey(), kind: 'composer', threadId: state.thread?.id || null, cwd: state.thread?.cwd || $('workspace').value.trim(), projectId: state.thread?.projectId || projects.selected || null }; }
const composerExpected = saved => Object.fromEntries(['text', 'hours', 'model', 'effort', 'mode', 'access'].map(key => [key, saved?.[key] ?? null]));
function composerSnapshot() { return { text: $('prompt').value, hours: Number($('send-time').value), model: $('model').value, effort: $('effort').value, mode: modes.plan ? 'plan' : 'default', access: $('permissions').value }; }
function scheduleComposerDraft() {
  if (!api.saveDraft || !drafts.target || drafts.suspended || drafts.restoring || state.sending || state.loading) return;
  drafts.dirty = true;
  clearTimeout(drafts.timer);
  drafts.timer = setTimeout(() => saveComposerDraft(true), composerAutosaveDelay);
}
function saveComposerDraft(deferred = false) {
  clearTimeout(drafts.timer); drafts.timer = null;
  if (!api.saveDraft || !drafts.target || drafts.suspended || drafts.restoring || state.sending || state.loading) return false;
  const pending = drafts.autosave;
  if (deferred && pending) return false;
  const target = drafts.target, snapshot = composerSnapshot(), images = state.images.filter(image => image.url);
  const changedImages = images.length !== drafts.images.length || images.some((image, index) => image !== drafts.images[index]?.image || image.url !== drafts.images[index]?.url);
  if (!pending && !changedImages && drafts.snapshot && Object.keys(snapshot).every(key => snapshot[key] === drafts.snapshot[key])) {
    const recheckSync = deferred && drafts.dirty && drafts.syncedRevision !== conversationSync.status?.draftRevision;
    drafts.dirty = false;
    if (recheckSync && conversationSync.status?.draftRevision != null) refreshConversationSync().catch(showError);
    return true;
  }
  const patch = { ...snapshot, ...(changedImages || pending?.hasImages ? { images } : {}) };
  const saved = () => {
    drafts.expected = composerExpected(snapshot.text || images.length ? snapshot : null);
    drafts.snapshot = snapshot;
    drafts.images = images.map(image => ({ image, url: image.url }));
    const current = composerSnapshot();
    drafts.dirty = Object.keys(snapshot).some(key => snapshot[key] !== current[key]);
    if (!drafts.dirty) cacheDraftIndicator(target, Boolean(snapshot.text.trim() || images.length));
  };
  const failed = error => {
    drafts.dirty = true;
    trace('draft.save.failed', { threadId: target.threadId, error: error.message });
    showError(`Could not save unsent draft: ${error.message}`);
  };
  if (deferred && api.autosaveDraft) {
    const request = { id: crypto.randomUUID(), hasImages: changedImages };
    drafts.autosave = request;
    api.autosaveDraft(target, patch, drafts.expected, request.id).then(() => {
      if (drafts.autosave !== request) return;
      drafts.autosave = null;
      saved();
      if (drafts.dirty && !drafts.timer) scheduleComposerDraft();
    }, error => {
      if (drafts.autosave !== request) return;
      drafts.autosave = null; failed(error);
    });
    return false;
  }
  drafts.autosave = null;
  try {
    api.saveDraft(target, patch, drafts.expected, pending?.id);
    saved();
    return true;
  } catch (error) { failed(error); return false; }
}
const editorDraftKey = target => JSON.stringify([target.machine, target.kind, target.threadId, target.itemId]);
function clearDraft(target, expected = target && editorDrafts.get(editorDraftKey(target))?.expected) {
  if (!target) return;
  const key = editorDraftKey(target);
  if (target.kind === 'edit-message') editorDrafts.delete(key);
  if (!api.clearDraft) return;
  try { api.clearDraft(target, expected); editorDrafts.delete(key); cacheDraftIndicator(target, false); } catch (error) { showError(`Could not clear saved draft: ${error.message}`); }
}
function cacheDraftIndicator(target, pending) {
  if (target?.kind !== 'composer' || !target.threadId) return;
  const key = target.machine + ':' + target.threadId;
  if (drafts.indicators?.machine === target.machine) drafts.indicators.localChanges.add(target.threadId);
  if (drafts.pending.get(key) === pending) return;
  drafts.pending.set(key, pending); if (target.machine === accessKey()) renderThreadIndicators(target.threadId);
}
function editorTarget(kind, thread, itemId) { return { machine: accessKey(), kind, threadId: thread.id, cwd: thread.cwd, projectId: thread.projectId || null, itemId }; }
function editorText(target, text) {
  const key = editorDraftKey(target);
  const previous = editorDrafts.get(key);
  if (previous?.unsaved) return previous.unsaved.text;
  try {
    const saved = api.draft?.(target);
    editorDrafts.set(key, { fallback: text, expected: { text: saved?.text ?? null, ...(target.kind === 'edit-schedule' ? { runAt: saved?.runAt ?? null } : {}) } });
    return saved?.text ?? text;
  } catch (error) { showError(`Could not restore editor draft: ${error.message}`); return text; }
}
function saveEditorDraft(target, text, settings = {}) {
  if (!target || !api.saveDraft) return;
  const key = editorDraftKey(target), previous = editorDrafts.get(key);
  try {
    api.saveDraft(target, { text, ...settings }, previous?.expected);
    editorDrafts.set(key, { fallback: previous?.fallback ?? text, expected: { text, ...settings } });
  } catch (error) {
    if (target.kind === 'edit-message') editorDrafts.set(key, { ...previous, unsaved: { text, error: error.message } });
    else showError(`Could not save editor draft: ${error.message}`);
  }
}
function refreshEditorDrafts(before) {
  const editors = [[!$('edit-message-form').hidden && !state.resending, 'edited-message', state.messageEdit], [$('edit-queue-dialog').open, 'queued-text', state.queueEdit], [$('edit-schedule-dialog').open, 'scheduled-text', schedules.editing]];
  for (const [open, input, editor] of editors) {
    if (!open || !editor?.draftTarget || editor.saving) continue;
    const key = editorDraftKey(editor.draftTarget), previous = editorDrafts.get(key);
    if (!previous || previous.unsaved || previous !== before.get(key)) continue;
    const saved = api.draft(editor.draftTarget), value = saved?.text ?? previous.fallback, control = $(input);
    if (control.value !== value) {
      const { selectionStart, selectionEnd, selectionDirection, scrollTop } = control;
      control.value = value; control.setSelectionRange(Math.min(selectionStart, value.length), Math.min(selectionEnd, value.length), selectionDirection); control.scrollTop = scrollTop;
    }
    const expected = { text: saved?.text ?? null };
    if (editor.draftTarget.kind === 'edit-schedule') { $('scheduled-time').value = saved?.runAt ?? editor.time; expected.runAt = saved?.runAt ?? null; }
    editorDrafts.set(key, { fallback: previous.fallback, expected });
  }
}
function activateComposerDraft() {
  if (!api.draft || drafts.suspended || drafts.target) return;
  const target = composerTarget(); drafts.restoring = true;
  try {
    const saved = api.draft(target);
    drafts.target = target;
    drafts.syncedRevision = conversationSync.status?.draftRevision;
    drafts.expected = composerExpected(saved);
    if (saved) {
      $('prompt').value = saved.text; state.images = saved.images; $('send-time').value = String(saved.hours ?? 0);
      if (typeof saved.model === 'string') selectSavedModel(saved.model);
      syncComposerAgent();
      updateEfforts(saved.effort);
      if (['read-only', 'workspace-write', 'danger-full-access'].includes(saved.access)) $('permissions').value = saved.access;
      modes.plan = saved.mode === 'plan'; if (state.thread) modes.threads.set(state.thread.id, modes.plan);
    } else { $('prompt').value = ''; state.images = []; $('send-time').value = '0'; }
    renderImages(); drafts.snapshot = composerSnapshot(); drafts.images = state.images.map(image => ({ image, url: image.url })); drafts.dirty = false;
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
    if (state.options !== options || state.thread?.id !== result.thread.id) return;
    if (saved.target.kind === 'edit-message') {
      const nativeEdit = supportsNativeEdit(result.thread);
      const legacyNativeDraft = nativeEdit && saved.target.itemId.startsWith(`agent:${threadProvider(result.thread)}:turn:`);
      const messagesInTurn = () => [...state.items.values()].filter(record => record.turnId === saved.target.itemId && record.item.type === 'userMessage');
      const find = () => nativeEdit ? state.items.get(saved.target.itemId) || messagesInTurn()[0] : messagesInTurn()[0];
      const selection = state.selection;
      while (!legacyNativeDraft && !find() && state.turnCursor) {
        const cursor = state.turnCursor;
        await $('older-turns').onclick();
        if (state.options !== options || state.selection !== selection) return;
        if (cursor === state.turnCursor) break;
      }
      if (state.options !== options || state.thread?.id !== result.thread.id) return;
      const record = find();
      if (record?.item.type === 'userMessage' && !state.active.has(result.thread.id)) {
        if (!nativeEdit && openMessageEdit(record)) return;
        if (nativeEdit && record.item.canEdit === true) {
          if (record.item.id === saved.target.itemId && openMessageEdit(record)) return;
          // A page boundary can split a ZCode turn across pages.
          if (legacyNativeDraft && !state.turnCursor && messagesInTurn().length === 1 && api.moveDraft) {
            const target = editorTarget('edit-message', result.thread, record.item.id);
            if (!api.draft?.(target)) {
              api.moveDraft(saved.target, target);
              if (openMessageEdit(record)) return;
            }
          }
        }
      }
      if (nativeEdit && api.editDrafts) {
        showError('Your edit draft is saved. Right-click the conversation and choose Recover edit drafts.');
        return;
      }
      if (!$('prompt').value) { $('prompt').value = saved.draft.text; saveComposerDraft(); }
    } else if (saved.target.kind === 'edit-queue') {
      const queue = state.queues.get(queueKey(result.thread.id)); const message = queue?.messages.find(message => message.draftId === saved.target.itemId);
      if (message) editQueuedMessage(queue, message);
      else if (!$('prompt').value) { $('prompt').value = saved.draft.text; saveComposerDraft(); }
    } else if (saved.target.kind === 'edit-schedule') {
      const task = schedules.tasks.find(task => task.id === saved.target.itemId && task.status === 'pending');
      if (task) await openScheduledEdit(task);
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
  const saved = await api.savePreferences(patch);
  const messagePins = preferences.messagePins;
  Object.assign(preferences, saved);
  preferences.conversationStates = markers;
  preferences.threadOrders = orders;
  preferences.threadOrderCutoffs = cutoffs;
  preferences.messagePins = messagePins;
  renderShortcutSaveStatus(saved.shortcutMoveQueued);
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
$('skip-test-diffs').onchange = async () => {
  const control = $('skip-test-diffs'); const previous = preferences.skipTestDiffs !== false;
  control.disabled = true;
  try { await savePreferences({ skipTestDiffs: control.checked }); }
  catch (error) { control.checked = previous; showError(error); }
  finally { control.disabled = false; }
};
function playCompletionSound(preview = false) {
  if (!preview && (preferences.completionSound === false || performance.now() - completionSound.lastAt < 3000)) return;
  const volume = Number($('completion-volume').value) / 100;
  if (!volume) return;
  const failed = error => {
    trace('completion-sound.failed', { phase: preview ? 'preview' : 'completion', error: error.message });
    if (preview) showError(`Could not play sound: ${error.message}`);
  };
  try {
    if (!completionSound.audio) {
      completionSound.audio = new Audio('assets/completion.wav');
      completionSound.audio.onended = () => trace('completion-sound.ended');
    }
    const audio = completionSound.audio; audio.volume = volume; audio.pause(); audio.currentTime = 0;
    completionSound.lastAt = performance.now();
    return audio.play().then(() => trace('completion-sound.started', { phase: preview ? 'preview' : 'completion', status: `${Math.round(volume * 100)}%` }), failed);
  } catch (error) { failed(error); }
}
function setCompletionVolume(value) {
  $('completion-volume').value = String(value); $('completion-volume-value').value = `${value}%`;
  if (completionSound.audio) completionSound.audio.volume = value / 100;
}
$('completion-volume').oninput = () => setCompletionVolume(Number($('completion-volume').value));
$('completion-volume').onchange = async () => {
  const control = $('completion-volume'); const previous = preferences.completionVolume ?? 50;
  control.disabled = true;
  try { await savePreferences({ completionVolume: Number(control.value) }); setCompletionVolume(preferences.completionVolume ?? 50); }
  catch (error) { setCompletionVolume(previous); showError(error); }
  finally { control.disabled = false; }
};
$('completion-sound').onchange = async () => {
  const control = $('completion-sound'); const previous = preferences.completionSound !== false;
  control.disabled = true;
  try { await savePreferences({ completionSound: control.checked }); if (!control.checked) completionSound.audio?.pause(); }
  catch (error) { control.checked = previous; showError(error); }
  finally { control.disabled = false; }
};
$('preview-completion-sound').onclick = () => playCompletionSound(true);

function connectionLabels() {
  if (!state.options) return;
  const local = isLocal();
  const name = agentName();
  $('server-host').textContent = local ? 'This machine' : state.options.host;
  $('machine-badge').textContent = local ? 'LOCAL' : 'REMOTE';
  $('welcome-eyebrow').textContent = local ? `${name.toUpperCase()} ON YOUR MACHINE` : 'A LOCAL WINDOW TO YOUR SERVER';
  $('welcome-description').textContent = `Talk to ${name} here. Your code and commands run on ${local ? 'this' : 'your remote'} machine.`;
  $('workspace-label').textContent = local ? 'Local workspace' : 'Server workspace';
  $('workspace').setAttribute('aria-label', $('workspace-label').textContent);
  $('transport-note').textContent = local ? `Local connection · ${name} runs on this machine` : `Encrypted SSH connection · ${name} runs remotely`;
  const permissions = $('permissions'), provider = selectedProvider(), permissionOptions = agentMetadata(provider)?.permissionOptions;
  const labels = { 'read-only': 'Read only', 'workspace-write': 'Workspace access', 'danger-full-access': local ? 'Full local access' : 'Full server access' };
  for (const option of permissions.options) {
    const supported = permissionOptions?.find(entry => entry.value === option.value);
    option.hidden = option.disabled = Boolean(permissionOptions && !supported);
    option.textContent = supported?.label || labels[option.value];
  }
  if (permissions.dataset.provider !== provider && !drafts.restoring && permissions.selectedOptions[0]?.disabled) permissions.value = 'workspace-write';
  permissions.dataset.provider = provider;
  permissions.title = permissions.selectedOptions[0]?.disabled ? `This saved access setting is unsupported by ${name}. Choose an available option.` : 'Full access runs commands without approval prompts.';
  $('folder-title').textContent = local ? 'Choose a local folder' : 'Choose a server folder';
  $('folder-description').textContent = `Choose where ${name} should work ${local ? 'on this machine' : 'on the server'}. Any folder can be a project.`;
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
  const local = $('connection-mode').value === 'local';
  const current = state.options || {};
  const executablePath = local ? $('codex-path').value : providerPreference(current, 'codex').executablePath;
  const providerOptions = { ...state.options?.providerOptions };
  const paths = new Map([...document.querySelectorAll('input[data-provider-path]')].map(input => [input.dataset.providerPath, local ? input.value : providerPreference(current, input.dataset.providerPath).executablePath]));
  for (const input of $('provider-settings').querySelectorAll('input[data-provider]')) providerOptions[input.dataset.provider] = { ...providerOptions[input.dataset.provider], enabled: input.checked, executablePath: paths.get(input.dataset.provider) ?? providerPreference(current, input.dataset.provider).executablePath };
  return { provider: 'codex', mode: $('connection-mode').value, sharedServer: local ? Boolean(current.sharedServer) : $('shared-server').checked, ...Object.fromEntries(['host', 'port', 'key', 'cwd'].map(key => [key, local ? current[key] : $(key === 'cwd' ? 'default-cwd' : key).value])), localCwd: local ? $('local-cwd').value : current.localCwd, executablePath, ...(Object.keys(providerOptions).length ? { providerOptions } : {}) };
}
function providerPreference(options, id) {
  const agent = options?.agents?.find(agent => agent.id === id) || agentMetadata(id);
  return { enabled: options?.providerOptions?.[id]?.enabled ?? agent?.enabled ?? agent?.defaultEnabled ?? true, executablePath: String(options?.providerOptions?.[id]?.executablePath ?? (id === 'codex' ? options?.executablePath ?? options?.codexPath : '') ?? '').trim() };
}
function changedProviders(next) {
  const ids = new Set(['codex', ...(state.options?.agents || agents.available).map(agent => agent.id), ...Object.keys(state.options?.providerOptions || {}), ...Object.keys(next.providerOptions || {})]);
  return [...ids].filter(id => JSON.stringify(providerPreference(next, id)) !== JSON.stringify(providerPreference(state.options, id)));
}
function machineSettingsChanged(next) {
  const current = state.options || {};
  const fields = next.mode === 'local' ? ['localCwd'] : ['host', 'port', 'key', 'cwd'];
  return next.mode !== (current.mode || 'ssh') || next.mode === 'ssh' && Boolean(next.sharedServer) !== Boolean(current.sharedServer) || fields.some(key => key === 'port' ? Number(next[key] ?? 22) !== Number(current[key] ?? 22) : String(next[key] || '').trim() !== String(current[key] || '').trim());
}
function connectionSettingsChanged(next = settingsConnectionOptions()) {
  return machineSettingsChanged(next) || changedProviders(next).length > 0;
}
function renderProviderSettings(options) {
  const available = options.agents || agents.available;
  $('provider-settings').replaceChildren();
  for (const agent of available.length ? available : [{ id: 'codex', name: 'Codex' }]) {
    const label = document.createElement('label'); label.className = 'provider-setting';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.provider = agent.id; input.checked = providerPreference(options, agent.id).enabled;
    const text = document.createElement('span'); text.textContent = agent.name;
    const detail = document.createElement('small'); detail.textContent = agent.available === false ? 'Adapter not installed yet' : agent.connected ? 'Connected' : 'Starts when enabled';
    text.append(detail); label.append(input, text); $('provider-settings').append(label);
  }
}
function connectionBusy() {
  const working = thread => thread?.status?.type === 'active';
  return state.connected && Boolean(state.active.size || state.dispatching.size || state.sending || state.commandBusy || working(state.thread) || state.threads.some(working) || [...state.pinnedThreads.values()].some(working));
}
function settingsBusy(next = settingsConnectionOptions()) {
  if (machineSettingsChanged(next)) return connectionBusy();
  const changed = new Set(changedProviders(next));
  return state.connected && (state.sending || state.commandBusy || [...state.active.keys()].some(id => changed.has(identityProvider(id))) || [...state.threads, ...state.pinnedThreads.values(), state.thread].some(thread => thread?.status?.type === 'active' && changed.has(threadProvider(thread))));
}
function updateSettingsActions() {
  $('save-connect').hidden = state.connected && !connectionSettingsChanged();
  $('save-connect').disabled = state.connecting || state.recovering || settingsBusy();
  $('save-connect').title = settingsBusy() ? 'Finish or stop affected tasks before changing these settings' : '';
}

function fillSettings(options) {
  $('skip-test-diffs').checked = preferences.skipTestDiffs !== false;
  $('completion-sound').checked = preferences.completionSound !== false;
  setCompletionVolume(preferences.completionVolume ?? 50);
  $('file-opener').value = preferences.fileOpener || 'vscode';
  $('file-opener').querySelector('[value="reveal"]').textContent = navigator.platform.includes('Mac') ? 'Show in Finder' : 'Show in file manager';
  $('connection-mode').value = options.mode || 'ssh';
  $('host').value = options.host;
  $('port').value = options.port;
  $('key').value = options.key;
  $('shared-server').checked = Boolean(options.sharedServer);
  $('default-cwd').value = options.cwd;
  $('local-cwd').value = options.localCwd || '';
  for (const input of document.querySelectorAll('input[data-provider-path]')) input.value = providerPreference(options, input.dataset.providerPath).executablePath;
  renderProviderSettings(options);
  settingsMode();
}

function isWriterConflict(error) { return /already has an active writer/i.test(error.message || String(error)); }
function errorMessage(raw) {
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
  let value = cleaned, message = cleaned, code;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { message = value; break; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) break;
    if (typeof value.code === 'string' || typeof value.code === 'number') code = value.code;
    if (value.error && typeof value.error === 'object') { value = value.error; continue; }
    if (typeof value.message !== 'string') break;
    message = value.message; value = message;
  }
  return code === undefined ? message : `${message} (${code})`;
}
function showError(error) {
  state.retryError = null;
  state.titleError = null;
  state.providerError = null;
  const raw = error.message || String(error);
  let message = errorMessage(raw);
  if (isWriterConflict(error)) {
    if (state.writerConflicts.has(queueKey(state.thread?.id))) { $('error').hidden = true; updateBusy(); return; }
    message = `Another ${agentName()} session owns this chat.`;
  }
  $('error-text').textContent = message; $('error-text').title = raw;
  $('error-text').scrollTop = 0;
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
function conversationAccess() {
  if (state.options?.mode !== 'local' || selectedProvider() !== 'codex' || !state.thread) return null;
  const access = conversationSync.ownership.get(state.thread.id);
  return (conversationSync.historyEnabled || conversationSync.status?.enabled && access?.waiting) ? access : null;
}
function conversationReadOnly() { const access = conversationAccess(); return Boolean(access && (!access.owned || access.requested)); }
function syncBelongsHere(entry) {
  let { kind, id, machine } = entry;
  if (!id && entry.key) { try { [kind, machine, id] = JSON.parse(entry.key); } catch { return false; } }
  if (kind === 'shortcuts') return true;
  if (machine && machine !== accessKey()) return false;
  if (kind === 'draft' || kind === 'messagePin') { try { const parts = JSON.parse(id); id = kind === 'draft' ? parts[1] : parts[0]; } catch { return false; } }
  return typeof id === 'string' && id === state.thread?.id;
}
function renderHeaderSync() {
  const indicator = $('conversation-sync-status'), access = conversationAccess();
  const sync = conversationSync.statusOptions === state.options ? conversationSync.status : null;
  const failure = sync?.historyErrors?.find(entry => entry.id === state.thread?.id)?.message || sync?.queueErrors?.find(syncBelongsHere)?.message || sync?.conflicts?.find(syncBelongsHere) && 'Changes need your choice' || sync?.error;
  indicator.hidden = !state.thread || !failure && !access?.syncPending;
  indicator.dataset.status = failure ? 'error' : 'pending';
  indicator.setAttribute('aria-label', failure ? 'Sync needs attention' : 'History upload pending');
  $('conversation-sync-tooltip').textContent = failure ? 'Sync needs attention: ' + failure : 'History upload pending';
  const panel = $('conversation-sync-panel'), target = queueKey(state.thread?.id);
  if (indicator.hidden || panel.dataset.target !== target) {
    if (panel.matches(':popover-open')) panel.hidePopover();
    hideSyncTooltip();
  }
  panel.dataset.target = target;
  positionSyncPanel($('conversation-sync-tooltip'));
}
function positionSyncPanel(panel = $('conversation-sync-panel')) {
  if (!panel.matches(':popover-open')) return;
  const anchor = $('conversation-sync-status').getBoundingClientRect(), bounds = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(12, Math.min(innerWidth - bounds.width - 12, anchor.right - bounds.width))}px`;
  panel.style.top = `${Math.max(12, Math.min(innerHeight - bounds.height - 12, anchor.bottom + 10))}px`;
}
function hideSyncTooltip() {
  const tooltip = $('conversation-sync-tooltip');
  if (tooltip.matches(':popover-open')) tooltip.hidePopover();
}
function showSyncTooltip() {
  if ($('conversation-sync-status').hidden || $('conversation-sync-panel').matches(':popover-open')) return;
  const tooltip = $('conversation-sync-tooltip');
  if (!tooltip.matches(':popover-open')) tooltip.showPopover();
  positionSyncPanel(tooltip);
}
$('conversation-sync-status').onpointerenter = showSyncTooltip;
$('conversation-sync-status').onpointerleave = hideSyncTooltip;
$('conversation-sync-status').onfocus = showSyncTooltip;
$('conversation-sync-status').onblur = hideSyncTooltip;
$('conversation-sync-status').onclick = () => {
  hideSyncTooltip();
  const panel = $('conversation-sync-panel');
  if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
  renderConversationSyncNotice();
  if ($('conversation-sync-status').hidden) return;
  panel.showPopover(); positionSyncPanel();
};
$('conversation-sync-panel').addEventListener('toggle', event => $('conversation-sync-status').setAttribute('aria-expanded', String(event.newState === 'open')));
$('close-conversation-sync').onclick = () => $('conversation-sync-panel').hidePopover();
addEventListener('resize', () => { positionSyncPanel(); positionSyncPanel($('conversation-sync-tooltip')); });
function renderConversationAccess() {
  const access = conversationAccess(), panel = $('conversation-ownership');
  panel.hidden = !access || access.owned && !access.requested && !access.needsHistory;
  $('conversation-owner').textContent = !access ? '' : access.owned ? access.requested ? 'Transfer requested · finish the current task to hand over' : access.needsHistory ? 'Load the shared history to continue on this computer' : '' : access.waiting ? `Waiting for ${access.name} to finish and sync` : `${access.busy ? 'Running on' : 'Read only · owned by'} ${access.name}`;
  const button = $('take-conversation'); button.hidden = Boolean(access?.owned); button.textContent = access?.waiting ? 'Transfer requested' : 'Use on this computer';
  button.disabled = !state.connected || state.loading || state.sending || Boolean(access?.waiting) || Boolean(conversationSync.requesting);
  $('cancel-conversation-request').hidden = !access?.waiting;
  $('cancel-conversation-request').disabled = Boolean(conversationSync.requesting);
  $('load-synced-history').hidden = !access?.updatesAvailable;
  $('load-synced-history').disabled = state.loading || state.sending || state.active.has(state.thread?.id);
  renderHeaderSync();
}
$('load-synced-history').onclick = () => { if (state.thread && !state.loading && !state.sending && !state.active.has(state.thread.id)) return openThread(state.thread, true, true).then(refreshConversationSync).catch(showError); };
$('take-conversation').onclick = async () => {
  if (!state.thread || conversationSync.requesting) return;
  const thread = state.thread, options = state.options;
  conversationSync.requesting = true; renderConversationAccess();
  try { await api.requestConversation(thread.id); if (state.options === options) await refreshConversationSync(); }
  catch (error) { if (state.options === options) showError(error); }
  finally { conversationSync.requesting = false; renderConversationAccess(); }
};
$('cancel-conversation-request').onclick = async () => {
  if (!state.thread || !conversationAccess()?.waiting || conversationSync.requesting) return;
  const thread = state.thread, options = state.options;
  conversationSync.requesting = true; renderConversationAccess();
  try { await api.cancelConversationRequest(thread.id); if (state.options === options) await refreshConversationSync(); }
  catch (error) { if (state.options === options) showError(error); }
  finally { conversationSync.requesting = false; renderConversationAccess(); }
};
function updateSendButton() {
  const stop = canStopTurn();
  const busy = state.owned.has(state.thread?.id) && state.active.has(state.thread?.id);
  const interrupting = Boolean(state.interrupting && state.interrupting.options === state.options && state.interrupting.threadId === state.thread?.id && state.interrupting.turnId === state.active.get(state.thread?.id));
  $('send').hidden = false; $('send').type = stop ? 'button' : 'submit';
  $('send').textContent = stop ? '■' : '↑'; $('send').classList.toggle('stop-send', stop);
  $('send').title = stop ? 'Stop task' : busy ? 'Send after the current turn finishes' : 'Send message';
  $('send').setAttribute('aria-label', stop ? 'Stop task' : 'Send message');
  $('send').disabled = !stop && modelUnavailable() || agentMetadata(selectedProvider())?.connected === false || !state.connected || state.connecting || state.sending || state.commandBusy || state.loading || interrupting || queueLocked(state.queues.get(queueKey(state.thread?.id))) || state.images.some(image => !image.url);
  if (!stop && (state.messageEdit || conversationReadOnly())) $('send').disabled = true;
  $('send-time').disabled = $('send').disabled;
  renderConversationAccess();
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
  renderFinishedButton();
  renderConversationSyncNotice();
  for (const button of $('shortcut-buttons').children) button.disabled = shortcutUnavailable({ mode: button.dataset.mode });
  const compact = state.connected && compacting.has(state.thread?.id);
  const busy = compact || state.owned.has(state.thread?.id) && Boolean(state.active.get(state.thread?.id));
  const waiting = interactionStatus(state.thread?.id);
  $('writer-notice').hidden = !state.writerConflicts.has(queueKey(state.thread?.id));
  $('activity').hidden = !$('writer-notice').hidden && !busy && !state.sending && !state.loading;
  $('retry-writer').disabled = state.sending || state.loading || !state.connected;
  updateSendButton();
  updateSettingsActions();
  $('attach-images').disabled = state.sending || state.loading;
  $('prompt').disabled = state.loading || state.connecting || drafts.suspended;
  $('prompt').readOnly = state.sending || Boolean(state.commandBusy);
  $('timeline').classList.toggle('loading', state.loading && !state.historyView);
  $('activity').classList.toggle('busy', busy && !waiting);
  $('activity').classList.toggle('waiting', Boolean(waiting));
  $('activity').textContent = state.sending ? 'Sending…' : state.loading ? (state.historyView ? 'Refreshing conversation…' : 'Loading conversation…') : waiting || (compact ? 'Compacting context…' : busy ? `${agentName()} is working ${isLocal() ? 'locally' : 'on the server'}…` : '');
  $('model').disabled = state.loading || busy;
  $('effort').disabled = state.loading || busy;
  $('permissions').disabled = state.loading || busy;
  $('new-chat').disabled = state.connecting || state.sending || state.commandBusy;
  $('plan-mode').hidden = !modes.plan;
  $('browse-workspace').disabled = !state.connected || state.sending || state.loading;
  $('choose-project').disabled = !state.connected || state.sending || state.loading;
  renderQueue();
  renderSchedules();
  renderThreadIndicators();
  renderUsage();
  renderMessagePins();
  updateMessageEdits();
  if (!drafts.timer && !drafts.autosave && !drafts.dirty) saveComposerDraft();
}
function updateMessageEdits() {
  const turns = new Set();
  const nativeEdit = supportsNativeEdit(state.thread);
  const readOnly = conversationReadOnly();
  const running = state.active.has(state.thread?.id);
  $('resend-message').disabled = Boolean(state.resending || state.messageEdit?.uncertain || readOnly || running);
  $('cancel-message-edit').disabled = Boolean(state.resending);
  $('edited-message').readOnly = Boolean(state.resending);
  for (const button of $('timeline').querySelectorAll('.edit-message')) {
    const turnId = button.dataset.turnId;
    button.hidden = turns.has(turnId) || Boolean(nativeEdit && button.dataset.canEdit !== 'true');
    if (!button.hidden) turns.add(turnId);
    button.disabled = readOnly || state.sending || state.commandBusy || state.loading || state.historyLoadFailed || running
      || (nativeEdit ? Boolean(state.nativeQueues.get(state.thread?.id)?.items.length) : !state.connected || modelUnavailable() || !supports('thread/revert'));
    button.title = running ? 'Stop the running task before editing' : 'Edit and resend in this conversation';
  }
}
function supportsNativeEdit(thread) {
  return agentMetadata(threadProvider(thread))?.methods?.includes('thread/edit') === true;
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
  if (!state.connected || usage.reading || !supports('account/rateLimits/read')) return;
  const request = { options: state.options, generation: usage.generation, updates: [] }; usage.reading = request;
  renderUsage();
  try {
    const model = selectedProvider() === 'zcode' ? $('model').value : '';
    const result = await rpc('account/rateLimits/read', { excludeResetCreditDetails: false, ...(model ? { model } : {}) });
    if (request.options !== state.options || request.generation !== usage.generation || !state.connected) return;
    usage.account = result;
    for (const snapshot of request.updates) applyRateLimit(snapshot);
    usage.updatedAt = Date.now(); usage.error = null;
  } catch (error) {
    if (request.options === state.options && request.generation === usage.generation) {
      if (selectedProvider() === 'zcode') usage.account = null;
      usage.error = error.message;
    }
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
  if (account?.plan) {
    if (account.plan.name) { const name = document.createElement('p'); name.textContent = account.plan.name; details.push(name); }
    details.push(usageDateRow('Plan ends', account.plan.expiresAt));
    if (account.plan.renewsAt) details.push(usageDateRow('Plan renews', account.plan.renewsAt));
  }
  const notices = [];
  if (account?.usageMessage) notices.push(account.usageMessage);
  if (!windows.length && !account?.usageMessage && !usage.error) notices.push(usage.reading ? 'Loading reset times…' : 'No reset time reported.');
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
function setTimelineFollowing(following, reading = null) {
  timelineView.following = following; timelineView.reading = reading;
  if (following) hidePinContext();
  $('jump-latest').hidden = following;
}
function timelineAtBottom() {
  const timeline = $('timeline');
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 24;
}
function scrollToBottom(force = false) {
  if (force) setTimelineFollowing(true);
  if (timelineView.following) $('timeline').scrollTop = $('timeline').scrollHeight;
}
$('jump-latest').onclick = () => { scrollToBottom(true); acknowledgeVisibleThread(); };
function currentMessagePins() { return preferences.messagePins?.[accessKey()]?.[state.thread?.id] || []; }
function updateMessagePinButton(record) {
  if (!record.pinButton) return;
  const pinned = currentMessagePins().some(pin => pin.itemId === record.item.id);
  record.pinButton.title = pinned ? 'Unpin message' : 'Pin message';
  record.pinButton.setAttribute('aria-label', record.pinButton.title);
  record.pinButton.setAttribute('aria-pressed', String(pinned));
  record.element.classList.toggle('message-pinned', pinned);
  record.pinButton.disabled = pinnedMessages.saving || state.loading;
}
function renderMessagePins() {
  const bar = $('pinned-messages'); const pins = currentMessagePins();
  const key = JSON.stringify([accessKey(), state.thread?.id, pins]);
  bar.hidden = !pins.length;
  if (bar.dataset.key !== key) {
    bar.dataset.key = key; bar.replaceChildren();
    for (const pin of pins) {
      const chip = document.createElement('span'); chip.className = 'pinned-message';
      const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'jump-pinned-message';
      jump.innerHTML = pinIcon;
      const preview = document.createElement('span'); preview.textContent = pin.preview; jump.append(preview);
      jump.title = `Go to pinned message: ${pin.preview}`;
      jump.onclick = () => jumpToMessagePin(pin).catch(showError);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'unpin-message'; remove.textContent = '×';
      remove.title = 'Unpin message'; remove.setAttribute('aria-label', `Unpin message: ${pin.preview}`);
      remove.onclick = () => saveMessagePin(pin, false).catch(showError);
      chip.append(jump, remove); bar.append(chip);
    }
  }
  for (const button of bar.querySelectorAll('button')) button.disabled = pinnedMessages.saving || state.loading || Boolean(pinnedMessages.jumping);
  for (const record of state.items.values()) updateMessagePinButton(record);
}
async function saveMessagePin(pin, pinned) {
  if (!state.thread || pinnedMessages.saving) return;
  const machine = accessKey(), threadId = state.thread.id;
  pinnedMessages.saving = true; renderMessagePins();
  try {
    const saved = await api.savePreferences({ messagePin: { machine, threadId, ...pin, pinned } });
    preferences.messagePins = saved.messagePins || {};
  } finally { pinnedMessages.saving = false; renderMessagePins(); scrollToBottom(); }
}
function hidePinContext() {
  if (pinnedMessages.context?.contains($('edit-message-form'))) {
    closeMessageEdit({ save: true });
    updateBusy();
  }
  pinnedMessages.context?.remove(); pinnedMessages.context = null;
}
function showPinContext(record) {
  const context = record.pinContext;
  if (!context) return;
  if (pinnedMessages.context !== context) hidePinContext();
  pinnedMessages.context = context;
  $('messages').before(context);
  context.querySelector('.load-pin-context').disabled = !state.turnCursor || Boolean(pinnedMessages.jumping);
  updateMessageEdits();
}
function renderPinnedItem(entry, pin) {
  if (entry.turnId !== pin.turnId || entry.item?.id !== pin.itemId) throw new Error('The coding agent returned a different pinned message.');
  const context = document.createElement('section'); context.className = 'pin-context'; context.setAttribute('aria-label', 'Pinned message');
  const body = document.createElement('div');
  const footer = document.createElement('div'); footer.className = 'pin-context-footer';
  const note = document.createElement('span'); note.textContent = 'More recent messages below';
  const load = document.createElement('button'); load.type = 'button'; load.className = 'subtle load-pin-context'; load.textContent = 'Load surrounding history';
  load.onclick = () => jumpToMessagePin(pin, true).catch(showError);
  footer.append(note, load); context.append(body, footer);
  const item = { ...entry.item, startedAtMs: entry.item.startedAtMs ?? entry.startedAtMs, completedAtMs: entry.item.completedAtMs ?? entry.completedAtMs };
  const record = renderItem(item, false, entry.turnId, body);
  if (!record) throw new Error('This pinned message cannot be displayed.');
  record.pinContext = context; showPinContext(record);
  return record;
}
async function jumpToMessagePin(pin, context = false) {
  if (!state.thread || state.loading || pinnedMessages.jumping) return;
  const operation = { selection: state.selection, started: performance.now(), source: 'cached', count: 0 };
  const find = () => { const record = state.items.get(pin.itemId); return record?.turnId === pin.turnId ? record : null; };
  pinnedMessages.jumping = operation; setTimelineFollowing(false, context ? find()?.element : null); renderMessagePins();
  const current = () => pinnedMessages.jumping === operation && state.selection === operation.selection;
  try {
    if (!find() && !context && agentMetadata(threadProvider(state.thread))?.methods?.includes('thread/items/read')) {
      if (!state.connected) throw new Error('Connect to load the pinned message.');
      try {
        const result = await rpc('thread/items/read', { threadId: state.thread.id, turnId: pin.turnId, itemIds: [pin.itemId] });
        if (!current()) return;
        if (!Array.isArray(result.data)) throw new Error('Invalid pinned-message response.');
        const entry = result.data.find(entry => entry.turnId === pin.turnId && entry.item?.id === pin.itemId);
        if (!entry) throw new Error('This pinned message is no longer in the conversation. You can unpin it.');
        if (!find()) renderPinnedItem(entry, pin);
        operation.source = 'direct';
      } catch (error) {
        if (!current()) return;
        if (!/unknown (?:variant|method)|method.*not found|not support|unsupported.*(?:method|operation)|only.*paginated|legacy/i.test(error.message)) throw error;
        trace('pin.jump.fallback', { threadId: state.thread.id, turnId: pin.turnId, error: error.message });
      }
    }
    const seen = new Set();
    while ((!find() || context && find().pinContext) && state.turnCursor && !seen.has(state.turnCursor)) {
      if (!state.connected) throw new Error('Connect to load the pinned message.');
      operation.source = 'pages'; operation.count++;
      seen.add(state.turnCursor); await loadOlderTurns();
      if (!current()) return;
    }
    const record = find();
    if (!record) throw new Error('This pinned message is no longer in the conversation. You can unpin it.');
    if (record.pinContext) showPinContext(record); else hidePinContext();
    record.element.tabIndex = -1; record.element.focus({ preventScroll: true });
    setTimelineFollowing(false, record.element);
    $('timeline').scrollTop += record.element.getBoundingClientRect().top - $('timeline').getBoundingClientRect().top - 12;
    record.element.classList.add('pinned-target');
    setTimeout(() => record.element.classList.remove('pinned-target'), 1800);
    trace('pin.jump.completed', { threadId: state.thread.id, turnId: pin.turnId, source: operation.source, count: operation.count, durationMs: Math.round(performance.now() - operation.started) });
  } catch (error) { if (current()) throw error; }
  finally { if (pinnedMessages.jumping === operation) { pinnedMessages.jumping = null; if (pinnedMessages.context) pinnedMessages.context.querySelector('.load-pin-context').disabled = !state.turnCursor; renderMessagePins(); } }
}
function renderThreads() {
  if (threadDrag.source) { threadDrag.renderPending = true; return; }
  threadDrag.renderPending = false;
  const focusedThread = $('threads').contains(document.activeElement) ? document.activeElement.closest('.thread')?.dataset.threadId : null;
  const fragment = document.createDocumentFragment();
  const search = $('search').value.trim().toLowerCase();
  if (!state.connected && (search || state.threadSearch)) {
    const empty = document.createElement('p');
    empty.className = 'muted list-empty';
    empty.textContent = 'Connect to search conversations.';
    $('threads').replaceChildren(empty);
    $('more-threads').hidden = true;
    return;
  }
  const matchingIds = state.threadSearch?.term === search ? state.threadSearch.ids : null;
  const matchesSearch = thread => !search || matchingIds?.has(thread.id) || titleOf(thread).toLowerCase().includes(search);
  const projectIds = new Set(projects.data.map(project => project.id));
  const available = [...new Map([...state.pinnedThreads.values(), ...state.threads].map(thread => [thread.id, thread])).values()];
  const pinned = [...state.pinnedIds].map(id => available.find(thread => thread.id === id) || { id, preview: state.failedPins.has(id) ? 'Could not load conversation' : 'Loading conversation…' }).filter(thread => !projectIds.has(thread.projectId) && matchesSearch(thread));
  const recent = state.threads.filter(thread => !state.pinnedIds.has(thread.id) && !projectIds.has(thread.projectId) && matchesSearch(thread));
  const heading = (text, target = fragment) => {
    const label = document.createElement('div'); label.className = 'list-heading thread-group'; label.textContent = text; target.append(label);
  };
  const row = (thread, target = fragment) => {
    const projectId = thread.projectId || null;
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
    button.onclick = () => {
      button.focus({ preventScroll: true });
      if (state.thread?.id === thread.id && !state.historyLoadFailed) return;
      return openThread(thread).catch(showError);
    };
    button.draggable = state.connected && !threadDrag.orderPending.has(JSON.stringify([accessKey(), thread.projectId]));
    button.ondragstart = event => {
      if (!state.connected || !button.draggable || threadDrag.pending.has(queueKey(thread.id)) || state.archiving?.threadId === thread.id || !event.dataTransfer) { event.preventDefault(); return; }
      clearThreadDrag();
      clearProjectDrag();
      const searchGroups = $('threads').querySelectorAll('[data-search-hidden]');
      threadDrag.source = { threadId: thread.id, projectId, button, searchGroups, options: state.options, token: crypto.randomUUID() };
      event.dataTransfer.setData(threadDrag.type, threadDrag.source.token);
      event.dataTransfer.setData('text/plain', titleOf(thread)); event.dataTransfer.effectAllowed = 'move';
      button.classList.add('dragging'); $('thread-menu').hidden = true;
      for (const group of searchGroups) group.hidden = false;
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
    pin.innerHTML = pinIcon;
    pin.onclick = () => togglePin(thread).catch(showError);
    container.append(button, pin);
    target.append(container);
  };
  pinned.forEach(thread => row(thread));
  let hasProjectGroups = false;
  for (const project of projects.data) {
    const members = sortProjectThreads(available.filter(thread => thread.projectId === project.id && matchesSearch(thread)), project.id);
    const hiddenBySearch = Boolean(search && !members.length);
    if (!hiddenBySearch) hasProjectGroups = true;
    const group = document.createElement('section'); group.className = 'project-group'; group.dataset.projectId = project.id;
    if (hiddenBySearch) { group.dataset.searchHidden = 'true'; group.hidden = true; }
    if (!project.needsFolder) bindThreadDrop(group, project.id);
    const header = document.createElement('div'); header.className = 'project-heading';
    if (!project.needsFolder) bindProjectDrag(group, header, project);
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
    if (project.needsFolder) {
      const map = document.createElement('button'); map.className = 'project-more'; map.textContent = 'Choose folder on this computer…';
      map.onclick = () => chooseSharedProjectFolder(project).catch(showError); conversations.prepend(map);
    }
    if (!members.length && !search && !project.needsFolder) { const empty = document.createElement('p'); empty.className = 'project-empty'; empty.textContent = 'No conversations yet'; conversations.append(empty); }
    if (!search && projects.cursors.get(project.id)) {
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
  refreshDraftIndicators();
  for (const thread of available) requestTitle(thread);
}

async function loadProjects() {
  if (!supportsAny('project/list')) { projects.data = []; return true; }
  const generation = ++projects.generation; const options = state.options;
  const data = [], errors = []; let cursor = null;
  do { const page = await rpc('project/list', { limit: 100, cursor, sortKey: 'position', sortDirection: 'asc' }); data.push(...page.data); errors.push(...page.errors || []); cursor = page.nextCursor; } while (cursor && state.options === options && generation === projects.generation);
  if (state.options !== options || generation !== projects.generation) return false;
  const failed = new Set(errors.map(error => error.provider));
  for (const project of projects.data) if (failed.has(identityProvider(project.id)) && !data.some(entry => entry.id === project.id)) data.push(project);
  reportProviderErrors(errors);
  projects.data = data;
  if (!data.some(project => project.id === projects.selected)) projects.selected = null;
  for (const id of projects.expanded) if (!data.some(project => project.id === id)) projects.expanded.delete(id);
  return true;
}
async function refreshProjects() { if (state.connected && await loadProjects()) await loadThreads(); }
async function expandProject(project, load = true) {
  if (project.needsFolder) return chooseSharedProjectFolder(project);
  if (!state.connected || state.sending || state.commandBusy || state.loading || !projects.data.some(entry => entry.id === project.id) || !project.roots[0]?.path) return;
  projects.expanded.add(project.id); projects.collapsed.delete(project.id);
  renderThreads();
  if (load) await loadThreads();
}
async function restoreStartupProject() {
  const project = projects.data.find(entry => entry.id === preferences.startupProjects[accessKey()]);
  if (project?.roots[0]?.path) {
    projects.selected = project.id; $('workspace').value = project.roots[0].path;
    await expandProject(project, false);
  }
}
const normalizedFolder = value => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
function projectAtPath(path, provider = selectedProvider()) {
  return projects.data.find(project => identityProvider(project.id) === provider && project.roots.some(root => normalizedFolder(root.path) === normalizedFolder(path)));
}
function startProject(project) {
  if (project.needsFolder) { chooseSharedProjectFolder(project).catch(showError); return; }
  if (!state.connected || state.sending || state.commandBusy || !project.roots[0]?.path) return;
  projects.selected = project.id;
  $('workspace').value = project.roots[0].path;
  projects.collapsed.delete(project.id);
  resetThread();
}
function interactionStatus(threadId) {
  if (!state.connected || !threadId) return null;
  const request = [...state.requests.values()].find(request => !request.params.threadId || request.params.threadId === threadId);
  return request ? ['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(request.method) ? 'Waiting for your answer' : 'Waiting for your approval' : null;
}
function refreshDraftIndicators(refresh = false) {
  if (!api.draftIndicators) return;
  const machine = accessKey();
  if (drafts.indicators?.machine === machine) {
    drafts.indicators.again = true;
    drafts.indicators.refresh ||= refresh;
    return;
  }
  const visible = new Set([...$('threads').querySelectorAll('.thread')].map(button => button.dataset.threadId));
  if (refresh) {
    const current = new Set([...visible].map(id => machine + ':' + id));
    for (const key of drafts.pending.keys()) if (!current.has(key)) drafts.pending.delete(key);
  }
  const ids = [...visible].filter(id => refresh || !drafts.pending.has(machine + ':' + id));
  if (!ids.length) return;
  const request = { machine, localChanges: new Set(), again: false, refresh: false };
  drafts.indicators = request;
  api.draftIndicators(machine, ids).then(pending => {
    if (drafts.indicators !== request || machine !== accessKey() || request.refresh) return;
    const present = new Set(pending), changed = new Set();
    for (const id of ids) {
      if (request.localChanges.has(id)) continue;
      const key = machine + ':' + id, value = present.has(id);
      if (Boolean(drafts.pending.get(key)) !== value) changed.add(id);
      drafts.pending.set(key, value);
    }
    if (changed.size) renderThreadIndicators(changed);
  }).catch(error => {
    if (drafts.indicators === request && machine === accessKey()) showError(`Could not check unsent drafts: ${error.message}`);
  }).finally(() => {
    if (drafts.indicators !== request) return;
    drafts.indicators = null;
    if (request.again && machine === accessKey()) refreshDraftIndicators(request.refresh);
  });
}
function renderThreadIndicators(threadId = null) {
  renderFinishedButton();
  const finished = new Set(preferences.finishedThreads?.[accessKey()] || []);
  const threads = new Map([...state.threads, ...state.pinnedThreads.values()].map(thread => [thread.id, thread]));
  const selector = typeof threadId === 'string' ? `.thread[data-thread-id="${CSS.escape(threadId)}"]` : '.thread';
  for (const button of $('threads').querySelectorAll(selector)) {
    const id = button.dataset.threadId;
    if (threadId instanceof Set && !threadId.has(id)) continue;
    const thread = threads.get(id);
    const key = queueKey(id);
    const waiting = interactionStatus(id);
    const compact = state.connected && compacting.has(id);
    const working = !waiting && state.connected && (compact || state.active.has(id) || state.dispatching.has(key) || thread?.status?.type === 'active');
    const completion = state.completions.get(key);
    const interrupted = completion === 'interrupted';
    const unread = state.unread.has(key);
    const visibleDraft = state.thread?.id === id && drafts.target?.threadId === id && drafts.target.machine === accessKey() && !drafts.suspended && !state.loading;
    const pending = visibleDraft ? Boolean($('prompt').value.trim() || state.images.length) : drafts.pending.get(key);
    button.classList.toggle('unread', unread);
    button.classList.toggle('is-finished', finished.has(id));
    const label = waiting || (compact ? 'Compacting context…' : working ? 'Working…' : interrupted ? 'Interrupted' : pending ? 'Unsent prompt' : unread ? 'Unread' : completion === 'completed' ? 'Finished' : completion === 'failed' ? 'Failed' : '');
    const scheduled = scheduledFor(id);
    let clock = button.querySelector('.thread-schedule');
    const scheduledLabel = scheduled.length ? `${scheduled.length} scheduled message(s); next ${new Date(scheduled[0].runAt).toLocaleString()}` : '';
    if (!scheduled.length) clock?.remove();
    else {
      if (!clock) {
        clock = document.createElement('span'); clock.className = 'thread-schedule'; clock.setAttribute('role', 'img');
        clock.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
        button.append(clock);
      }
      if (clock.title !== scheduledLabel) { clock.title = scheduledLabel; clock.setAttribute('aria-label', scheduledLabel); }
    }
    const description = [finished.has(id) ? 'Marked finished' : '', label, pending && (waiting || working || interrupted) ? 'Unsent prompt' : '', (pending || interrupted) && unread ? 'Unread' : '', scheduledLabel].filter(Boolean).join(' · ');
    const title = button.querySelector('strong').textContent + (description ? ' · ' + description : '');
    if (button.title !== title) {
      button.title = title;
      if (description) button.setAttribute('aria-label', title); else button.removeAttribute('aria-label');
    }
    let indicator = button.querySelector('.thread-state');
    if (!label) { indicator?.remove(); continue; }
    if (!indicator) {
      indicator = document.createElement('span'); indicator.setAttribute('role', 'img');
      button.prepend(indicator);
    }
    const indicatorClass = 'thread-state ' + (waiting ? 'waiting' : working ? 'working' : interrupted ? 'failed' : pending ? 'draft' : unread ? 'unread' : completion);
    if (indicator.className !== indicatorClass) indicator.className = indicatorClass;
    if (indicator.title !== label) { indicator.title = label; indicator.setAttribute('aria-label', label); }
  }
}
function renderFinishedButton() {
  const button = $('mark-finished');
  const finished = Boolean(state.thread && preferences.finishedThreads?.[accessKey()]?.includes(state.thread.id));
  button.hidden = !state.thread;
  button.disabled = Boolean(state.finishing);
  button.textContent = finished ? '✓ Finished' : 'Mark finished';
  button.title = finished ? 'Mark unfinished' : 'Mark conversation finished';
  button.setAttribute('aria-pressed', String(finished));
}
$('mark-finished').onclick = async () => {
  if (!state.thread || state.finishing) return;
  const machine = accessKey(), threadId = state.thread.id;
  const finished = !preferences.finishedThreads?.[machine]?.includes(threadId);
  state.finishing = true; renderFinishedButton();
  try { await savePreferences({ finishedThread: { machine, threadId, finished } }); }
  catch (error) { showError(`Could not save finished conversation: ${error.message}`); }
  finally { state.finishing = false; renderThreadIndicators(); }
};
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
function saveConversationMarkers(value, change) {
  api.saveConversationState(value, change);
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
    saveConversationMarkers(conversationMarkers(next), { threadId, field: 'unread', value: unread });
    state.unread = next; renderThreadIndicators(); return true;
  } catch (error) { showError(`Could not save unread markers: ${error.message}`); return false; }
}
function setCompletion(threadId, status = null) {
  const key = queueKey(threadId);
  if ((state.completions.get(key) || null) === status) return true;
  const next = new Map(state.completions);
  if (status) next.set(key, status); else next.delete(key);
  try {
    const seenTurnIds = !status && state.thread?.id === threadId ? [...new Set([...state.items.values()].map(record => record.turnId).filter(Boolean))].slice(-1000) : [];
    saveConversationMarkers(conversationMarkers(state.unread, next), { threadId, field: 'completion', value: status, turnId: observedTurns.get(queueKey(threadId)), seenTurnIds });
    state.completions = next; return true;
  } catch (error) { showError(`Could not save conversation markers: ${error.message}`); return false; }
}
function isManuallyUnread(threadId) {
  return Boolean(threadId && state.manualUnread?.key === queueKey(threadId) && state.manualUnread.selection === state.selection && state.unread.has(queueKey(threadId)));
}
function isViewingLatest(threadId) {
  const timeline = $('timeline');
  return Boolean(threadId && state.thread?.id === threadId && !isManuallyUnread(threadId) && !state.loading && !document.hidden && document.hasFocus() && !document.querySelector('dialog[open]') && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 24);
}
function acknowledgeVisibleThread(event) {
  if (isManuallyUnread(state.thread?.id)) {
    if (state.loading || document.hidden || !document.hasFocus() || document.querySelector('dialog[open]') || ['scroll', 'close'].includes(event?.type)) return;
    state.manualUnread = null;
  }
  if (!isViewingLatest(state.thread?.id)) return;
  const key = queueKey(state.thread.id);
  const completed = state.completions.has(key);
  if (completed) setCompletion(state.thread.id);
  if (state.unread.has(key)) setUnread(state.thread.id, false);
  else if (completed) renderThreadIndicators();
}
function markUnread(thread) {
  if (!thread?.id) return;
  if (setUnread(thread.id, true) && state.thread?.id === thread.id) state.manualUnread = { key: queueKey(thread.id), selection: state.selection };
  $('thread-menu').hidden = true;
}
function unreadShortcut(event) {
  const modified = (event.metaKey || event.ctrlKey) && event.shiftKey;
  const focused = document.activeElement?.closest('#threads .thread');
  const typing = event.target?.closest?.('input,textarea,select,[contenteditable]');
  const plain = !event.metaKey && !event.ctrlKey && !typing && focused?.dataset.threadId === state.thread?.id;
  if (!(modified || plain) || event.altKey || event.isComposing || event.key?.toLowerCase() !== 'u' || document.querySelector('dialog[open]') || !state.thread) return;
  event.preventDefault(); markUnread(state.thread);
}
function conversationArrow(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || document.querySelector('dialog[open]')) return;
  const focused = event.target.closest?.('.thread');
  if (!focused || !state.connected || state.connecting || state.sending || state.commandBusy) return;
  const rows = [...$('threads').querySelectorAll('.thread')].filter(button => !button.disabled && button.checkVisibility());
  const index = rows.indexOf(focused);
  if (index < 0) return;
  event.preventDefault();
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  next.scrollIntoView({ block: 'nearest' });
  return next.onclick();
}
function setThreadRuntimeStatus(threadId, status) {
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.status = status;
}
const activeChecks = new Map();
async function reconcileActiveTurn(threadId, retry) {
  const turnId = state.active.get(threadId), options = state.options;
  if (!turnId || !state.connected || !state.owned.has(threadId) || !supports('thread/turns/list', identityProvider(threadId))) return;
  const previous = activeChecks.get(threadId);
  if (previous?.turnId === turnId && previous.options === options) { if (retry) previous.retry = retry; return previous.promise; }
  const check = { options, turnId, retry };
  activeChecks.set(threadId, check);
  const current = () => state.connected && state.options === options && activeChecks.get(threadId) === check && state.active.get(threadId) === turnId && !(state.loading && state.thread?.id === threadId);
  check.promise = (async () => {
    const history = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!current()) return;
    const latest = history.data[0];
    if (latest?.status === 'inProgress') { state.active.set(threadId, latest.id); setThreadRuntimeStatus(threadId, { type: 'active' }); updateBusy(); renderQueue(); }
    else if (latest?.id === turnId && ['completed', 'failed', 'interrupted'].includes(latest.status)) handleNotification({ method: 'turn/completed', params: { threadId, turn: latest } }, check.retry);
  })().finally(() => { if (activeChecks.get(threadId) === check) activeChecks.delete(threadId); });
  return check.promise;
}
function finishCompaction(threadId, turnId) {
  if (!turnId || compacting.get(threadId)?.turnId === turnId) compacting.delete(threadId);
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
let searchTimer, pendingThreadSearch;
const pendingPinReads = new Map();
function resetThreadListRequests(renderOffline = false) {
  state.listGeneration++;
  clearTimeout(searchTimer);
  pendingThreadSearch = null;
  pendingPinReads.clear();
  $('search-progress').hidden = true;
  if (renderOffline && ($('search').value.trim() || state.threadSearch)) renderThreads();
}
async function loadThreads(more = false, projectId = null) {
  if (!state.connected) return;
  if (!more) clearTimeout(searchTimer);
  const searchTerm = $('search').value.trim() || null;
  const query = JSON.stringify([accessKey(), searchTerm, projects.data.map(project => project.id).sort()]);
  if (!more && searchTerm && pendingThreadSearch?.query === query && pendingThreadSearch.generation === state.listGeneration) return pendingThreadSearch.promise;
  const generation = more ? state.listGeneration : ++state.listGeneration;
  const request = { query, generation, needsRefresh: false };
  const current = () => state.connected && generation === state.listGeneration && ($('search').value.trim() || null) === searchTerm;
  const usable = () => current() && !request.needsRefresh;
  request.promise = loadThreadPage({ more, projectId, query, searchTerm, current: usable }).catch(error => {
    if (!usable()) return;
    if (!more && !$('search-progress').hidden) {
      $('threads').replaceChildren();
      $('more-threads').hidden = true;
    }
    throw error;
  }).finally(() => {
    if (pendingThreadSearch === request) pendingThreadSearch = null;
    if (more || !current()) return;
    if (request.needsRefresh) return loadThreads();
    $('search-progress').hidden = true;
  });
  if (!more && searchTerm) pendingThreadSearch = request;
  return request.promise;
}
async function loadThreadPage({ more, projectId, query, searchTerm, current }) {
  const sameQuery = state.threadQuery === query;
  if (more && !sameQuery) return;
  const filters = searchTerm ? [null] : more ? [projectId] : [null, ...projects.data.map(project => project.id)];
  const results = await Promise.allSettled(filters.map(async id => {
    const compact = id && !projects.expanded.has(id);
    const fullPageSize = id ? 30 : 50;
    const limit = compact ? 5 : fullPageSize;
    const loaded = state.threadCoverage?.get(id) || 0;
    const target = !more && sameQuery && !compact ? loaded : 0;
    const data = [], errors = []; let cursor = more ? (id ? projects.cursors.get(id) : state.threadCursor) : null;
    do {
      const page = await rpc('thread/list', { limit, sortKey: 'updated_at', modelProviders: [], searchTerm, cursor, ...(!searchTerm && projects.data.length ? { projectId: id } : {}) });
      data.push(...page.data); errors.push(...page.errors || []); cursor = page.nextCursor;
    } while (cursor && data.length < target && current());
    return { data, nextCursor: cursor, errors };
  }));
  if (!current()) return;
  if (results.every(result => result.status === 'rejected')) throw results[0].reason;
  const pages = results.map((result, index) => result.status === 'fulfilled' ? result.value : {
    data: sameQuery ? state.threads.filter(thread => searchTerm || !projects.data.length || (thread.projectId || null) === filters[index]) : [],
    nextCursor: sameQuery ? (filters[index] ? projects.cursors.get(filters[index]) : state.threadCursor) : null,
    errors: [{ provider: filters[index] ? identityProvider(filters[index]) : null, message: result.reason.message }]
  });
  const errors = pages.flatMap(page => page.errors);
  const failed = new Set(errors.map(error => error.provider));
  const listed = new Set(pages.flatMap(page => page.data.map(thread => thread.id)));
  if (!more && sameQuery) for (const thread of state.threads) if (failed.has(threadProvider(thread)) && !listed.has(thread.id)) { pages[0].data.push(thread); listed.add(thread.id); }
  reportProviderErrors(errors);
  const machine = accessKey();
  for (const [index, id] of filters.entries()) {
    const ids = preferences.threadOrders[machine]?.[id];
    if (!id || !ids?.length || preferences.threadOrderCutoffs[machine]?.[id] !== undefined) continue;
    const known = new Set(ids);
    const dates = pages[index].data.filter(thread => known.has(thread.id) && Number.isSafeInteger(thread.createdAt) && thread.createdAt >= 0).map(thread => thread.createdAt);
    if (!dates.length) continue;
    const saved = await api.savePreferences({ threadOrder: { machine, projectId: id, cutoff: Math.max(...dates) } });
    if (!current()) return;
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
  state.threadSearch = searchTerm ? { term: searchTerm.toLowerCase(), ids: new Set(state.threads.map(thread => thread.id)) } : null;
  if (!more || !sameQuery) state.threadCoverage = new Map();
  filters.forEach((id, index) => state.threadCoverage.set(id, (more ? state.threadCoverage.get(id) || 0 : 0) + pages[index].data.length));
  state.threadQuery = query;
  if (!more) projects.cursors.clear();
  filters.forEach((id, index) => { if (id) projects.cursors.set(id, pages[index].nextCursor); else state.threadCursor = pages[index].nextCursor; });
  for (const thread of state.threads) if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
  const refreshPins = loadMissingPins(current);
  if (!searchTerm) await refreshPins;
  if (!current()) return;
  renderThreads();
  updateSettingsActions();
  if (searchTerm) refreshPins.then(updated => { if (updated && current()) renderThreads(); }).catch(error => { if (current()) showError(error); });
}
async function loadMissingPins(current) {
  const missing = [...state.pinnedIds].filter(id => !state.pinnedThreads.has(id));
  if (!missing.length) {
    state.failedPins.clear();
    return false;
  }
  for (const id of missing) state.failedPins.delete(id);
  const pinned = await Promise.allSettled(missing.map(readMissingPin));
  if (!current()) return;
  for (const [index, id] of missing.entries()) {
    if (!state.pinnedIds.has(id) || state.pinnedThreads.has(id)) continue;
    const result = pinned[index];
    if (result.status === 'rejected') state.failedPins.add(id);
    else if (result.value.thread.id === id) {
      state.failedPins.delete(id);
      state.pinnedThreads.set(id, result.value.thread);
    }
  }
  return true;
}
function readMissingPin(threadId) {
  const pending = pendingPinReads.get(threadId);
  if (pending) return pending;
  const request = rpc('thread/read', { threadId, includeTurns: false }).finally(() => {
    if (pendingPinReads.get(threadId) === request) pendingPinReads.delete(threadId);
  });
  pendingPinReads.set(threadId, request);
  return request;
}
function resetThread(folder) {
  closeMessageEdit({ save: true });
  rememberTimeline();
  state.historyView = null;
  setTimelineFollowing(true);
  pinnedMessages.jumping = null; state.olderHistory = null; $('older-turns').disabled = false;
  saveComposerDraft(); drafts.target = null;
  clearQueueDrag();
  imageLoads.clear(); historyImageObserver.disconnect(); $('image-preview-dialog').close();
  state.selection++;
  const project = projects.data.find(project => project.id === projects.selected);
  if (typeof folder === 'string') $('workspace').value = folder;
  else if (project?.roots[0]?.path) $('workspace').value = project.roots[0].path;
  modes.plan = false; hideSlash();
  state.images = [];
  renderImages();
  state.historyEvents = null;
  state.loading = false;
  state.historyLoadFailed = false;
  state.thread = null;
  $('send-time').value = '0';
  state.items = new Map();
  state.turnCursor = null;
  $('messages').replaceChildren();
  $('welcome').hidden = false;
  $('older-turns').hidden = true;
  $('thread-title').textContent = 'New conversation';
  $('thread-path').textContent = $('workspace').value;
  renderConversationNote();
  $('prompt').value = '';
  activateComposerDraft();
  syncComposerAgent();
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
  renderConversationNote();
  $('welcome').hidden = true;
  const keepDraftSettings = api.draft && drafts.target && ($('prompt').value || state.images.length);
  if (!keepDraftSettings) {
    if (thread.model && [...$('model').options].some(option => option.value === thread.model)) $('model').value = thread.model;
  }
  syncComposerAgent();
  if (!keepDraftSettings) updateEfforts(thread.reasoningEffort);
  activateComposerDraft();
  renderThreads();
  renderRequests();
  updateBusy();
}
const noteEditor = { target: null, saving: false };
function renderConversationNote() {
  const button = $('conversation-note');
  button.hidden = !state.thread;
  const text = preferences.conversationNotes?.[accessKey()]?.[state.thread?.id] || '';
  button.textContent = text || 'Add note'; button.dataset.empty = String(!text);
  button.title = text ? 'Edit note: ' + text : 'Add a conversation note';
}
$('conversation-note').onclick = () => {
  if (!state.thread || noteEditor.saving) return;
  const machine = accessKey(), threadId = state.thread.id;
  const expected = preferences.conversationNotes?.[machine]?.[threadId] || '';
  noteEditor.target = { machine, threadId, expected };
  $('note-text').value = expected; $('delete-note').hidden = !expected; $('note-error').hidden = true;
  $('note-dialog').showModal(); $('note-text').focus();
};
async function saveConversationNote(text) {
  const target = noteEditor.target;
  if (!target || noteEditor.saving) return;
  noteEditor.saving = true;
  for (const control of $('note-form').elements) control.disabled = true;
  try {
    await savePreferences({ conversationNote: { ...target, text } });
    renderConversationNote(); $('note-dialog').close();
  } catch (error) { $('note-error').textContent = error.message; $('note-error').hidden = false; }
  finally { noteEditor.saving = false; for (const control of $('note-form').elements) control.disabled = false; }
}
$('note-form').onsubmit = event => { event.preventDefault(); return saveConversationNote($('note-text').value); };
$('delete-note').onclick = () => saveConversationNote('');
$('cancel-note').onclick = () => $('note-dialog').close();
$('note-dialog').oncancel = event => { if (noteEditor.saving) event.preventDefault(); };
$('note-dialog').onclose = () => { noteEditor.target = null; };

function timelinePosition() {
  return { top: $('timeline').scrollTop, following: timelineView.following && timelineAtBottom(), reading: timelineView.reading };
}
function restoreTimelinePosition(position) {
  setTimelineFollowing(position.following, position.reading?.isConnected ? position.reading : null);
  if (position.following) scrollToBottom();
  else $('timeline').scrollTop = position.top;
}
function rememberTimeline() {
  const view = state.historyView;
  if (!view || view.options !== state.options || view.threadId !== state.thread?.id || state.historyLoadFailed) return;
  const rows = [...$('messages').children];
  const pending = rows.filter(row => row.dataset.itemId?.startsWith('pending-'));
  const items = pending.length ? new Map(state.items) : state.items;
  for (const row of pending) items.delete(row.dataset.itemId);
  recentTimelines.delete(view.threadId);
  recentTimelines.set(view.threadId, {
    view, items, rows: pending.length ? rows.filter(row => !row.dataset.itemId?.startsWith('pending-')) : rows, context: pinnedMessages.context,
    cursor: state.turnCursor, position: timelinePosition()
  });
  if (recentTimelines.size > cachedTimelineLimit) recentTimelines.delete(recentTimelines.keys().next().value);
}
function restoreCachedTimeline(cached) {
  state.historyView = cached.view;
  state.items = cached.items;
  state.turnCursor = cached.cursor;
  $('older-turns').hidden = !cached.cursor;
  $('messages').replaceChildren(...cached.rows);
  if (cached.context) { pinnedMessages.context = cached.context; $('messages').before(cached.context); }
}
async function readInitialTurns(threadId, view, current) {
  const params = { threadId, sortDirection: 'desc', itemsView: 'full' };
  const latest = await rpc('thread/turns/list', { ...params, limit: initialTurnLimit });
  if (!view?.turns.size || !current()) return latest;
  let history = latest;
  const seen = new Set();
  const cachedEnds = new Map();
  const overlaps = turn => {
    if (!view.turns.has(turn.id)) return false;
    if (turn.historyStartRowId == null) return true;
    if (!cachedEnds.has(turn.id)) {
      const cached = view.turns.get(turn.id);
      let end = cached?.historyEndRowId ?? cached?.items?.at(-1)?.historyRowId ?? -Infinity;
      if (view.dirtyTurns.has(turn.id)) {
        for (const record of state.items.values()) {
          if (record.container === $('messages') && record.turnId === turn.id && Number.isSafeInteger(record.item.historyRowId)) end = Math.max(end, record.item.historyRowId);
        }
      }
      cachedEnds.set(turn.id, end);
    }
    // A ZCode turn can span multiple windows of native rows.
    return turn.historyStartRowId <= cachedEnds.get(turn.id) + 1;
  };
  while (history.nextCursor && !seen.has(history.nextCursor) && seen.size < historyRefreshPageLimit && !history.data.some(overlaps)) {
    seen.add(history.nextCursor);
    const page = await rpc('thread/turns/list', { ...params, cursor: history.nextCursor, limit: olderTurnLimit });
    if (!current()) return latest;
    history = { ...history, data: [...history.data, ...page.data], nextCursor: page.nextCursor };
  }
  const overlap = history.data.findLastIndex(overlaps);
  if (overlap < 0) return { ...latest, replaceCached: true };
  if (overlap === history.data.length - 1) return history;
  const boundary = history.data[overlap], cachedStart = view.turns.get(boundary.id)?.historyStartRowId;
  if (cachedStart != null && (boundary.historyStartRowId == null || boundary.historyStartRowId < cachedStart)) return history;
  return { ...history, data: history.data.slice(0, overlap + 1), keepCursor: true };
}
function mergeHistoryTurn(older, newer) {
  const start = newer.historyStartRowId;
  if (!older || start == null || older.historyStartRowId >= start) return newer;
  return { ...older, historyEndRowId: newer.historyEndRowId, items: [...older.items.filter(item => item.historyRowId < start), ...newer.items] };
}
function newHistoryView(thread, turns = new Map()) {
  return { options: state.options, threadId: thread.id, path: thread.path, cwd: thread.cwd, turns, dirtyTurns: new Set() };
}
function applyInitialTurns(history, thread, view) {
  const freshTurns = new Map();
  for (const turn of [...history.data].reverse()) freshTurns.set(turn.id, mergeHistoryTurn(freshTurns.get(turn.id), turn));
  const fresh = [...freshTurns.values()];
  const older = view ? [...view.turns.keys()] : [];
  const overlap = older.indexOf(fresh[0]?.id);
  const boundary = fresh[0];
  let cachedBoundary = view?.turns.get(boundary?.id);
  if (boundary?.historyStartRowId != null && view?.dirtyTurns.has(boundary.id)) {
    const items = [...state.items.values()]
      .filter(record => record.container === $('messages') && record.turnId === boundary.id && record.item.historyRowId < boundary.historyStartRowId)
      .map(record => record.item).sort((a, b) => a.historyRowId - b.historyRowId);
    if (items.length) cachedBoundary = { ...(cachedBoundary || boundary), historyStartRowId: cachedBoundary?.historyStartRowId, items };
  }
  const mergedBoundary = boundary && mergeHistoryTurn(cachedBoundary, boundary);
  const keepOlder = overlap > 0 || mergedBoundary !== boundary;
  if (boundary) fresh[0] = mergedBoundary;
  let keep = Math.max(0, overlap), unchanged = 0;
  if (overlap >= 0) {
    while (unchanged < fresh.length && older[keep] === fresh[unchanged].id && !view.dirtyTurns.has(older[keep]) && JSON.stringify(view.turns.get(older[keep])) === JSON.stringify(fresh[unchanged])) {
      keep++; unchanged++;
    }
  }
  const position = state.historyView ? timelinePosition() : null;
  const messages = $('messages'), timeline = $('timeline');
  const replacing = older.length > keep || state.historyView && !view;
  const anchor = position && !position.following && replacing
    ? position.reading || [...messages.children].find(row => row.getBoundingClientRect().bottom > timeline.getBoundingClientRect().top)
    : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  if (state.historyView && overlap < 0) {
    hidePinContext(); messages.replaceChildren(); state.items.clear();
  } else if (replacing) {
    const removed = new Set(older.slice(keep));
    for (const row of [...messages.children]) if (removed.has(row.dataset.turnId)) row.remove();
    for (const [id, record] of state.items) if (record.container === messages && removed.has(record.turnId)) state.items.delete(id);
  }
  const turns = new Map(older.slice(0, keep).map(id => [id, view.turns.get(id)]));
  for (const turn of fresh.slice(unchanged)) {
    turns.set(turn.id, turn);
    for (const item of turn.items || []) renderItem(item, false, turn.id, messages, true);
  }
  state.historyView = newHistoryView(thread, turns);
  for (const id of older.slice(0, Math.max(0, overlap))) if (view.dirtyTurns.has(id)) state.historyView.dirtyTurns.add(id);
  if (!keepOlder && !history.keepCursor) state.turnCursor = history.nextCursor;
  $('older-turns').hidden = !state.turnCursor;
  if (position) {
    const anchorId = anchor?.dataset.itemId;
    const replacement = anchor?.isConnected ? anchor : anchorId ? state.items.get(anchorId)?.element : [...messages.children].find(row => row.dataset.turnId === anchor?.dataset.turnId);
    restoreTimelinePosition(position);
    if (replacement && anchorTop !== undefined) timeline.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
  } else scrollToBottom(true);
  observeHistoryImages();
}

async function openThread(thread, allowBusy = false, refreshHistory = false) {
  if (!state.connected || state.sending || state.commandBusy && !allowBusy) return;
  if (thread.needsFolder) {
    const project = projects.data.find(project => project.id === thread.projectId);
    if (project) return chooseSharedProjectFolder(project);
  }
  closeMessageEdit({ save: true });
  const switching = state.thread?.id !== thread.id;
  if (switching) rememberTimeline();
  const stored = recentTimelines.get(thread.id);
  const cached = switching && !refreshHistory && stored?.view.options === state.options ? stored : null;
  recentTimelines.delete(thread.id);
  setTimelineFollowing(true);
  pinnedMessages.jumping = null; state.olderHistory = null; $('older-turns').disabled = false;
  state.turnCursor = null; $('older-turns').hidden = true;
  if (state.thread?.id !== thread.id) { saveComposerDraft(); drafts.target = null; }
  const selection = ++state.selection;
  imageLoads.clear(); historyImageObserver.disconnect(); $('image-preview-dialog').close();
  $('error').hidden = true;
  if (state.thread?.id !== thread.id) { state.images = []; renderImages(); }
  state.loading = true;
  state.historyLoadFailed = false;
  state.historyView = null;
  state.items = new Map();
  state.historyEvents = [];
  if (cached) restoreCachedTimeline(cached);
  else $('messages').replaceChildren();
  try {
    setThread(thread);
    if (cached) { restoreTimelinePosition(cached.position); observeHistoryImages(); }
    const shared = !isLocal() && state.options?.sharedServer && threadProvider(thread) === 'codex';
    let result;
    try {
      result = await rpc(shared ? 'thread/resume' : 'thread/read', { threadId: thread.id, ...(shared ? { excludeTurns: true } : { includeTurns: false, ...(refreshHistory ? { refreshSyncedHistory: true } : {}) }) });
      if (shared && selection === state.selection) { state.owned.add(thread.id); state.writerConflicts.delete(queueKey(thread.id)); }
    } catch (error) {
      if (!shared || !isWriterConflict(error)) throw error;
      if (selection !== state.selection) return;
      state.owned.delete(thread.id);
      state.writerConflicts.add(queueKey(thread.id));
      result = await rpc('thread/read', { threadId: thread.id, includeTurns: false });
    }
    if (selection !== state.selection) return;
    setThread(result.thread);
    const view = cached && (cached.view.path == null || cached.view.path === result.thread.path) && cached.view.cwd === result.thread.cwd ? cached.view : null;
    const history = await readInitialTurns(thread.id, view, () => selection === state.selection);
    if (selection !== state.selection) return;
    if (history.data[0]?.id) observedTurns.set(queueKey(thread.id), history.data[0].id);
    state.active.delete(thread.id);
    compacting.delete(thread.id);
    for (const turn of [...history.data].reverse()) {
      if (turn.status === 'inProgress') {
        state.active.set(thread.id, turn.id);
        const last = turn.items?.at(-1);
        if (last?.type === 'contextCompaction' && Number.isFinite(last.startedAtMs) && last.completedAtMs == null) compacting.set(thread.id, { itemId: last.id, turnId: turn.id });
      }
    }
    applyInitialTurns(history, result.thread, history.replaceCached ? null : view);
    const buffered = state.historyEvents;
    state.historyEvents = null;
    for (const event of buffered) {
      if (event.receivedSequence > history.receivedSequence) handleNotification(event);
    }
    if (timelineView.following) {
      scrollToBottom();
      if (!isManuallyUnread(thread.id)) setUnread(thread.id, false);
      setCompletion(thread.id); renderThreadIndicators();
    }
  } catch (error) {
    if (selection !== state.selection) return;
    state.historyLoadFailed = true;
    state.turnCursor = null; $('older-turns').hidden = true;
    throw error;
  } finally {
    if (selection === state.selection) { state.loading = false; state.historyEvents = null; updateBusy(); flushQueue(thread.id).catch(showError); }
  }
}
function imagePath(source, workspace = state.thread?.cwd || $('workspace').value || '/') {
  if (source.startsWith('sandbox:')) source = source.slice(8);
  if (/^[a-z]:[\\/]/i.test(source)) source = 'file:///' + source.replace(/\\/g, '/');
  const cwd = workspace.replace(/\\/g, '/');
  const base = 'file://' + (cwd.startsWith('/') ? '' : '/') + encodeURI(cwd).replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/\/$/, '') + '/';
  const url = new URL(source, base);
  if (url.protocol !== 'file:' || url.hostname) throw new Error('Only images on the connected machine are supported.');
  return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
}
const pendingHistoryImages = new WeakMap();
const historyImageObserver = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting || !target.isConnected) continue;
    historyImageObserver.unobserve(target);
    const load = pendingHistoryImages.get(target);
    pendingHistoryImages.delete(target);
    target.removeAttribute('data-deferred-image');
    if (load) target.imageReady = load();
  }
}, { root: $('timeline'), rootMargin: '160px 0px' });
function observeHistoryImages() {
  historyImageObserver.disconnect();
  for (const figure of $('timeline').querySelectorAll('[data-deferred-image]')) historyImageObserver.observe(figure);
}
function messageImage(source, alt = 'Image', defer = false) {
  const figure = document.createElement('figure'); figure.className = 'message-figure';
  const image = document.createElement('img'); image.className = 'message-image'; image.alt = alt;
  const caption = document.createElement('figcaption'); caption.textContent = 'Loading image…';
  figure.append(caption);
  const options = state.options;
  const cwd = state.thread?.cwd || $('workspace').value || '/', provider = selectedProvider();
  const load = async () => {
    if (typeof source !== 'string' || !source) throw new Error('Image source is missing.');
    let url = source;
    if (!source.startsWith('data:')) {
      const file = imagePath(source, cwd);
      if (!imageLoads.has(file)) {
        if (imageLoads.size >= 20) imageLoads.delete(imageLoads.keys().next().value);
        const request = api.readImage(file, { provider }).catch(error => { if (imageLoads.get(file) === request) imageLoads.delete(file); throw error; });
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
    if (atBottom && figure.isConnected) scrollToBottom();
  };
  const start = () => load().catch(error => { if (options === state.options) { caption.textContent = `Could not load image: ${error.message}`; figure.replaceChildren(caption); } });
  if (defer) { figure.dataset.deferredImage = ''; pendingHistoryImages.set(figure, start); historyImageObserver.observe(figure); }
  else figure.imageReady = start();
  return figure;
}
$('close-image-preview').onclick = () => $('image-preview-dialog').close();
$('image-preview-dialog').onclose = () => $('image-preview').removeAttribute('src');
function markdown(element, text, deferImages = false) {
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
  for (const pre of element.querySelectorAll('pre')) {
    const block = document.createElement('div'); block.className = 'code-block';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-code'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy code');
    copy.onclick = async () => {
      copy.disabled = true;
      try { await api.copyText((pre.querySelector('code') || pre).textContent); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Try again'; }
      finally { copy.disabled = false; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    };
    pre.replaceWith(block); block.append(copy, pre);
  }
  for (const link of element.querySelectorAll('a[href]')) linkContexts.set(link, { machine: accessKey(), threadId: state.thread?.id, provider: threadProvider(state.thread), cwd: state.thread?.cwd || $('workspace').value });
  for (const placeholder of element.querySelectorAll('[data-codex-image]')) {
    const token = images[Number(placeholder.dataset.codexImage)];
    if (token) placeholder.replaceWith(messageImage(token.href, token.text || 'Image', deferImages)); else placeholder.remove();
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
  let oldLine = 0, newLine = 0;
  const rows = patch.split('\n').map(line => {
    if (line.startsWith('diff --git ')) inHunk = false;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (line.startsWith('@@')) {
      inHunk = Boolean(header);
      if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); }
    }
    const kind = line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') && (inHunk || !line.startsWith('+++')) ? 'diff-added' : line.startsWith('-') && (inHunk || !line.startsWith('---')) ? 'diff-removed' : '';
    let oldNumber = '', newNumber = '';
    if (inHunk && !header) {
      if (line.startsWith(' ')) { oldNumber = oldLine++; newNumber = newLine++; }
      else if (kind === 'diff-removed') oldNumber = oldLine++;
      else if (kind === 'diff-added') newNumber = newLine++;
    }
    return { line, kind, oldNumber, newNumber, metadata: !inHunk && !kind, ranges: [] };
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
  pre.classList.toggle('has-hunks', rows.some(row => row.kind === 'diff-hunk'));
  for (const { line, kind, ranges, oldNumber, newNumber, metadata } of rows) {
    const span = document.createElement('span'); span.className = 'diff-line' + (kind ? ' ' + kind : '') + (metadata ? ' diff-metadata' : '');
    span.dataset.oldLine = String(oldNumber); span.dataset.newLine = String(newNumber);
    if (kind === 'diff-hunk') { span.title = line; span.setAttribute('aria-label', line); }
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
function firstChangedLine(patches) {
  let first = Infinity;
  for (const patch of patches) {
    let line = null, end = null;
    for (const row of patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (hunk) {
        line = Number(hunk[1]); end = line + Math.max(0, Number(hunk[2] ?? 1) - 1);
        if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end)) line = null;
      } else if (row.startsWith('diff --git ') || row.startsWith('@@')) line = null;
      else if (line !== null) {
        if (row.startsWith('+') || row.startsWith('-')) first = Math.min(first, Math.max(1, Math.min(line, end)));
        if (row.startsWith(' ') || row.startsWith('+')) line++;
      }
    }
  }
  return Number.isFinite(first) ? first : 1;
}
function updateFileDiff(entry) {
  const file = entry.file;
  let body = entry.querySelector('.changed-file-content');
  if (!body) {
    body = document.createElement('div'); body.className = 'changed-file-content';
    const diff = document.createElement('div'); diff.className = 'changed-file-diff'; diff.tabIndex = 0;
    body.append(diff); entry.append(body);
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
  diff.scrollTop = top; diff.scrollLeft = left;
}
function isTestFile(filePath) {
  return /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|(?:^|\/)test_[^/]+$|[._-](?:test|spec)\.[^/]+$/i.test(filePath.replace(/\\/g, '/'));
}
function localFilePath(file) { return mapProjectPath(file, conversationSync.pathsMachine === accessKey() ? conversationSync.paths?.[state.thread?.projectId] : null); }
function renderFileSummary(turnId) {
  if (!turnId) return;
  let card = [...$('messages').querySelectorAll('.changed-files')].find(element => element.dataset.turnId === turnId);
  const files = new Map();
  const records = [...state.items.values()].filter(record => record.turnId === turnId && record.item.type === 'fileChange' && record.item.status === 'completed')
    .sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  for (const record of records) {
    for (const [index, change] of (record.item.changes || []).entries()) {
      if (typeof change.path !== 'string') continue;
      const source = localFilePath(change.path), path = localFilePath(change.kind?.move_path || change.path);
      const file = files.get(source) || files.get(path) || { id: JSON.stringify([record.item.id, index]), added: 0, removed: 0, diffs: [], kind: change.kind?.type };
      if (change.kind?.move_path) files.delete(source);
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
  const nonTestFiles = [...files.values()].filter(file => !isTestFile(file.path));
  if (nonTestFiles.length !== files.size) {
    const summary = document.createElement('span'); summary.className = 'change-non-test-summary';
    summary.append(document.createTextNode(`Excluding tests: ${nonTestFiles.length} file${nonTestFiles.length === 1 ? '' : 's'}`), counts(nonTestFiles.reduce((sum, file) => sum + file.added, 0), nonTestFiles.reduce((sum, file) => sum + file.removed, 0)));
    card.firstElementChild.append(summary);
  }
  const rows = card.lastElementChild;
  const entries = new Map([...rows.children].map(entry => [entry.dataset.fileId, entry]));
  let next = rows.firstElementChild;
  const context = { machine: accessKey(), threadId: state.thread?.id, cwd: state.thread?.cwd || $('workspace').value, provider: threadProvider(state.thread), clampLine: true };
  const shouldExpand = entry => preferences.skipTestDiffs === false || !isTestFile(entry.dataset.path);
  const updateToggleTitle = () => { card.firstElementChild.title = [...rows.children].some(entry => shouldExpand(entry) && !entry.open) || !card.querySelector('.changed-file-entry[open]') ? 'Expand all file diffs' : 'Collapse all file diffs'; };
  card.firstElementChild.onclick = event => {
    event.preventDefault();
    const entries = [...rows.children];
    const expand = !card.open || entries.some(entry => shouldExpand(entry) && !entry.open);
    card.open = true; card.expandAll = expand;
    for (const entry of entries) {
      if (!expand || shouldExpand(entry)) entry.open = expand;
      if (entry.open) updateFileDiff(entry);
    }
    setTimelineFollowing(false, expand ? card : null);
    updateToggleTitle();
  };
  for (const file of files.values()) {
    let entry = entries.get(file.id);
    entries.delete(file.id);
    if (!entry) {
      entry = document.createElement('details'); entry.className = 'changed-file-entry'; entry.dataset.fileId = file.id;
      const summary = document.createElement('summary'); summary.className = 'changed-file'; entry.append(summary);
      const name = document.createElement('span'); name.className = 'changed-file-name';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'icon-button open-changed-file';
      open.title = 'Open in editor at first change'; open.setAttribute('aria-label', 'Open in editor');
      open.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/></svg>';
      open.onclick = async event => {
        event?.preventDefault(); event?.stopPropagation();
        const href = entry.file.path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/') + '#L' + firstChangedLine(entry.file.diffs);
        try { await api.openLink(href, context); } catch (error) { showError(error); }
      };
      summary.append(name, open, document.createElement('small'));
      summary.onclick = () => { card.expandAll = false; };
      entry.open = Boolean(card.expandAll) && (preferences.skipTestDiffs === false || !isTestFile(file.path));
      entry.ontoggle = () => {
        if (!entry.isConnected) return;
        if (entry.open) { setTimelineFollowing(false, card.expandAll ? card : entry); updateFileDiff(entry); }
        else if (timelineView.reading === entry) timelineView.reading = null;
        updateToggleTitle();
      };
    }
    entry.file = file; entry.dataset.path = file.path;
    const fileSummary = entry.firstElementChild; fileSummary.title = file.path;
    const name = fileSummary.querySelector('.changed-file-name');
    const prefix = (context.cwd || '').replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const path = file.path.replace(/\\/g, '/'); name.textContent = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const kind = fileSummary.querySelector('small'); kind.textContent = file.kind === 'add' ? 'Added' : file.kind === 'delete' ? 'Deleted' : file.kind === 'rename' ? 'Renamed' : 'Modified';
    fileSummary.querySelector('.open-changed-file').disabled = file.kind === 'delete';
    const previousCounts = fileSummary.querySelector('.change-counts');
    if (previousCounts) previousCounts.replaceWith(counts(file.added, file.removed)); else fileSummary.append(counts(file.added, file.removed));
    if (entry !== next) {
      if (entry.parentNode === rows) moveDiffElement(rows, entry, next); else rows.insertBefore(entry, next);
    }
    next = entry.nextElementSibling;
    if (entry.open) updateFileDiff(entry);
  }
  for (const entry of entries.values()) entry.remove();
  updateToggleTitle();
}
function renderToolBody(record, deferImages) {
  const { item, body } = record;
  if (item.type === 'commandExecution') {
    body.textContent = (item.command || 'Command') + '\n\n' + (item.aggregatedOutput || (isLocal() ? 'Running locally…' : 'Running on the server…'));
  } else if (item.type === 'fileChange') {
    body.textContent = item.changes?.map(change => `${change.path}\n${change.diff || ''}`).join('\n\n') || '';
  } else if (item.type === 'reasoning') {
    body.textContent = (item.summary || []).join('\n');
  } else if (item.type === 'contextCompaction') {
    body.textContent = 'Condenses earlier messages so the conversation can continue.';
  } else {
    const output = item.result || item.output || item.contentItems || item.arguments || item;
    const content = Array.isArray(output) ? output : output.content || [];
    const images = Array.isArray(content) ? content.filter(part => ['image', 'input_image', 'inputImage'].includes(part.type)) : [];
    body.textContent = JSON.stringify(output, (key, value) => value && ['image', 'input_image', 'inputImage'].includes(value.type) ? { type: value.type, image: '[Image data]' } : value, 2);
    for (const part of images) body.append(messageImage(part.image_url || part.imageUrl || part.url || (part.data ? `data:${part.mimeType};base64,${part.data}` : null), 'Tool image', deferImages));
    if (!deferImages && images.length && !record.hasImages) {
      record.element.open = true;
      record.group.open = true;
      record.hasImages = true;
    }
  }
}
function renderItem(item, prepend = false, turnId = null, container = $('messages'), fromHistory = false) {
  if (!item?.id) return;
  const anchor = timelineView.reading;
  const anchorTop = anchor?.isConnected && anchor.checkVisibility() ? anchor.getBoundingClientRect().top : null;
  let record = state.items.get(item.id);
  const isMessage = ['userMessage', 'agentMessage', 'plan', 'exitedReviewMode', 'imageView', 'imageGeneration'].includes(item.type);
  if (!isMessage && !['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'reasoning', 'webSearch', 'collabAgentToolCall', 'functionCallOutput', 'contextCompaction'].includes(item.type)) return;
  if (!record) {
    const element = document.createElement(isMessage ? 'article' : 'details');
    element.dataset.itemId = item.id;
    element.className = isMessage ? `message ${item.type}` : 'tool';
    const label = document.createElement(isMessage ? 'div' : 'summary');
    label.className = 'message-label';
    const body = document.createElement(isMessage ? 'div' : 'pre');
    body.className = 'message-body';
    element.append(label, body);
    record = { element, label, body, item };
    state.items.set(item.id, record);
  }
  if (record.container !== container) {
    const { element } = record;
    const previousGroup = record.group;
    if (isMessage) {
      if (prepend) container.prepend(element); else container.append(element);
    } else {
      let neighbor = container[prepend ? 'firstElementChild' : 'lastElementChild'];
      if (neighbor?.classList.contains('changed-files')) neighbor = neighbor[prepend ? 'nextElementSibling' : 'previousElementSibling'];
      let group = neighbor?.classList.contains('activity-log') && neighbor.dataset.turnId === (turnId || '') ? neighbor : null;
      if (!group) {
        group = document.createElement('details'); group.className = 'activity-log'; group.dataset.turnId = turnId || '';
        const summary = document.createElement('summary'); summary.title = 'Show or hide full activity log';
        const entries = document.createElement('div'); entries.className = 'activity-items';
        group.append(summary, entries);
        if (prepend) container.prepend(group); else container.append(group);
      }
      group.lastElementChild[prepend ? 'prepend' : 'append'](element);
      record.group = group;
    }
    if (previousGroup && !previousGroup.lastElementChild.children.length) previousGroup.remove();
    record.container = container;
    if (record.pinContext && container === $('messages')) {
      if (pinnedMessages.context === record.pinContext) hidePinContext();
      delete record.pinContext;
    }
  }
  record.item = { ...record.item, ...item };
  if (turnId) { record.turnId = turnId; record.element.dataset.turnId = turnId; }
  item = record.item;
  if (item.type === 'userMessage') {
    if (record.label.dataset.type !== item.type) { record.label.textContent = 'You'; record.label.dataset.type = item.type; }
    if (record.turnId && !record.label.querySelector('.edit-message')) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit-message'; edit.textContent = 'Edit & resend';
      edit.dataset.turnId = record.turnId;
      edit.onclick = () => openMessageEdit(record);
      record.label.append(edit);
    }
    const edit = record.label.querySelector('.edit-message');
    if (edit) edit.dataset.canEdit = String(item.canEdit === true);
    record.body.replaceChildren();
    for (const part of item.content || []) {
      if (part.type === 'text') record.body.append(document.createTextNode(part.text));
      else if (part.type === 'image' || part.type === 'localImage') record.body.append(messageImage(part.url || part.path, 'Attached image', fromHistory));
    }
  } else if (isMessage) {
    if (record.label.dataset.type !== item.type) {
      record.label.replaceChildren(); record.label.dataset.type = item.type;
      const mark = document.createElement('span');
      mark.className = 'mini-mark'; mark.textContent = '›_';
      record.label.append(mark, document.createTextNode(item.type === 'plan' ? 'Plan' : agentName()));
    }
    if (item.type === 'imageView' || item.type === 'imageGeneration') {
      record.body.replaceChildren();
      const source = item.path || item.savedPath || (item.result ? `data:image/png;base64,${item.result}` : null);
      if (source) record.body.append(messageImage(source, item.type === 'imageView' ? 'Image preview' : 'Generated image', fromHistory));
      else record.body.textContent = item.failure?.message || (item.status === 'inProgress' ? 'Generating image…' : 'Image is unavailable.');
    } else markdown(record.body, item.type === 'exitedReviewMode' ? item.review : item.text, fromHistory);
  } else if (item.type === 'commandExecution') {
    const command = item.command || 'Command';
    record.label.textContent = `${item.status === 'inProgress' ? '◌' : item.exitCode ? '×' : '✓'} ${command.split(/\r?\n/)[0]}`;
    record.label.title = 'Expand command and output';
  } else if (item.type === 'fileChange') {
    record.label.textContent = `Files · ${item.status || 'Updating'}`;
  } else if (item.type === 'reasoning') {
    record.label.textContent = 'Thinking';
  } else if (item.type === 'contextCompaction') {
    record.label.textContent = 'Context compaction';
  } else {
    record.label.textContent = item.type === 'functionCallOutput' ? `${item.namespace || ''} ${item.name || 'Tool result'}` : `${item.server || ''} ${item.tool || item.type} · ${item.status || ''}`;
  }
  if (!isMessage) {
    if (fromHistory && !record.element.open) {
      record.element.ontoggle = () => {
        if (!record.element.open) return;
        record.element.ontoggle = null;
        renderToolBody(record, true);
      };
    } else {
      record.element.ontoggle = null;
      renderToolBody(record, fromHistory);
    }
  }
  if (isMessage) {
    record.startedAtMs = item.startedAtMs ?? record.startedAtMs;
    record.completedAtMs = item.completedAtMs ?? record.completedAtMs;
    const timestamp = record.startedAtMs ?? record.completedAtMs;
    const date = typeof timestamp === 'number' && timestamp > 0 ? new Date(timestamp) : null;
    if (!record.time) { record.time = document.createElement('time'); record.time.className = 'message-time'; }
    if (date && Number.isFinite(date.getTime())) {
      record.time.dateTime = date.toISOString(); record.time.textContent = messageDateFormat.format(date);
    } else { record.time.removeAttribute('datetime'); record.time.textContent = 'Time unavailable'; }
    record.element.removeAttribute('title');
    if (record.time.parentNode !== record.label) record.label.insertBefore(record.time, record.label.querySelector('.edit-message,.message-pin'));
  }
  if (isMessage && record.turnId) {
    if (!record.pinButton) {
      record.pinButton = document.createElement('button'); record.pinButton.type = 'button'; record.pinButton.className = 'message-pin'; record.pinButton.innerHTML = pinIcon;
      record.pinButton.onclick = () => {
        if (state.items.get(record.item.id) !== record) return;
        const content = record.body.cloneNode(true); content.querySelectorAll('.copy-code').forEach(button => button.remove());
        const preview = `${record.item.type === 'userMessage' ? 'You' : agentName()}: ${content.textContent.trim().replace(/\s+/g, ' ') || 'Image'}`.slice(0, 200);
        return saveMessagePin({ itemId: record.item.id, turnId: record.turnId, preview }, !currentMessagePins().some(pin => pin.itemId === record.item.id)).catch(showError);
      };
    }
    if (record.pinButton.parentNode !== record.label) record.label.append(record.pinButton);
    updateMessagePinButton(record);
  }
  if (record.group) record.group.firstElementChild.textContent = record.group.lastElementChild.lastElementChild.firstElementChild.textContent;
  if (item.type === 'fileChange') renderFileSummary(record.turnId);
  const card = [...$('messages').querySelectorAll('.changed-files')].find(element => element.dataset.turnId === record.turnId);
  const last = [...$('messages').children].findLast(element => element !== card && element.dataset.turnId === record.turnId);
  const expanded = card?.open && card.querySelector('.changed-file-entry[open]');
  if (card && last && last.nextElementSibling !== card && !expanded) moveDiffElement($('messages'), card, last.nextElementSibling);
  if (anchorTop !== null && anchor.isConnected && anchor.checkVisibility()) $('timeline').scrollTop += anchor.getBoundingClientRect().top - anchorTop;
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
  if (!state.connected || !supports('skills/list')) return;
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
  const provider = threadProvider(message.thread);
  const catalog = modes.catalog.filter(entry => (entry.provider || 'codex') === provider);
  const preset = catalog.find(entry => entry.mode === message.mode);
  if (!preset && message.mode === 'plan') throw new Error(`Plan mode is unavailable for ${agentName(provider)}.`);
  if (!catalog.length) return {};
  const chosen = message.model || message.thread.model;
  const model = chosen && !chosen.endsWith(':model:') ? chosen : state.models.find(model => (model.provider || 'codex') === provider && model.isDefault)?.model;
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
      if (!state.connected) throw new Error(`Connect to ${agentName()} first.`);
      if (!modes.catalog.length) modes.catalog = (await rpc('collaborationMode/list')).data;
      if (!modes.catalog.some(entry => (!entry.provider || entry.provider === selectedProvider()) && entry.mode === 'plan')) throw new Error('Plan mode is unavailable on this machine.');
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
  if (state.dispatching.has(queue.key) || queue.saving || queue.editing || queueLocked(queue)) return;
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
  const expected = editorDrafts.get(editorDraftKey(target.draftTarget))?.expected;
  const previous = { text: target.message.text, input: target.message.input };
  target.message.text = text;
  target.message.input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...target.message.input.filter(part => part.type !== 'text' && part.type !== 'skill'), ...skillInputs(text, target.message.input.filter(part => part.type === 'skill'), target.queue.thread.cwd)];
  try { await persistQueue(target.queue); clearDraft(target.draftTarget, expected); target.queue.editing = false; $('edit-queue-dialog').close(); renderQueue(); if (target.queue.machine === accessKey()) await flushQueue(target.queue.thread.id); }
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
function renderConversationSyncNotice() {
  const notice = $('conversation-sync-notice');
  const sync = conversationSync.status;
  renderHeaderSync();
  if (!sync || conversationSync.statusOptions !== state.options) { notice.hidden = true; return; }
  const historyError = sync.historyErrors?.find(failure => failure.id === state.thread?.id);
  const queueError = sync.queueErrors?.find(syncBelongsHere);
  const message = sync.error ? 'Sync paused: ' + sync.error : historyError ? 'Local history kept · upload paused: ' + historyError.message : queueError ? 'Sync needs attention: ' + queueError.message : conversationAccess()?.syncPending ? 'History upload pending' : null;
  const conflict = sync.conflicts.find(syncBelongsHere);
  notice.hidden = !message && !conflict;
  const signature = JSON.stringify([message, conflict, queueError?.key, state.thread?.id]);
  if (notice.dataset.signature !== signature) {
    notice.dataset.signature = signature; notice.replaceChildren();
    if (message) { const error = document.createElement('span'); error.textContent = message; notice.append(error); }
    const retryHistory = historyError || queueError?.kind === 'history';
    if (state.thread && (retryHistory ? api.retryHistorySync : queueError && api.retryConversationSync)) {
      const button = document.createElement('button'), thread = state.thread, options = state.options;
      button.type = 'button'; button.className = 'subtle'; button.textContent = 'Retry sync';
      button.onclick = async () => {
        if (state.options !== options || state.thread?.id !== thread.id) return;
        button.disabled = true;
        try { await (retryHistory ? api.retryHistorySync(thread.id) : api.retryConversationSync(queueError.key)); await refreshConversationSync(); }
        catch (error) { showError(error); }
        finally { button.disabled = false; }
      };
      notice.append(button);
    }
    if (conflict) {
      const details = document.createElement('details'), summary = document.createElement('summary'), preview = document.createElement('pre');
      summary.textContent = conflict.kind === 'history' ? 'Conversation history changed on both computers' : conflict.kind === 'shortcuts' ? 'Shortcuts changed on both computers' : conflict.kind === 'note' ? 'Note changed on both computers' : 'Draft changed on both computers';
      preview.textContent = `This computer:\n${conflict.local || '(empty)'}\n\nOther computer:\n${conflict.remote || '(empty)'}`;
      details.append(summary, preview); notice.append(details);
      for (const [label, choice] of [['Keep this version', 'local'], ['Use other version', 'remote']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle'; button.textContent = label;
        button.onclick = async () => {
          button.disabled = true;
          try {
            const options = state.options, thread = state.thread;
            const result = await api.resolveSyncConflict(conflict.key, choice, conflict.version);
            if (thread && result?.reloadedThread === thread.id && options === state.options && state.thread?.id === thread.id) await openThread(thread, true);
            await refreshConversationSync();
          }
          catch (error) { showError(error); await refreshConversationSync(); }
          finally { button.disabled = false; }
        };
        notice.append(button);
      }
    }
  }
  positionSyncPanel();
}
async function refreshConversationSync() {
  if (!api.conversationSync || !state.options) return;
  if (conversationSync.refreshing) { conversationSync.again = true; return; }
  conversationSync.refreshing = true;
  try {
    do {
      conversationSync.again = false;
      const options = state.options, snapshot = drafts.snapshot, target = drafts.target, editors = new Map(editorDrafts);
      const markerMachine = accessKey(), markers = preferences.conversationStates[markerMachine], shortcuts = preferences.shortcuts;
      const [saved, pins, sync] = await Promise.all([api.preferences(), api.pins(), api.conversationSync()]);
      if (options !== state.options) continue;
      const draftsChanged = sync.draftRevision == null || (conversationSync.status?.draftRevision ?? 0) !== sync.draftRevision;
      const wasReadOnly = conversationReadOnly();
      conversationSync.status = sync; conversationSync.statusOptions = options;
      const pathsChanged = JSON.stringify(conversationSync.paths) !== JSON.stringify(sync.paths || {});
      conversationSync.paths = sync.paths || {}; conversationSync.pathsMachine = accessKey();
      if (pathsChanged) for (const turnId of new Set([...state.items.values()].filter(record => record.item.type === 'fileChange').map(record => record.turnId))) renderFileSummary(turnId);
      const previousAccess = state.thread && conversationSync.ownership.get(state.thread.id);
      conversationSync.historyEnabled = Boolean(sync.historyEnabled);
      conversationSync.ownership = new Map((sync.ownership || []).map(access => [access.id, access]));
      const access = conversationAccess();
      if (previousAccess?.waiting && access?.owned && !access.requested && !state.loading && !state.sending && !state.active.has(state.thread?.id)) await openThread(state.thread, true, true);
      if (options !== state.options) continue;
      updateSendButton();
      if (wasReadOnly !== conversationReadOnly()) updateMessageEdits();
      refreshEditorDrafts(editors);
      const latestMarkers = preferences.conversationStates[markerMachine];
      preferences.conversationStates = saved.conversationStates || {};
      if (latestMarkers !== markers) {
        preferences.conversationStates = { ...preferences.conversationStates, [markerMachine]: latestMarkers };
        conversationSync.again = true;
      }
      const changedRows = new Set();
      const collectChanges = (before = [], after = []) => {
        const previous = new Set(before), current = new Set(after);
        for (const id of previous) if (!current.has(id)) changedRows.add(id);
        for (const id of current) if (!previous.has(id)) changedRows.add(id);
      };
      const nextMarkers = preferences.conversationStates[markerMachine];
      if (JSON.stringify(latestMarkers) !== JSON.stringify(nextMarkers) || !nextMarkers) {
        collectChanges(latestMarkers?.unread, nextMarkers?.unread);
        const previous = latestMarkers?.completions || {}, current = nextMarkers?.completions || {};
        for (const id of new Set([...Object.keys(previous), ...Object.keys(current)])) if (previous[id] !== current[id]) changedRows.add(id);
        restoreUnread();
      }
      const oldPins = currentMessagePins();
      preferences.messagePins = saved.messagePins || {};
      if (JSON.stringify(oldPins) !== JSON.stringify(currentMessagePins())) renderMessagePins();
      collectChanges(preferences.finishedThreads?.[markerMachine], saved.finishedThreads?.[markerMachine]);
      preferences.finishedThreads = saved.finishedThreads || {};
      const selectedId = state.thread?.id;
      const previousNote = preferences.conversationNotes?.[markerMachine]?.[selectedId];
      preferences.conversationNotes = saved.conversationNotes || {};
      if (previousNote !== preferences.conversationNotes[markerMachine]?.[selectedId]) renderConversationNote();
      if (preferences.shortcuts !== shortcuts) conversationSync.again = true;
      else {
        if (JSON.stringify(shortcuts) !== JSON.stringify(saved.shortcuts)) {
          preferences.shortcuts = saved.shortcuts; renderShortcuts();
        }
        renderShortcutSaveStatus(saved.shortcutMoveQueued);
      }
      const pinsChanged = pins.length !== state.pinnedIds.size || pins.some(id => !state.pinnedIds.has(id));
      if (pinsChanged) {
        state.pinnedIds = new Set(pins);
        for (const id of state.pinnedThreads.keys()) if (!state.pinnedIds.has(id)) state.pinnedThreads.delete(id);
        for (const thread of state.threads) if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
        renderThreads();
      } else if (changedRows.size) renderThreadIndicators(changedRows);
      if (draftsChanged) refreshDraftIndicators(true);
      renderConversationSyncNotice();
      if ((sync.draftRevision == null || drafts.syncedRevision !== sync.draftRevision) && !state.loading && !state.sending && !drafts.suspended && !drafts.dirty && target && target === drafts.target && snapshot === drafts.snapshot) {
        const value = api.draft(target);
        drafts.syncedRevision = sync.draftRevision;
        if ((value?.text || '') !== $('prompt').value || JSON.stringify(value?.images || []) !== JSON.stringify(state.images)) {
          drafts.target = null; activateComposerDraft(); updateBusy();
        }
      }
      if (state.connected && !state.connecting && sync.catalog !== conversationSync.catalog) {
        conversationSync.catalog = sync.catalog; await refreshProjects();
      } else if (state.connected && !state.connecting && pinsChanged) await loadThreads();
    } while (conversationSync.again);
  } finally { conversationSync.refreshing = false; }
}
async function refreshSchedules() {
  if (!api.scheduledTasks) return;
  const generation = ++schedules.generation;
  const tasks = await api.scheduledTasks();
  if (generation !== schedules.generation) return;
  if (JSON.stringify(tasks) === JSON.stringify(schedules.tasks)) return;
  schedules.tasks = tasks; renderSchedules(); renderThreadIndicators();
}
function scheduledFor(threadId) {
  return schedules.tasks.filter(task => (task.machine || 'access:local') === accessKey() && task.threadId === threadId && (['pending', 'claimed', 'sending', 'unconfirmed'].includes(task.status) || task.needsReview)).sort((a, b) => a.runAt.localeCompare(b.runAt));
}
async function openScheduledEdit(task) {
  if (task.status !== 'pending' || schedules.editing || !state.connected || task.threadId !== state.thread?.id) return;
  const target = { task, options: state.options, selection: state.selection };
  let opened = false;
  schedules.editing = target;
  try {
    target.lock = await api.editLock(task.threadId);
    const saved = await api.scheduledTask(task.id, target.lock);
    if (schedules.editing !== target || state.options !== target.options || state.selection !== target.selection) return;
    target.task = saved;
    target.draftTarget = editorTarget('edit-schedule', state.thread, task.id);
    const draft = api.draft?.(target.draftTarget);
    const date = new Date(saved.runAt);
    const pad = value => String(value).padStart(2, '0');
    target.time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    $('scheduled-text').value = editorText(target.draftTarget, saved.message?.text ?? saved.prompt);
    $('scheduled-time').value = draft?.runAt ?? target.time;
    for (const id of ['scheduled-text', 'scheduled-time', 'save-schedule-edit', 'cancel-schedule-edit']) $(id).disabled = false;
    const images = saved.message?.images || [];
    $('scheduled-attachments').textContent = images.length ? `${images.map(image => image.name).join(', ')} will be kept.` : '';
    $('edit-schedule-error').hidden = true;
    const dialog = $('edit-schedule-dialog');
    dialog.onclose = () => { if (schedules.editing === target && !dialog.open) closeScheduledEditor(); };
    dialog.showModal(); opened = true; $('scheduled-text').focus();
  } catch (error) { showError(error); }
  finally {
    if (!opened) {
      if (schedules.editing === target) schedules.editing = null;
      if (target.lock) await api.editLock(task.threadId, target.lock).catch(showError);
    }
  }
}
function saveScheduledDraft() {
  const target = schedules.editing;
  if (!target?.draftTarget || !api.saveDraft) return;
  saveEditorDraft(target.draftTarget, $('scheduled-text').value, { runAt: $('scheduled-time').value });
}
$('scheduled-text').oninput = saveScheduledDraft;
$('scheduled-time').oninput = saveScheduledDraft;
$('edit-schedule-form').onsubmit = async event => {
  event.preventDefault();
  const target = schedules.editing;
  if (!target || target.saving || state.options !== target.options || state.selection !== target.selection) return;
  const expected = editorDrafts.get(editorDraftKey(target.draftTarget))?.expected;
  target.saving = true;
  for (const id of ['scheduled-text', 'scheduled-time', 'save-schedule-edit', 'cancel-schedule-edit']) $(id).disabled = true;
  try {
    const value = $('scheduled-time').value;
    if (!value || !Number.isFinite(new Date(value).getTime())) throw new Error('Choose a send date and time.');
    const text = $('scheduled-text').value.trim();
    const available = promptSkillNames(text).length ? await resolvePromptSkills(text) : [];
    if (schedules.editing !== target || state.options !== target.options || state.selection !== target.selection || !state.connected) return;
    const skills = skillInputs(text, [...(target.task.message?.input.filter(part => part.type === 'skill') || []), ...available], target.task.cwd);
    await api.editScheduledTask(target.task.id, { text, runAt: value === target.time ? target.task.runAt : new Date(value).toISOString(), skills }, target.lock);
    clearDraft(target.draftTarget, expected);
    if (schedules.editing !== target || state.options !== target.options) return;
    closeScheduledEditor(); await refreshSchedules();
  } catch (error) { if (schedules.editing === target) { $('edit-schedule-error').textContent = error.message; $('edit-schedule-error').hidden = false; } }
  finally {
    target.saving = false;
    if (!schedules.editing || schedules.editing === target) for (const id of ['scheduled-text', 'scheduled-time', 'save-schedule-edit', 'cancel-schedule-edit']) $(id).disabled = false;
  }
};
function closeScheduledEditor() {
  const target = schedules.editing; schedules.editing = null;
  $('edit-schedule-dialog').close();
  if (target?.lock) api.editLock(target.task.threadId, target.lock).catch(showError);
}
$('cancel-schedule-edit').onclick = () => { clearDraft(schedules.editing?.draftTarget); closeScheduledEditor(); };
$('edit-schedule-dialog').oncancel = event => { event.preventDefault(); if (!schedules.editing?.saving) { clearDraft(schedules.editing?.draftTarget); closeScheduledEditor(); } };
function renderSchedules() {
  const container = $('scheduled-messages');
  container.replaceChildren();
  const tasks = state.thread ? scheduledFor(state.thread.id) : [];
  container.hidden = !tasks.length;
  for (const task of tasks) {
    const row = document.createElement('div'); row.className = 'scheduled-message';
    const label = document.createElement('span'); label.className = 'scheduled-copy';
    const date = new Date(task.runAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const status = task.needsReview ? 'Run status unknown; check sending computer' : task.status === 'claimed' ? 'Preparing scheduled message' : task.status === 'sending' ? 'Sending scheduled message' : task.status === 'unconfirmed' ? 'Unconfirmed; check history' : `Scheduled · ${date}${task.sharedTo && !task.sharedImported && !task.shared ? ' · Waiting to sync' : ''}`;
    label.textContent = `${status} · ${task.prompt}`;
    label.title = `${new Date(task.runAt).toLocaleString()}\n${task.prompt}${task.error ? '\n' + task.error : ''}`;
    row.append(label);
    if (task.status === 'pending') {
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'subtle'; edit.textContent = 'Edit';
      edit.title = 'Edit scheduled message'; edit.setAttribute('aria-label', edit.title); edit.onclick = () => openScheduledEdit(task);
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'subtle'; cancel.textContent = '×';
      cancel.title = 'Cancel scheduled message'; cancel.setAttribute('aria-label', cancel.title);
      cancel.onclick = async () => {
        cancel.disabled = true;
        try { await api.cancelScheduledTask(task.id); await refreshSchedules(); }
        catch (error) { showError(error); renderSchedules(); }
      };
      row.append(edit, cancel);
    }
    if (task.shared && (task.status === 'unconfirmed' || task.needsReview)) {
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'subtle'; dismiss.textContent = 'Check delivery';
      dismiss.onclick = async () => {
        dismiss.disabled = true;
        try { await api.dismissScheduledTask(task.id); await refreshSchedules(); }
        catch (error) { showError(error); renderSchedules(); }
        finally { dismiss.disabled = false; }
      };
      row.append(dismiss);
    }
    container.append(row);
  }
}
function queueKey(threadId) { return accessKey() + ':' + threadId; }
function markQueuePaused(queue) { queue.paused = true; queue.retry = null; }
async function persistQueue(queue) {
  queue.saving = (queue.saving || 0) + 1; renderQueue();
  try { await api.saveQueue({ key: queue.key, machine: queue.machine, thread: queue.thread, messages: queue.messages, paused: queue.paused }); }
  catch (error) { trace('queue.save.failed', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, error: error.message }); markQueuePaused(queue); renderQueue(); throw new Error(`Could not save queued messages: ${error.message}`); }
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
function pauseQueue(queue, reason = 'requested') { trace('queue.paused', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, reason }); markQueuePaused(queue); return persistQueue(queue); }
function pauseQueues(reason = 'reconnect') {
  for (const queue of state.queues.values()) if (queue.machine === accessKey() && queue.messages.length) pauseQueue(queue, reason).catch(showError);
}
function pendingQueueRetry(queue) {
  const retry = queue?.retry;
  return retry && retry.options === state.options && queue.messages.includes(retry.message) ? retry : null;
}
async function retryQueue(queue, message = queue.messages[0]) {
  if (!message || !queue.messages.includes(message) || !queue.paused || pendingQueueRetry(queue) || queue.saving || queue.editing || queueLocked(queue) || state.dispatching.has(queue.key)) return;
  trace('queue.retry', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length });
  const retry = { message, options: state.options, ready: false };
  queue.retry = retry;
  renderQueue();
  const current = () => pendingQueueRetry(queue) === retry && state.connected && queue.machine === accessKey() && state.queues.get(queue.key) === queue;
  try {
    await ensureWritable(queue.thread.id);
    if (!current()) return;
    await reconcileActiveTurn(queue.thread.id, retry);
    if (!current()) return;
    retry.ready = true;
    renderQueue();
    await flushQueue(queue.thread.id);
  } finally {
    if (!retry.ready && queue.retry === retry) { queue.retry = null; renderQueue(); }
  }
}
function renderQueue() {
  const queue = state.queues.get(queueKey(state.thread?.id));
  const native = state.nativeQueues.get(state.thread?.id);
  if (queueDrag.source) {
    if (queueDrag.source.queue === queue && queueDrag.source.options === state.options && queueDrag.source.selection === state.selection) return;
    clearQueueDrag(); return;
  }
  $('queued-messages').replaceChildren();
  $('queued-messages').hidden = !queue?.messages.length && !native?.items.length;
  const retry = pendingQueueRetry(queue);
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
    label.disabled = state.dispatching.has(queue.key) || Boolean(queue.saving || queue.editing) || queueLocked(queue);
    label.onclick = () => editQueuedMessage(queue, message);
    const retrying = retry?.message === message;
    label.textContent = (queue.paused && !retrying ? 'Waiting · ' : 'Queued · ') + (message.text || `${message.images.length} image(s)`);
    row.append(label);
    const action = (text, run, disabled = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle'; button.textContent = text;
      button.disabled = disabled || state.sending || state.dispatching.has(queue.key) || Boolean(queue.saving || queue.editing) || queueLocked(queue) || !state.connected;
      button.onclick = () => { if (!queueLocked(queue)) return run().catch(showError); }; row.append(button);
    };
    action('Edit', async () => editQueuedMessage(queue, message));
    if (queue.paused && !retrying) action('Retry', async () => retryQueue(queue, message), Boolean(retry));
    if (state.owned.has(queue.thread.id) && state.active.has(queue.thread.id)) action('Steer', async () => {
      const options = state.options;
      await reconcileActiveTurn(queue.thread.id);
      if (state.options !== options || queue.machine !== accessKey() || state.queues.get(queue.key) !== queue) return;
      if (!state.active.has(queue.thread.id)) throw new Error('This turn finished. Use Retry to send a follow-up.');
      await sendQueued(queue, message, true); await flushQueue(queue.thread.id);
    });
    action('×', async () => { const previous = queue.messages; queue.messages = queue.messages.filter(entry => entry !== message); try { await persistQueue(queue); } catch (error) { queue.messages = previous; throw error; } finally { renderQueue(); } });
    row.lastChild.setAttribute('aria-label', 'Remove queued message');
    $('queued-messages').append(row);
  }
  for (const [index, item] of (native?.items || []).entries()) {
    const row = document.createElement('div'); row.className = 'queued-message native-queued-message';
    const label = document.createElement('span');
    label.textContent = `${native.autoDrain ? 'Queued' : 'Paused'} in ${agentName()} · ${item.text || (item.attachments?.length ? `${item.attachments.length} attachment(s)` : item.kind === 'compact' ? 'Compact context' : 'Queued message')}`;
    row.append(label);
    const options = state.options, threadId = state.thread.id;
    const action = (text, method, params) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle'; button.textContent = text;
      button.disabled = !state.connected || state.loading || !supports(method) || Boolean(item.editLock);
      button.onclick = async () => {
        if (options !== state.options || state.thread?.id !== threadId || state.nativeQueues.get(threadId) !== native || button.disabled) return;
        button.disabled = true;
        try { await rpc(method, { threadId, ...params }); }
        catch (error) { if (options === state.options) showError(error); }
        finally { if (options === state.options && state.thread?.id === threadId) renderQueue(); }
      };
      row.append(button);
    };
    if (!native.autoDrain && index === 0) action('Resume', 'queue/resume');
    action('×', 'queue/delete', { queueItemId: item.queueItemId });
    row.lastChild.setAttribute('aria-label', 'Remove queued message from ' + agentName());
    $('queued-messages').append(row);
  }
  if (state.thread && !state.loading) scrollToBottom();
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

async function submitMessage(message, steer = false, repairReasoning = false) {
  const key = message.machine + ':' + message.thread.id;
  if (state.dispatching.has(key)) throw new Error('A message is already being sent.');
  const turnId = state.active.get(message.thread.id);
  if (steer && !turnId) throw new Error('This turn finished. Send the message as a follow-up.');
  if (accessKey() === message.machine) setCompletion(message.thread.id);
  state.dispatching.add(key); updateBusy();
  trace('message.dispatch', { machine: message.machine, threadId: message.thread.id, turnId, steer, owned: state.owned.has(message.thread.id) });
  const visible = () => accessKey() === message.machine && state.thread?.id === message.thread.id;
  const temporary = 'pending-' + crypto.randomUUID();
  if (visible()) { renderItem({ type: 'userMessage', id: temporary, content: message.input }); scrollToBottom(); }
  let startedTurn;
  try {
    if (!state.owned.has(message.thread.id)) await ensureWritable(message.thread.id);
    if (steer) await rpc('turn/steer', { threadId: message.thread.id, input: message.input, expectedTurnId: turnId });
    else {
      const settings = turnSettings(message);
      if (message.review) await rpc('thread/settings/update', settings);
      const result = message.review ? await rpc('review/start', { threadId: message.thread.id, target: { type: 'uncommittedChanges' }, delivery: 'inline' }) : await rpc('turn/start', { ...settings, input: message.input }, repairReasoning);
      startedTurn = result.turn;
      if (accessKey() === message.machine && startedTurn.status === 'inProgress' && !state.finished.has(startedTurn.id)) state.active.set(message.thread.id, startedTurn.id);
    }
    if (accessKey() === message.machine) { state.newThreads.delete(message.thread.id); requestTitle({ ...message.thread, preview: message.text }); }
    trace('message.accepted', { machine: message.machine, threadId: message.thread.id, steer });
    return startedTurn;
  } catch (error) {
    trace('message.failed', { machine: message.machine, threadId: message.thread.id, steer, error: error.message });
    if (visible()) { state.items.get(temporary)?.element.remove(); state.items.delete(temporary); }
    throw error;
  } finally { state.dispatching.delete(key); updateBusy(); }
}
async function sendQueued(queue, message, steer = false, repairReasoning = false, retry = null) {
  const options = state.options;
  const selected = () => {
    if (retry) return queue.retry === retry && queue.messages.includes(message);
    return steer ? queue.messages.includes(message) : !queue.paused && queue.messages[0] === message;
  };
  const ready = () => state.options === options && state.connected && accessKey() === queue.machine && state.queues.get(queue.key) === queue && selected() && !state.sending && !state.dispatching.has(queue.key) && !queue.saving && !queueLocked(queue) && (steer || !queue.editing && !state.active.has(queue.thread.id));
  const deferred = phase => trace('queue.deferred', { machine: queue.machine, threadId: queue.thread.id, phase, connected: state.connected, working: state.active.has(queue.thread.id), paused: queue.paused, queueLength: queue.messages.length });
  if (!ready()) return;
  try {
    await persistQueue(queue);
    if (!ready()) { deferred('after-save'); return; }
    if (!state.owned.has(queue.thread.id)) await ensureWritable(queue.thread.id);
    if (!ready()) { deferred('after-resume'); return; }
    if (retry) retry.completedTurns = new Set();
    const turn = await submitMessage(message, steer, repairReasoning);
    if (retry?.completedTurns.has(turn?.id) && state.connected && state.options === options) playCompletionSound();
    if (queue.retry?.message === message) queue.retry = null;
    queue.messages = queue.messages.filter(entry => entry !== message);
    await persistQueue(queue);
  } catch (error) {
    trace('queue.failed', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, error: error.message });
    await pauseQueue(queue, 'send-failed').catch(showError);
    showError(`Queued message was not confirmed: ${error.message} Check history before retrying.`);
  } finally {
    if (retry) delete retry.completedTurns;
  }
  renderQueue();
}
async function flushQueue(threadId, repairReasoning = false) {
  const queue = state.queues.get(queueKey(threadId));
  if (!queue || queue.editing || queue.saving || queueLocked(queue) || !state.connected || state.sending || state.dispatching.has(queue.key) || state.active.has(threadId) || (state.loading && state.thread?.id === threadId)) return;
  const pendingRetry = queue.paused ? pendingQueueRetry(queue) : null;
  const retry = pendingRetry?.ready ? pendingRetry : null;
  const message = queue.paused ? retry?.message : queue.messages[0];
  if (!message) return;
  await sendQueued(queue, message, false, repairReasoning || Boolean(retry), retry);
  if (!queue.paused && queue.messages.length && !state.active.has(threadId)) await flushQueue(threadId);
}
function shortcutUnavailable(shortcut) {
  if (shortcut?.mode === 'fill') return state.connecting || state.sending || state.loading || state.commandBusy || drafts.suspended;
  return Boolean(state.messageEdit) || conversationReadOnly() || modelUnavailable() || !state.connected || state.connecting || state.loading || state.commandBusy || queueLocked(state.queues.get(queueKey(state.thread?.id)));
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
  const options = state.options, selection = state.selection, failure = state.lastSendFailure;
  let pendingSend = state.sendOperation;
  const last = state.shortcutTask;
  const previous = last?.options === options && last?.selection === selection ? last : null;
  const waiting = previous && !previous.finished;
  const current = () => options === state.options && selection === state.selection && state.connected;
  const job = { finished: false, options, selection };
  job.promise = (previous?.promise || Promise.resolve()).then(async result => {
    if (!current()) return;
    if (pendingSend) { await pendingSend.ready; if (!current() || !state.thread) return; }
    const skills = await resolvePromptSkills(shortcut.prompt, true);
    if (state.sendOperation && state.sendOperation !== pendingSend) {
      pendingSend = state.sendOperation;
      await pendingSend.ready;
      if (!current() || !state.thread) return;
    }
    const failed = state.lastSendFailure;
    const sendFailed = failed !== failure && failed?.options === options && failed?.selection === selection;
    if (current() && !shortcutUnavailable(shortcut)) return send(null, false, { shortcut: shortcut.prompt, skills, paused: pendingSend?.failed || sendFailed || waiting && result?.failed && result.options === options && result.selection === selection });
  }).catch(error => { if (current()) showError(error); }).finally(() => { job.finished = true; });
  state.shortcutTask = job;
  return job.promise;
}
const defaultShortcuts = [{ id: 'review', label: 'Review', prompt: '$cr ur changes' }];
const shortcutDragType = 'application/x-remote-codex-shortcut';
let draggedShortcut = null;
function promptShortcuts() { return preferences.shortcuts ?? defaultShortcuts; }
function editShortcut(shortcut = null) {
  if (state.savingShortcut) return;
  state.shortcutEdit = shortcut;
  $('shortcut-label').value = shortcut?.label || ''; $('shortcut-prompt').value = shortcut?.prompt || '';
  $('shortcut-mode').value = shortcut?.mode || 'send';
  $('delete-shortcut').hidden = !shortcut; $('shortcut-error').hidden = true;
  $('shortcut-dialog').showModal(); $('shortcut-label').focus();
}
function bindShortcutDrag(button, id) {
  const removeTarget = () => button.classList.remove('shortcut-drop-before', 'shortcut-drop-after');
  const valid = event => draggedShortcut && draggedShortcut.id !== id && !state.savingShortcut && event.dataTransfer?.types.includes(shortcutDragType);
  const after = event => {
    const { left, width } = button.getBoundingClientRect();
    return event.clientX >= left + width / 2;
  };
  button.draggable = true;
  button.ondragstart = event => {
    if (state.savingShortcut || !event.dataTransfer) { event.preventDefault(); return; }
    draggedShortcut = { id, button };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(shortcutDragType, id);
    button.classList.add('shortcut-dragging');
  };
  button.ondragend = () => { if (draggedShortcut?.button === button) clearShortcutDrag(); };
  button.ondragover = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const dropAfter = after(event);
    button.classList.toggle('shortcut-drop-before', !dropAfter);
    button.classList.toggle('shortcut-drop-after', dropAfter);
  };
  button.ondragleave = removeTarget;
  button.ondrop = event => {
    if (!valid(event) || event.dataTransfer.getData(shortcutDragType) !== draggedShortcut.id) return;
    event.preventDefault();
    const shortcutMove = { id: draggedShortcut.id, targetId: id, after: after(event) };
    clearShortcutDrag();
    return persistShortcuts({ shortcutMove });
  };
}
function clearShortcutDrag() {
  draggedShortcut = null;
  for (const button of $('shortcut-buttons').children) button.classList.remove('shortcut-dragging', 'shortcut-drop-before', 'shortcut-drop-after');
}
function renderShortcutSaveStatus(queued) {
  preferences.shortcutMoveQueued = Boolean(queued);
  $('shortcut-save-status').hidden = !queued;
}
function renderShortcuts() {
  draggedShortcut = null;
  $('shortcut-buttons').replaceChildren();
  const shortcuts = promptShortcuts();
  for (const shortcut of shortcuts) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = shortcut.label;
    button.dataset.mode = shortcut.mode || 'send'; button.disabled = shortcutUnavailable(shortcut);
    button.title = `${shortcut.prompt}\n${shortcut.mode === 'fill' ? 'Fill prompt only' : 'Send or queue immediately'} · Right-click to edit`;
    if (shortcuts.length > 1) { button.title += ' · Drag to reorder'; bindShortcutDrag(button, shortcut.id); }
    button.onclick = () => runShortcut(shortcut);
    button.oncontextmenu = event => { event.preventDefault(); editShortcut(shortcut); };
    $('shortcut-buttons').append(button);
  }
}
async function persistShortcuts(patch) {
  if (state.savingShortcut) return;
  state.savingShortcut = true;
  const editing = $('shortcut-dialog').open;
  for (const button of $('shortcut-form').querySelectorAll('button')) button.disabled = true;
  try { await savePreferences(patch); renderShortcuts(); if (editing) $('shortcut-dialog').close(); }
  catch (error) {
    if (editing) { $('shortcut-error').textContent = error.message; $('shortcut-error').hidden = false; }
    else showError(`Could not reorder shortcuts: ${error.message}`);
  }
  finally { state.savingShortcut = false; for (const button of $('shortcut-form').querySelectorAll('button')) button.disabled = false; }
}
$('add-shortcut').onclick = () => editShortcut();
$('cancel-shortcut').onclick = () => $('shortcut-dialog').close();
$('shortcut-dialog').oncancel = event => { if (state.savingShortcut) event.preventDefault(); };
$('shortcut-form').onsubmit = event => {
  event.preventDefault();
  const shortcut = { id: state.shortcutEdit?.id || crypto.randomUUID(), label: $('shortcut-label').value.trim(), prompt: $('shortcut-prompt').value, mode: $('shortcut-mode').value };
  if (!shortcut.label || !shortcut.prompt.trim()) return;
  const shortcuts = state.shortcutEdit ? promptShortcuts().map(item => item.id === shortcut.id ? shortcut : item) : [...promptShortcuts(), shortcut];
  return persistShortcuts({ shortcuts });
};
$('delete-shortcut').onclick = () => persistShortcuts({ shortcuts: promptShortcuts().filter(item => item.id !== state.shortcutEdit?.id) });
renderShortcuts();
async function enqueueMessage(message, paused = false) {
  const key = message.machine + ':' + message.thread.id;
  const queue = state.queues.get(key) || { key, machine: message.machine, thread: message.thread, messages: [], paused: false };
  if (paused) markQueuePaused(queue);
  else if (!queue.messages.length) queue.paused = false;
  queue.messages.push(message); state.queues.set(key, queue);
  try { await persistQueue(queue); } catch (error) { queue.messages = queue.messages.filter(entry => entry !== message); throw error; }
  trace('send.queued', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, paused: queue.paused });
  return queue;
}
async function send(event, steer = false, action = null) {
  event?.preventDefault();
  if (state.messageEdit || state.connecting || queueLocked(state.queues.get(queueKey(state.thread?.id)))) return;
  const shortcut = typeof action?.shortcut === 'string';
  const rawText = shortcut ? action.shortcut : $('prompt').value; const text = rawText.trim();
  if (!action && !steer && /^\/[a-z-]*(?:\s|$)/i.test(text)) { await executeSlash(text); return; }
  if (state.commandBusy && !action) return;
  const images = shortcut ? [] : [...state.images];
  if ((!text && !images.length) || images.some(image => !image.url) || !state.connected || state.sending && (!shortcut || !state.thread) || state.loading) return;
  if (modelUnavailable()) { showError(`${agentName()} model is unavailable. Reconnect or select another model.`); return; }
  if (conversationReadOnly()) { showError('Use this conversation on this computer before sending messages.'); return; }
  $('error').hidden = true;
  saveComposerDraft(); const originalDraft = drafts.target;
  const delayHours = !steer && !action ? Number($('send-time').value) : 0;
  const input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'image', url: image.url })), ...skillInputs(text, action?.skills)];
  const access = policy();
  const message = { draftId: crypto.randomUUID(), text, images, input, access, review: Boolean(action?.review), mode: modes.plan ? 'plan' : 'default', model: $('model').value, effort: $('effort').value, machine: accessKey(), thread: state.thread };
  const options = state.options; const selection = state.selection;
  trace('send.requested', { machine: message.machine, threadId: state.thread?.id, delayHours, working: state.active.has(state.thread?.id), status: state.thread?.status?.type, queueLength: state.queues.get(queueKey(state.thread?.id))?.messages.length || 0, paused: Boolean(state.queues.get(queueKey(state.thread?.id))?.paused) });
  if (shortcut && message.thread) {
    try {
      const queue = await enqueueMessage(message, action.paused);
      flushQueue(message.thread.id, true).catch(showError);
      return { failed: queue.paused, options, selection };
    } catch (error) { showError(error); return { failed: true, options, selection }; }
  }
  let readyThread;
  const operation = { failed: false, options, selection, ready: new Promise(resolve => { readyThread = resolve; }) };
  state.sendOperation = operation;
  state.sending = true; updateBusy();
  try {
    if (!action?.skills && promptSkillNames(text).length) {
      const skills = await resolvePromptSkills(text);
      if (options !== state.options || selection !== state.selection || !state.connected) return;
      message.input = [...input.filter(part => part.type !== 'skill'), ...skillInputs(text, skills)];
    }
    if (!state.thread) {
      const projectId = projects.selected && identityProvider(projects.selected) === selectedProvider() ? projects.selected : null;
      const result = await rpc('thread/start', { cwd: $('workspace').value.trim(), historyMode: 'paginated', ...access, ...(projectId ? { projectId } : {}), ...(message.model ? { model: message.model } : {}) });
      if (projectId && !result.thread.projectId) result.thread.projectId = projectId;
      if (originalDraft && api.moveDraft) api.moveDraft(originalDraft, { machine: message.machine, kind: 'composer', threadId: result.thread.id, cwd: result.thread.cwd, projectId: result.thread.projectId || projectId || null });
      if (!result.thread.preview?.trim()) result.thread.preview = text || 'Image';
      state.newThreads.add(result.thread.id);
      state.owned.add(result.thread.id);
      modes.threads.set(result.thread.id, message.mode === 'plan');
      setThread(result.thread);
      state.historyView = newHistoryView(result.thread);
      state.threads.unshift(result.thread); renderThreads();
      message.thread = result.thread;
      if (delayHours) {
        const name = (text || 'Scheduled image').replace(/\s+/g, ' ').slice(0, 80);
        await rpc('thread/name/set', { threadId: result.thread.id, name });
        applyName(result.thread.id, name);
      }
    } else if (!delayHours && !state.owned.has(state.thread.id)) await ensureWritable(state.thread.id);
    readyThread();
    if (shortcut) { await enqueueMessage(message, action.paused); return operation; }
    if (delayHours) {
      await api.scheduleMessage({ ...message, turnSettings: turnSettings(message) }, delayHours);
      trace('send.scheduled', { machine: message.machine, threadId: message.thread.id, delayHours });
      $('prompt').value = ''; hideSlash(); state.images = []; renderImages(); $('send-time').value = '0';
      await refreshSchedules().catch(showError);
      return;
    }
    const key = queueKey(state.thread.id);
    if (!steer && (state.active.has(state.thread.id) || state.dispatching.has(key) || state.queues.get(key)?.messages.length)) {
      await enqueueMessage(message);
      if (!shortcut) { $('prompt').value = ''; hideSlash(); state.images = []; renderImages(); }
      return;
    }
    if (!shortcut) { $('prompt').value = ''; hideSlash(); state.images = []; renderImages(); }
    await submitMessage(message, steer, true);
  } catch (error) {
    operation.failed = true; state.lastSendFailure = operation;
    trace('send.failed', { machine: message.machine, threadId: message.thread?.id, error: error.message });
    const queue = message.thread && state.queues.get(message.machine + ':' + message.thread.id);
    if (queue?.messages.length) await pauseQueue(queue, 'send-failed').catch(showError);
    if (delayHours) $('send-time').value = String(delayHours);
    if (!shortcut && options === state.options && selection === state.selection) { if (!$('prompt').value) $('prompt').value = rawText; state.images = images; renderImages(); }
    showError(error);
  } finally {
    if (state.sendOperation === operation) state.sendOperation = null;
    readyThread();
    state.sending = false; updateBusy();
    if (options === state.options && selection === state.selection && originalDraft && drafts.target && JSON.stringify(originalDraft) !== JSON.stringify(drafts.target) && saveComposerDraft()) clearDraft(originalDraft);
    for (const queue of state.queues.values()) if (queue.machine === accessKey()) flushQueue(queue.thread.id).catch(showError);
  }
  return operation;
}
function applyName(threadId, name) {
  if (typeof name !== 'string' || !name.trim()) return;
  clearTitleRetry(threadId);
  state.names.set(threadId, name);
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.name = name;
  if (state.thread?.id === threadId) $('thread-title').textContent = name;
  renderThreads();
}
function clearTitleRetry(threadId) {
  clearTimeout(state.titleRetries.get(threadId)?.timer);
  state.titleRetries.delete(threadId);
  if (state.titleError?.threadId === threadId && state.titleError.options === state.options) {
    state.titleError = null; $('error').hidden = true;
  }
}
function requestTitle(thread) {
  if (!api.title || !state.connected || !thread.preview?.trim() || thread.name || state.names.has(thread.id) || state.titling.has(thread.id) || state.newThreads.has(thread.id) || state.archiving?.threadId === thread.id || Date.now() < (state.titleRetries.get(thread.id)?.after || 0)) return;
  const options = state.options;
  const operation = {};
  state.titling.set(thread.id, operation);
  const current = () => state.options === options && state.titling.get(thread.id) === operation;
  state.titleTask = state.titleTask.catch(() => {}).then(async () => {
    try {
      if (!current() || !state.connected) return;
      const name = await api.title(thread.id, thread.preview.slice(0, 4000));
      if (current() && name && !state.names.has(thread.id)) {
        applyName(thread.id, name);
        trace('title.completed', { threadId: thread.id });
      }
    } catch (error) {
      if (current() && state.connected && !state.names.has(thread.id)) {
        const count = (state.titleRetries.get(thread.id)?.count || 0) + 1;
        const retry = { count, after: Date.now() + 60000 };
        clearTitleRetry(thread.id); state.titleRetries.set(thread.id, retry);
        if (count <= 2) retry.timer = setTimeout(() => {
          if (state.options === options && state.titleRetries.get(thread.id) === retry) requestTitle(thread);
        }, 60000);
        trace('title.failed', { threadId: thread.id, error: error.message, count });
        showError(error);
        state.titleError = { threadId: thread.id, options };
      }
    } finally { if (current()) state.titling.delete(thread.id); }
  });
}
function showThreadMenu(thread, x, y) {
  $('project-menu').hidden = true;
  state.contextThread = thread;
  const menu = $('thread-menu'); menu.hidden = false;
  $('recover-edit-drafts').hidden = !api.editDrafts || !supportsNativeEdit(thread);
  $('clone-conversation').disabled = !supports('thread/fork', threadProvider(thread)) || !state.connected || state.sending || state.commandBusy || state.loading;
  $('mark-unread').disabled = state.unread.has(queueKey(thread.id));
  $('archive-conversation').disabled = !canArchiveConversation(thread);
  $('archive-conversation').title = state.active.has(thread.id) || thread.status?.type === 'active' ? 'Stop the running task before archiving' : state.queues.get(queueKey(thread.id))?.messages.length || state.nativeQueues.get(thread.id)?.items.length ? 'Send or remove queued messages before archiving' : scheduledFor(thread.id).some(task => task.status === 'pending') ? 'Cancel scheduled messages before archiving' : '';
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
  $('clone-conversation').focus();
}
function canArchiveConversation(thread) {
  const key = queueKey(thread?.id);
  const queue = state.queues.get(key);
  return Boolean(thread?.id && state.connected && !state.connecting && !state.sending && !state.commandBusy && !state.loading && !state.pinning.has(thread.id) && !state.active.has(thread.id) && thread.status?.type !== 'active' && !state.dispatching.has(key) && !queue?.messages.length && !queue?.saving && !state.nativeQueues.get(thread.id)?.items.length && !scheduledFor(thread?.id).some(task => task.status === 'pending'));
}
async function archiveConversation(thread) {
  if (!canArchiveConversation(thread)) return;
  const operation = { threadId: thread.id, options: state.options };
  state.archiving = operation; state.commandBusy = true;
  $('thread-menu').hidden = true; updateBusy(); renderThreads();
  try {
    await rpc('thread/archive', { threadId: thread.id });
    if (state.archiving !== operation || state.options !== operation.options) return;
    recentTimelines.delete(thread.id);
    if (state.historyView?.threadId === thread.id) state.historyView = null;
    state.titling.delete(thread.id); clearTitleRetry(thread.id);
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
  const nativeEdit = supportsNativeEdit(state.thread);
  if (state.sending || state.commandBusy || state.loading || !record.turnId || state.items.get(record.item.id) !== record
    || (nativeEdit ? record.item.canEdit !== true || conversationReadOnly() : !state.connected)) return;
  const queue = state.queues.get(queueKey(state.thread.id));
  if (state.active.has(state.thread.id) || state.dispatching.has(queueKey(state.thread.id)) || queue?.saving || queueLocked(queue)) { showError('Wait for the running task before editing earlier messages.'); return; }
  if (nativeEdit && state.nativeQueues.get(state.thread.id)?.items.length) { showError('Send or remove queued messages before editing.'); return; }
  if (state.messageEdit?.record === record || state.messageEdit?.uncertain) { $('edited-message').focus(); return true; }
  closeMessageEdit({ save: true, resumeQueue: false });
  const draftTarget = editorTarget('edit-message', state.thread, nativeEdit ? record.item.id : record.turnId);
  const content = record.item.content || [];
  const attachmentCount = nativeEdit ? record.item.attachmentCount || 0 : content.filter(part => part.type !== 'text' && part.type !== 'skill').length;
  state.messageEdit = { record, thread: state.thread, turnId: record.turnId, itemId: record.item.id, content, attachmentCount, options: state.options, queue, draftTarget };
  if (queue) queue.editing = true;
  $('edit-message-error').textContent = ''; $('edit-message-error').hidden = true;
  $('edited-message').value = editorText(draftTarget, content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  renderMessageDraftStatus(draftTarget);
  $('edited-message-attachments').textContent = `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'} will be kept.`;
  $('edited-message-attachments').hidden = !attachmentCount;
  $('cancel-message-edit').textContent = 'Cancel';
  record.body.hidden = true;
  record.body.after($('edit-message-form'));
  $('edit-message-form').hidden = false;
  updateBusy();
  $('edited-message').focus();
  return true;
}
function saveMessageEdit() {
  const target = state.messageEdit?.draftTarget;
  if (!target || state.resending) return;
  const draft = editorDrafts.get(editorDraftKey(target));
  const text = $('edited-message').value;
  if (draft?.unsaved || text !== (draft?.expected?.text ?? draft?.fallback)) saveEditorDraft(target, text);
  renderMessageDraftStatus(target);
}
function renderMessageDraftStatus(target) {
  const notice = $('edit-message-draft-status');
  const unsaved = editorDrafts.get(editorDraftKey(target))?.unsaved;
  notice.textContent = unsaved ? `Draft kept in this window. Could not save it to disk. ${unsaved.error}` : '';
  notice.hidden = !unsaved;
}
function closeMessageEdit({ save = false, focus = false, resumeQueue = true } = {}) {
  const target = state.messageEdit;
  if (!target) return;
  if (save) saveMessageEdit();
  state.messageEdit = null;
  $('edit-message-form').hidden = true;
  $('edit-message-form').remove();
  target.record.body.hidden = false;
  if (focus) target.record.label.querySelector('.edit-message')?.focus({ preventScroll: true });
  if (target.queue) {
    target.queue.editing = false;
    if (resumeQueue) queueMicrotask(() => { if (target.options === state.options && state.connected && !state.commandBusy) flushQueue(target.thread.id).catch(showError); });
  }
}
async function resendMessage(target, text) {
  if (!target || target.uncertain || state.sending || state.commandBusy || state.loading || target.options !== state.options || target.thread.id !== state.thread?.id) return;
  const expected = editorDrafts.get(editorDraftKey(target.draftTarget))?.expected;
  const thread = target.thread; const machine = accessKey(); const key = queueKey(thread.id);
  const nativeEdit = supportsNativeEdit(thread);
  const operation = {}; state.resending = operation; state.commandBusy = true; updateBusy();
  const current = () => state.resending === operation && state.options === target.options && state.connected && state.thread?.id === thread.id;
  let lock, queue, reverted = false, saved = false, editAccepted = false;
  $('edit-message-error').textContent = ''; $('edit-message-error').hidden = true;
  try {
    if (!state.connected) throw new Error('Connect to a coding agent before resending.');
    if (modelUnavailable()) throw new Error('Selected model is unavailable. Reconnect or select another model before resending.');
    const message = { draftId: crypto.randomUUID(), text, images: [], input: [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...target.content.filter(part => !['text', 'skill'].includes(part.type)), ...skillInputs(text, target.content.filter(part => part.type === 'skill'), thread.cwd)], access: policy(), mode: modes.plan ? 'plan' : 'default', model: $('model').value, effort: $('effort').value, machine, thread };
    turnSettings(message);
    if (state.active.has(thread.id)) throw new Error('Stop the running task before editing earlier messages.');
    if (thread.historyMode === 'legacy' || thread.ephemeral) throw new Error(`This conversation uses a history format that ${agentName()} cannot edit in place.`);
    lock = await api.editLock(thread.id);
    if (!current()) return;
    await ensureWritable(thread.id);
    if (!current()) return;
    if (state.active.has(thread.id)) throw new Error('Stop the running task before editing earlier messages.');
    if (nativeEdit && state.nativeQueues.get(thread.id)?.items.length) throw new Error('Send or remove queued messages before editing.');
    queue = state.queues.get(key);
    if (queue?.messages.length) await pauseQueue(queue, 'history-edit');
    if (!current()) return;
    if (modelUnavailable(message.model, threadProvider(thread))) throw new Error('Selected model is unavailable. Reconnect or select another model before resending.');
    if (nativeEdit) {
      const result = await rpc('thread/edit', { ...turnSettings(message), beforeTurnId: target.turnId, itemId: target.itemId, input: message.input });
      editAccepted = true;
      if (!current()) return;
      clearDraft(target.draftTarget, expected);
      closeMessageEdit();
      await openThread(result.thread, true);
      if (current() && result.turn?.error?.message) showError(result.turn.error.message);
      return;
    }
    turnSettings(message);
    const result = await rpc('thread/revert', { threadId: thread.id, beforeTurnId: target.turnId }, true);
    reverted = true;
    trace('edit.reverted', { machine, threadId: thread.id, turnId: target.turnId });
    queue = state.queues.get(key) || { key, machine, thread, messages: [], paused: true };
    queue.messages.unshift(message); markQueuePaused(queue); state.queues.set(key, queue);
    await persistQueue(queue);
    saved = true;
    if (!current()) return;
    clearDraft(target.draftTarget, expected);
    closeMessageEdit();
    await openThread(result.thread, true);
    if (!current()) return;
    await submitMessage(message, false, true);
    const previous = queue.messages;
    queue.messages = queue.messages.filter(entry => entry !== message);
    try { await persistQueue(queue); } catch (error) { queue.messages = previous; throw error; }
  } catch (error) {
    trace('edit.failed', { machine, threadId: thread.id, error: error.message });
    if (state.resending === operation && state.options === target.options) {
      if (nativeEdit && !editAccepted && /Edit may have been submitted; check conversation history before retrying\./.test(error.message)) {
        target.uncertain = true;
        $('cancel-message-edit').textContent = 'Check history';
      }
      const message = editAccepted ? `The edit was sent, but the conversation could not reload. ${error.message}` : reverted ? saved ? `Edited message was not confirmed; its draft is saved in this conversation's paused queue. Check history before retrying. ${error.message}` : `History was updated, but the draft could not be saved. Keep the edited text before closing. ${error.message}` : error.message || String(error);
      if (state.messageEdit === target) { $('edit-message-error').textContent = message; $('edit-message-error').hidden = false; }
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
  if (previous && modelUnavailable() && ![...$('effort').options].some(option => option.value === previous)) $('effort').add(new Option(previous, previous, false, false));
  if ([...$('effort').options].some(option => option.value === previous)) $('effort').value = previous;
}
async function connect(options) {
  if (state.connecting || state.recovering) return;
  if (state.connected && !machineSettingsChanged(options)) {
    if (settingsBusy(options)) { showError('Finish or stop affected tasks before changing these settings.'); return; }
    const changed = changedProviders(options).length > 0;
    saveComposerDraft();
    const current = state.options; state.recovering = true;
    try {
      const result = await api.connect(options);
      if (state.options !== current) return;
      if (result?.options) Object.assign(state.options, result.options);
      state.connected = result?.connected ?? result?.options?.agents?.some(agent => agent.connected !== false && agent.enabled !== false && agent.available !== false) ?? state.connected;
      if (!state.connected) resetThreadListRequests(true);
      if (changed && state.connected) {
        await refreshAgentCatalogs();
        if (result?.reconnected?.length) await refreshProjects();
      } else renderModels();
      fillSettings(state.options); $('settings-error').textContent = ''; $('settings-dialog').close();
      status(state.connected ? connectedStatus() : 'Agents disabled');
    } catch (error) { if (state.options === current) { $('settings-error').textContent = error.message; showError(error); } }
    finally { state.recovering = false; updateBusy(); }
    return;
  }
  if (connectionBusy()) { showError('Finish or stop running tasks before changing the connection.'); return; }
  saveComposerDraft();
  state.connecting = true; status('Connecting…'); updateBusy();
  let connected = true;
  try { const result = await api.connect(options); options = result?.options || options; connected = result?.connected ?? options.agents?.some(agent => agent.connected !== false && agent.enabled !== false && agent.available !== false) ?? true; }
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
  state.nativeQueues.clear();
  state.options = options;
  recentTimelines.clear();
  state.historyView = null;
  conversationSync.ownership.clear(); conversationSync.historyEnabled = false;
  usage.generation++; usage.threads.clear(); usage.account = null; usage.reading = null; usage.updatedAt = 0; usage.error = null;
  state.commandBusy = false; state.branching = null; state.resending = null; state.archiving = null;
  projects.generation++; projects.data = []; projects.selected = null; projects.expanded.clear(); projects.cursors.clear(); projects.collapsed.clear();
  try { const saved = JSON.parse(localStorage.getItem(accessKey() + ':collapsed-projects') || '[]'); if (Array.isArray(saved)) projects.collapsed = new Set(saved.filter(id => typeof id === 'string')); } catch {}
  $('project-dialog').close(); state.projectDraft = null; $('move-project-dialog').close(); $('project-view-dialog').close();
  state.owned.clear(); state.resuming.clear();
  for (const threadId of state.titleRetries.keys()) clearTitleRetry(threadId);
  state.names.clear(); state.titling.clear(); state.newThreads.clear();
  slash.generation++; slash.skills = []; slash.cwd = null; slash.loading = false; modes.catalog = []; modes.threads.clear(); state.models = [];
  $('edit-queue-dialog').close();
  closeScheduledEditor();
  $('thread-menu').hidden = true; $('rename-dialog').close(); closeMessageEdit({ save: true });
  restoreAccess();
  restoreUnread();
  state.threads = [];
  state.pinnedIds.clear();
  state.pinnedThreads.clear();
  state.failedPins.clear();
  state.pinning.clear();
  state.threadCursor = null;
  state.threadQuery = null;
  state.threadSearch = null;
  state.threadCoverage = new Map();
  resetThreadListRequests();
  state.folderGeneration++;
  $('folder-dialog').close();
  state.active.clear(); compacting.clear();
  state.finished.clear();
  state.requests.clear();
  connectionLabels();
  $('workspace').value = isLocal() ? options.localCwd : options.cwd;
  resetThread();
  status('Connecting…');
  renderRequests();
  $('settings-error').textContent = '';
  try {
    state.connected = connected;
    if (!connected) { $('settings-dialog').close(); renderModels(); return; }
    $('workspace').value = isLocal() ? options.localCwd : options.cwd;
    $('thread-path').textContent = $('workspace').value;
  renderConversationNote();
    $('settings-dialog').close();
    $('error').hidden = true;
    resetThread();
    status(connectedStatus());
    refreshUsage();
    await refreshAgentCatalogs();
    try { state.pinnedIds = new Set(await api.pins()); } catch (error) { showError(error); }
    await loadProjects().catch(showError);
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
    state.connecting = false; status(state.connected ? connectedStatus() : connected ? 'Not connected' : 'Agents disabled');
  }
}
function handleNotification(message, reconciledRetry) {
  if (message.machine && message.machine !== accessKey()) return;
  if (message.method === 'scheduler/updated') { refreshSchedules().catch(showError); return; }
  if (message.method === 'conversations/synced') { refreshConversationSync().catch(showError); return; }
  const { method, params = {}, id } = message;
  if (method === 'provider/queue/updated') {
    if (params.queue?.items?.length) state.nativeQueues.set(params.threadId, params.queue);
    else state.nativeQueues.delete(params.threadId);
    if (state.thread?.id === params.threadId) { renderQueue(); updateMessageEdits(); }
    return;
  }
  if (['item/started', 'item/completed'].includes(method) && params.item?.type === 'contextCompaction') {
    if (method === 'item/started' && !state.finished.has(params.turnId) && (!state.active.has(params.threadId) || state.active.get(params.threadId) === params.turnId)) compacting.set(params.threadId, { itemId: params.item.id, turnId: params.turnId });
    else if (method === 'item/completed' && compacting.get(params.threadId)?.itemId === params.item.id) finishCompaction(params.threadId, params.turnId);
    updateBusy();
  }
  if (method === 'thread/compacted') { finishCompaction(params.threadId, params.turnId); updateBusy(); return; }
  if (method === 'providers/updated') {
    if (!state.options) return;
    state.options.agents = params.agents;
    const errors = params.agents.filter(agent => agent.error).map(agent => ({ provider: agent.id, message: agent.error }));
    if (errors.length) reportProviderErrors(errors);
    else if (state.providerError && $('error-text').textContent === state.providerError) { state.providerError = null; $('error').hidden = true; }
    syncComposerAgent(); updateBusy();
    if (params.reconnected?.length && !params.reconfigured?.length) return refreshAgentCatalogs().then(refreshProjects).catch(showError);
    return;
  }
  if (timelineView.following && state.thread && params.threadId === state.thread.id && !state.loading && !timelineAtBottom()) setTimelineFollowing(false);
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
    if (message.provider && message.provider !== selectedProvider()) return;
    if (state.connected && params.rateLimits) {
      if (usage.reading) usage.reading.updates.push(params.rateLimits);
      applyRateLimit(params.rateLimits); usage.updatedAt = Date.now(); renderUsage();
    }
    return;
  }
  if (method === 'account/updated') {
    if (message.provider && message.provider !== selectedProvider()) return;
    usage.generation++; usage.account = null; usage.reading = null; usage.error = null; usage.updatedAt = 0;
    renderUsage(); refreshUsage(); return;
  }
  if (method === 'provider/closed') {
    const provider = message.provider || params.provider;
    for (const threadId of recentTimelines.keys()) if (identityProvider(threadId) === provider) recentTimelines.delete(threadId);
    if (state.historyView && identityProvider(state.historyView.threadId) === provider) state.historyView = null;
    for (const threadId of activeChecks.keys()) if (identityProvider(threadId) === provider) activeChecks.delete(threadId);
    for (const threadId of state.nativeQueues.keys()) if (identityProvider(threadId) === provider) state.nativeQueues.delete(threadId);
    const agent = agentMetadata(provider); if (agent) agent.connected = false;
    for (const map of [state.active, state.resuming]) for (const threadId of map.keys()) if (identityProvider(threadId) === provider) map.delete(threadId);
    for (const threadId of state.owned) if (identityProvider(threadId) === provider) state.owned.delete(threadId);
    for (const threadId of compacting.keys()) if (identityProvider(threadId) === provider) compacting.delete(threadId);
    for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (threadProvider(thread) === provider) thread.status = { type: 'notLoaded' };
    for (const [key, request] of state.requests) if (request.provider === provider || identityProvider(request.params.threadId) === provider) state.requests.delete(key);
    for (const queue of state.queues.values()) if (queue.machine === accessKey() && threadProvider(queue.thread) === provider) pauseQueue(queue, 'provider-closed').catch(showError);
    if (selectedProvider() === provider) {
      if (state.loading) state.historyLoadFailed = true;
      state.selection++; state.loading = false; state.historyEvents = null;
      if (!params.reconfigured) {
        showError(`${agentName(provider)} disconnected: ${params.message || 'Connection closed'}`);
        state.providerError = $('error-text').textContent;
      }
    }
    syncComposerAgent(); renderRequests(); updateBusy(); return;
  }
  if (method === 'connection/closed') {
    activeChecks.clear();
    recentTimelines.clear();
    state.historyView = null;
    clearQueueDrag(false);
    clearThreadDrag();
    clearProjectDrag(); $('project-menu').hidden = true;
    pauseQueues('connection-closed');
    state.nativeQueues.clear();
    state.connected = false; state.owned.clear(); state.resuming.clear(); state.active.clear(); state.requests.clear(); compacting.clear();
    resetThreadListRequests(true);
    if (state.loading) state.historyLoadFailed = true;
    state.selection++; state.loading = false; state.historyEvents = null;
    $('folder-dialog').close();
    status('Disconnected'); renderRequests(); showError(params.message);
    return;
  }
  if (id !== undefined) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (supported.includes(method)) {
      activeChecks.delete(params.threadId);
      const fresh = !state.requests.has(id);
      state.requests.set(id, message); renderRequests();
      if (fresh && state.connected) playCompletionSound();
    }
    else { api.respond(id, {}).catch(showError); showError(`${agentName()} requested an unsupported interaction: ${method}`); }
    return;
  }
  if (method === 'thread/name/updated') { applyName(params.threadId, params.threadName || params.name); return; }
  if (method === 'project/changed') { refreshProjects().catch(showError); return; }
  if (method === 'thread/project/updated') { applyProject(params.threadId, params.projectId); loadThreads().catch(showError); return; }
  if (method === 'serverRequest/resolved') { state.requests.delete(params.requestId); renderRequests(); return; }
  if (method === 'thread/status/changed') {
    if (params.status?.type === 'active') activeChecks.delete(params.threadId);
    if (params.status?.type !== 'active') finishCompaction(params.threadId);
    setThreadRuntimeStatus(params.threadId, params.status); updateBusy();
    if (params.status?.type === 'idle') reconcileActiveTurn(params.threadId).catch(error => trace('turn.reconcile.failed', { threadId: params.threadId, error: error.message }));
    return;
  }
  if (method === 'turn/started' && !state.finished.has(params.turn.id)) {
    activeChecks.delete(params.threadId);
    if (compacting.get(params.threadId)?.turnId !== params.turn.id) finishCompaction(params.threadId);
    state.owned.add(params.threadId); state.writerConflicts.delete(queueKey(params.threadId));
    setCompletion(params.threadId);
    setThreadRuntimeStatus(params.threadId, { type: 'active' });
    state.active.set(params.threadId, params.turn.id); updateBusy();
  }
  if (method === 'turn/completed') {
    activeChecks.delete(params.threadId);
    observedTurns.set(queueKey(params.threadId), params.turn.id);
    finishCompaction(params.threadId, params.turn.id);
    const activeTurn = state.active.get(params.threadId);
    if (!state.finished.has(params.turn.id) && (!activeTurn || activeTurn === params.turn.id)) {
      setThreadRuntimeStatus(params.threadId, { type: 'idle' });
      if (['completed', 'failed', 'interrupted'].includes(params.turn.status)) {
        if (isViewingLatest(params.threadId)) { setCompletion(params.threadId); setUnread(params.threadId, false); }
        else setCompletion(params.threadId, params.turn.status);
      }
      const queue = state.queues.get(queueKey(params.threadId));
      if (state.connected && params.turn.status === 'completed') {
        const retry = pendingQueueRetry(queue);
        if (retry) retry.completedTurns?.add(params.turn.id);
        else if (!queue?.messages.length || queue.paused) playCompletionSound();
      }
      if (queue && ['failed', 'interrupted'].includes(params.turn.status) && (!reconciledRetry || queue.retry !== reconciledRetry)) pauseQueue(queue, 'turn-' + params.turn.status).catch(showError);
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
    if (!params.willRetry) { finishCompaction(params.threadId, params.turnId); updateBusy(); }
    const queue = state.queues.get(queueKey(params.threadId));
    const currentTurn = !params.turnId || !state.active.has(params.threadId) || state.active.get(params.threadId) === params.turnId;
    if (queue && !params.willRetry && currentTurn) { pauseQueue(queue, 'native-error').catch(showError); renderQueue(); }
    showError(params.error?.message || params.message || `${agentName()} reported an error.`);
    if (params.willRetry && params.threadId && params.turnId) state.retryError = { threadId: params.threadId, turnId: params.turnId };
  }
  if (!state.thread || params.threadId !== state.thread.id) return;
  if (state.historyEvents && (method.startsWith('item/') || method === 'turn/completed' || method === 'turn/started')) { state.historyEvents.push(message); return; }
  if (state.historyView?.threadId === state.thread.id && (method.startsWith('item/') || method === 'turn/completed' || method === 'turn/started')) {
    const turnId = params.turnId || params.turn?.id || state.items.get(params.itemId)?.turnId;
    if (turnId) {
      if (!state.historyView.turns.has(turnId)) state.historyView.turns.set(turnId, null);
      state.historyView.dirtyTurns.add(turnId);
    }
  }
  if (method === 'item/started' || method === 'item/completed') {
    if (params.item.type === 'userMessage') {
      for (const [key, record] of state.items) if (key.startsWith('pending-')) { record.element.remove(); state.items.delete(key); }
    }
    renderItem({ ...params.item, startedAtMs: params.item.startedAtMs ?? params.startedAtMs, completedAtMs: params.item.completedAtMs ?? params.completedAtMs }, false, params.turnId);
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
    const name = agentName(request.provider || identityProvider(request.params.threadId));
    heading.textContent = request.method.includes('requestUserInput') ? `${name} has a question` : `${name} needs your approval`;
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
  updateBusy();
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
    $('use-folder').textContent = folderActionLabel(path);
    $('use-folder').disabled = false;
  } catch (error) {
    if (generation !== state.folderGeneration) return;
    $('folder-status').textContent = '';
    $('folder-error').textContent = error.message;
  }
}
function folderActionLabel(path) {
  if (state.folderPurpose === 'project') return 'Add this folder as a project →';
  if (state.thread?.cwd && !state.thread.projectId && path && normalizedFolder(state.thread.cwd) === normalizedFolder(path) && supports('thread/metadata/update') && (supports('project/create') || projectAtPath(path))) return 'Group this conversation here →';
  return state.thread ? 'Start a new conversation in this folder →' : 'Use this folder →';
}
async function openProjectPicker(purpose = 'conversation') {
  if (!state.connected || state.sending) return;
  state.folderPurpose = purpose === 'project' || purpose === 'sync-project' ? purpose : 'conversation';
  $('folder-host').textContent = $('server-host').textContent;
  $('use-folder').textContent = folderActionLabel(state.thread?.cwd || $('workspace').value);
  $('folder-dialog').showModal();
  await browseFolders(state.thread?.cwd || $('workspace').value || '/');
}
async function chooseSharedProjectFolder(project) {
  state.syncProject = { project, options: state.options };
  await openProjectPicker('sync-project');
  $('use-folder').textContent = `Use folder for ${project.name}`;
}
$('browse-workspace').onclick = openProjectPicker;
$('choose-project').onclick = openProjectPicker;
$('close-folders').onclick = () => $('folder-dialog').close();
$('folder-dialog').onclose = () => { state.folderGeneration++; state.folderPath = null; };
$('folder-form').onsubmit = event => { event.preventDefault(); browseFolders($('folder-location').value); };
$('folder-location').oninput = () => { state.folderGeneration++; state.folderPath = null; $('use-folder').disabled = true; };
$('parent-folder').onclick = () => browseFolders(($('folder-location').value.replace(/\/+$/, '').replace(/\/[^/]*$/, '')) || '/');
$('use-folder').onclick = async () => {
  if (!state.folderPath || !state.connected || $('use-folder').disabled) return;
  if (state.folderPurpose === 'sync-project') {
    const target = state.syncProject, options = state.options, root = state.folderPath;
    if (!target || target.options !== options) return;
    $('use-folder').disabled = true;
    try {
      const project = await api.mapSyncProject(target.project.sharedId, root);
      if (options !== state.options) return;
      $('folder-dialog').close();
      await refreshProjects();
      startProject(project); await refreshConversationSync();
    } catch (error) { $('folder-error').textContent = error.message; }
    finally { $('use-folder').disabled = !state.folderPath || !state.connected; }
    return;
  }
  if (state.folderPurpose === 'project') {
    state.projectDraft = { path: state.folderPath, options: state.options, idempotencyKey: crypto.randomUUID() };
    $('save-project').disabled = false;
    $('project-title').textContent = $('save-project').textContent = 'Add project';
    $('project-path').value = state.folderPath;
    $('project-name').value = state.folderPath.replace(/\/+$/, '').split('/').pop() || 'Project';
    $('project-error').textContent = ''; $('folder-dialog').close(); $('project-dialog').showModal(); $('project-name').select();
    return;
  }
  const path = state.folderPath, options = state.options, provider = selectedProvider(), generation = state.folderGeneration, selection = state.selection;
  const operation = {}; state.folderSelecting = operation;
  const current = () => state.folderSelecting === operation && state.options === options && state.connected && state.folderGeneration === generation && state.folderPath === path && state.selection === selection && selectedProvider() === provider;
  $('use-folder').disabled = true; $('folder-error').textContent = '';
  try {
    let project = projectAtPath(path, provider);
    if (!project && supports('project/create', provider)) {
      let draft = state.folderProject;
      if (!draft || draft.options !== options || draft.path !== normalizedFolder(path) || draft.provider !== provider) draft = state.folderProject = { options, path: normalizedFolder(path), provider, idempotencyKey: crypto.randomUUID() };
      $('folder-status').textContent = 'Adding project…';
      project = draft.project || (await rpc('project/create', { provider, name: (normalizedFolder(path).split('/').pop() || 'Project').slice(0, 120), roots: [{ path }], idempotencyKey: draft.idempotencyKey })).project;
      draft.project = project;
    }
    if (!current()) return;
    if (project) {
      if (!projects.data.some(entry => entry.id === project.id)) projects.data.push(project);
      projects.collapsed.delete(project.id);
      if (state.thread?.cwd && !state.thread.projectId && normalizedFolder(state.thread.cwd) === normalizedFolder(path) && supports('thread/metadata/update', provider)) {
        await moveThreadToProject(state.thread, project.id, options);
        if (!current()) return;
        $('folder-dialog').close(); $('prompt').focus(); return;
      }
    }
    projects.selected = project?.id || null;
    $('workspace').value = path;
    $('thread-path').textContent = path;
    if (state.thread) resetThread();
    else changeDraftWorkspace();
    renderThreads();
    $('folder-dialog').close(); $('prompt').focus();
  } catch (error) {
    if (current()) { $('folder-status').textContent = ''; $('folder-error').textContent = error.message; }
  } finally {
    if (state.folderSelecting === operation) { state.folderSelecting = null; $('use-folder').disabled = !state.folderPath || !state.connected; }
  }
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
  $('rename-project').disabled = !state.connected || project.needsFolder;
  $('move-project-up').disabled = project.needsFolder || !state.connected || projectDrag.pending === state.options || index <= 0;
  $('move-project-down').disabled = project.needsFolder || !state.connected || projectDrag.pending === state.options || index < 0 || index === projects.data.length - 1;
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
  $('project-view-path').textContent = target.project.needsFolder ? 'Choose this project’s folder on this computer.' : target.project.roots.map(root => root.path).join('\n');
  $('map-project-folder').hidden = !target.project.sharedId;
  $('startup-project').checked = preferences.startupProjects[accessKey()] === target.project.id;
  $('startup-project').disabled = Boolean(target.project.needsFolder); $('project-view-error').textContent = '';
  $('project-view-dialog').showModal();
};
$('close-project-view').onclick = () => $('project-view-dialog').close();
$('map-project-folder').onclick = () => {
  const target = state.projectView;
  if (target?.options !== state.options) return;
  $('project-view-dialog').close(); chooseSharedProjectFolder(target.project).catch(showError);
};
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
  if (beforeProjectId && identityProvider(beforeProjectId) !== identityProvider(projectId)) throw new Error('Projects can only be reordered within their agent.');
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
  if (pendingThreadSearch?.generation === state.listGeneration) pendingThreadSearch.needsRefresh = true;
  pendingPinReads.delete(threadId);
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.projectId = projectId;
  if (state.thread?.id === threadId) projects.selected = projectId;
  renderThreads();
}
function clearThreadDrag() {
  const source = threadDrag.source;
  if (!source) return;
  threadDrag.source = null;
  source.button.classList.remove('dragging');
  setThreadDropMarker();
  for (const group of source.searchGroups) group.hidden = true;
  if (threadDrag.renderPending) queueMicrotask(() => { if (threadDrag.renderPending) renderThreads(); });
}
function setThreadDropMarker(element, className) {
  const previous = threadDrag.marker;
  if (previous?.element === element && previous?.className === className) return;
  if (previous) previous.element.classList.remove(previous.className);
  threadDrag.marker = element ? { element, className } : null;
  if (element) element.classList.add(className);
}
function clearThreadDropMarkerOnLeave(event, element) {
  if (threadDrag.marker?.element === element && (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget))) setThreadDropMarker();
}
function currentDraggedThread(threadId, projectId) {
  const current = state.threads.find(thread => thread.id === threadId) || state.pinnedThreads.get(threadId);
  return current && (current.projectId || null) === projectId && state.archiving?.threadId !== threadId ? current : null;
}
function sortProjectThreads(threads, projectId) {
  const ids = preferences.threadOrders[accessKey()]?.[projectId] || [];
  const rank = new Map(ids.map((id, index) => [id, index]));
  const cutoff = preferences.threadOrderCutoffs[accessKey()]?.[projectId] ?? Infinity;
  const position = thread => rank.get(thread.id) ?? (Number.isFinite(thread.createdAt) && thread.createdAt >= cutoff ? -1 : Number.MAX_SAFE_INTEGER);
  return threads.sort((a, b) => Number(state.pinnedIds.has(b.id)) - Number(state.pinnedIds.has(a.id)) || position(a) - position(b));
}
function bindThreadOrder(row, thread) {
  const projectId = thread.projectId;
  const valid = event => {
    const source = threadDrag.source;
    return state.connected && source && source.options === state.options && source.threadId !== thread.id && source.projectId === projectId && state.pinnedIds.has(source.threadId) === state.pinnedIds.has(thread.id) && !threadDrag.orderPending.has(JSON.stringify([accessKey(), projectId])) && !state.pinning.has(source.threadId) && !state.pinning.has(thread.id) && state.archiving?.threadId !== thread.id && event.dataTransfer?.types.includes(threadDrag.type);
  };
  const after = event => {
    const rect = row.getBoundingClientRect();
    return event.clientY >= rect.top + rect.height / 2;
  };
  row.ondragover = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    setThreadDropMarker(row, after(event) ? 'drop-after' : 'drop-before');
  };
  row.ondragleave = event => clearThreadDropMarkerOnLeave(event, row);
  row.ondrop = async event => {
    if (!valid(event) || event.dataTransfer.getData(threadDrag.type) !== threadDrag.source.token) return;
    event.preventDefault(); event.stopPropagation();
    const source = threadDrag.source;
    const from = currentDraggedThread(source.threadId, source.projectId), to = currentDraggedThread(thread.id, projectId);
    const below = after(event); clearThreadDrag();
    if (!from || !to) return;
    try { await reorderThread(from, to, below, source.options); } catch (error) { if (source.options === state.options) showError(error); }
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
  const valid = event => state.connected && threadDrag.source && threadDrag.source.options === state.options && event.dataTransfer?.types.includes(threadDrag.type) && threadDrag.source.projectId !== projectId && (!projectId || projects.data.some(project => project.id === projectId));
  target.ondragover = event => {
    if (!valid(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    setThreadDropMarker(target, 'drop-target');
  };
  target.ondragleave = event => clearThreadDropMarkerOnLeave(event, target);
  target.ondrop = async event => {
    if (!valid(event) || event.dataTransfer.getData(threadDrag.type) !== threadDrag.source.token) return;
    event.preventDefault(); event.stopPropagation();
    const source = threadDrag.source;
    const thread = currentDraggedThread(source.threadId, source.projectId);
    clearThreadDrag();
    if (!thread) return;
    try { await moveThreadToProject(thread, projectId, source.options); } catch (error) { showError(error); }
  };
}
async function moveThreadToProject(thread, projectId, options = state.options) {
  if (projectId && identityProvider(projectId) !== threadProvider(thread)) throw new Error('Choose a project belonging to this chat’s agent.');
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
async function fillScheduleSharing() {
  if (!api.scheduleSharing) return;
  const generation = schedules.settingsGeneration = (schedules.settingsGeneration || 0) + 1;
  const value = await api.scheduleSharing();
  if (schedules.settingsGeneration !== generation) return;
  $('share-schedules').checked = value.enabled;
  $('schedule-host').value = value.host; $('schedule-port').value = value.port; $('schedule-key').value = value.key;
  $('schedule-folder').value = value.folder || '~/.local/share/remote-codex/schedule-sync';
  $('sync-schedules').disabled = !value.enabled;
  $('schedule-sync-status').textContent = !value.enabled ? 'Sharing off' : value.error ? `Waiting to sync · ${value.error}` : value.connected ? `Connected · ${value.host}` : 'Connecting to schedule storage…';
  $('schedule-resolved-folder').hidden = true;
  $('schedule-folder-size').textContent = value.enabled ? 'Checking…' : '—';
  if (!value.enabled || !api.scheduleStorage) return;
  try {
    const info = await api.scheduleStorage();
    if (schedules.settingsGeneration !== generation) return;
    $('schedule-folder-size').textContent = (info.complete ? '' : 'At least ') + formatStorageSize(info.bytes);
    $('schedule-resolved-folder').textContent = info.directory; $('schedule-resolved-folder').hidden = false;
  } catch (error) { if (schedules.settingsGeneration === generation) $('schedule-folder-size').textContent = `Unavailable · ${error.message}`; }
}
function formatStorageSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid folder size reported by server.');
  const unit = Math.min(4, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
function openSettings() { fillSettings(state.options); $('settings-error').textContent = ''; fillScheduleSharing().catch(showError); $('settings-dialog').showModal(); }
$('schedule-sharing-form').onsubmit = async event => {
  event.preventDefault();
  $('save-schedule-sharing').disabled = true;
  try {
    await api.saveScheduleSharing({ enabled: $('share-schedules').checked, host: $('schedule-host').value, port: Number($('schedule-port').value), key: $('schedule-key').value, folder: $('schedule-folder').value });
    await fillScheduleSharing(); await refreshSchedules();
  } catch (error) { $('schedule-sync-status').textContent = error.message; }
  finally { $('save-schedule-sharing').disabled = false; }
};
$('sync-schedules').onclick = async () => {
  $('sync-schedules').disabled = true;
  try { await api.syncSchedules(); await fillScheduleSharing(); await refreshSchedules(); }
  catch (error) { $('schedule-sync-status').textContent = error.message; }
  finally { $('sync-schedules').disabled = !$('share-schedules').checked; }
};
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
async function dismissMessageEdit() {
  const target = state.messageEdit;
  if (!target || state.resending) return;
  if (!target.uncertain) clearDraft(target.draftTarget);
  closeMessageEdit({ focus: true }); updateBusy();
  if (target?.uncertain && target.options === state.options && state.thread?.id === target.thread.id && state.connected) {
    try {
      await openThread(target.thread);
      if (target.options === state.options && state.thread?.id === target.thread.id && !state.items.has(target.itemId) && api.editDrafts) {
        showError('Your edit draft is saved. Right-click the conversation and choose Recover edit drafts.');
      }
    }
    catch (error) { showError(error); }
  }
}
$('recover-edit-drafts').onclick = async () => {
  const thread = state.contextThread, options = state.options;
  $('thread-menu').hidden = true;
  if (!thread || !api.editDrafts) return;
  try {
    const saved = await api.editDrafts(thread.id);
    if (options !== state.options || thread !== state.contextThread) return;
    const picker = $('edit-drafts-picker'), input = $('edit-drafts-text'), copy = $('copy-edit-draft'), status = $('edit-drafts-status');
    picker.replaceChildren(...saved.map((draft, index) => new Option(new Date(draft.updatedAt).toLocaleString(), index)));
    picker.hidden = saved.length < 2;
    input.hidden = copy.hidden = !saved.length;
    picker.onchange = () => {
      input.value = saved[Number(picker.value)]?.text ?? '';
      copy.disabled = !input.value;
      status.textContent = !saved.length ? 'No saved edit drafts.' : input.value ? '' : 'This draft has no text.';
    };
    picker.onchange();
    if (!$('edit-drafts-dialog').open) $('edit-drafts-dialog').showModal();
  } catch (error) { showError(error); }
};
$('close-edit-drafts').onclick = () => $('edit-drafts-dialog').close();
$('copy-edit-draft').onclick = async () => {
  try {
    await api.copyText($('edit-drafts-text').value);
    $('edit-drafts-status').textContent = 'Copied';
  } catch { $('edit-drafts-status').textContent = 'Could not copy the draft.'; }
};
$('cancel-message-edit').onclick = dismissMessageEdit;
$('edited-message').oninput = saveMessageEdit;
$('edit-message-form').onkeydown = event => {
  if (event.key !== 'Escape' || event.isComposing || state.resending) return;
  event.preventDefault(); event.stopPropagation();
  void dismissMessageEdit();
};
$('edit-message-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.messageEdit; const text = $('edited-message').value.trim();
  if (!target || target.uncertain || !text && !target.attachmentCount) return;
  saveEditorDraft(target.draftTarget, $('edited-message').value);
  renderMessageDraftStatus(target.draftTarget);
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
function accessKey() {
  if (state.options?.machine) return state.options.machine;
  if (state.options?.provider && state.options.provider !== 'codex') throw new Error('Missing agent connection identity.');
  return 'access:' + (isLocal() ? 'local' : `${state.options?.host || ''}:${state.options?.port || 22}`);
}
function restoreAccess() {
  const saved = localStorage.getItem(accessKey());
  $('permissions').value = ['read-only', 'workspace-write', 'danger-full-access'].includes(saved) ? saved : 'workspace-write';
}
$('prompt').oninput = () => {
  const text = $('prompt').value;
  slash.dismissed = null; slash.index = 0; slash.skillOnly = false;
  scheduleComposerDraft();
  cacheDraftIndicator(drafts.target, Boolean(text.trim() || state.images.length));
  if (($('send').type === 'button') !== canStopTurn()) updateSendButton();
  if (text.startsWith('/') || !$('slash-menu').hidden) updateSlash();
};
$('prompt').addEventListener('blur', () => saveComposerDraft());
$('prompt').onkeydown = promptKeydown;
$('plan-mode').onclick = () => { modes.plan = false; if (state.thread) modes.threads.set(state.thread.id, false); updateBusy(); };
$('model').onchange = () => { syncComposerAgent(); updateEfforts(); usage.threads.delete(state.thread?.id); updateBusy(); };
$('workspace').oninput = () => { $('thread-path').textContent = $('workspace').value; projects.selected = projectAtPath($('workspace').value.trim())?.id || null; changeDraftWorkspace(); };
$('composer').addEventListener('change', () => saveComposerDraft());
addEventListener('beforeunload', () => {
  saveComposerDraft();
  if ($('edit-queue-dialog').open) saveEditorDraft(state.queueEdit?.draftTarget, $('queued-text').value);
  saveMessageEdit();
  if ($('edit-schedule-dialog').open) saveScheduledDraft();
});
$('refresh').onclick = () => refreshProjects().catch(showError);
$('more-threads').onclick = async () => {
  $('more-threads').disabled = true;
  try { await loadThreads(true); } catch (error) { showError(error); } finally { $('more-threads').disabled = false; }
};
$('search').oninput = () => {
  clearTimeout(searchTimer);
  clearThreadDrag();
  if (!state.connected) { renderThreads(); return; }
  state.listGeneration++;
  $('search-progress').hidden = false;
  const search = () => loadThreads().catch(showError);
  if ($('search').value.trim()) searchTimer = setTimeout(search, 250);
  else search();
};
$('send').onclick = event => { if (canStopTurn()) { event.preventDefault(); return stopTurn(); } };
function loadOlderTurns() {
  if (!state.thread || !state.turnCursor || state.loading) return Promise.resolve();
  const selection = state.selection;
  if (state.olderHistory?.selection === selection) return state.olderHistory.promise;
  const operation = { selection }; state.olderHistory = operation;
  $('older-turns').disabled = true;
  operation.promise = (async () => { try {
    const result = await rpc('thread/turns/list', { threadId: state.thread.id, cursor: state.turnCursor, limit: olderTurnLimit, sortDirection: 'desc', itemsView: 'full' });
    if (selection !== state.selection) return;
    const height = $('timeline').scrollHeight, top = $('timeline').scrollTop;
    const anchor = timelineView.reading || pinnedMessages.context?.querySelector('.message');
    const anchorTop = anchor?.isConnected && anchor.checkVisibility() ? anchor.getBoundingClientRect().top : null;
    for (const turn of result.data) for (const item of [...(turn.items || [])].reverse()) renderItem(item, true, turn.id, $('messages'), true);
    if (state.historyView?.threadId === state.thread.id) {
      const turns = new Map([...result.data].reverse().map(turn => [turn.id, turn]));
      for (const [id, turn] of state.historyView.turns) turns.set(id, turn ? mergeHistoryTurn(turns.get(id), turn) : turns.get(id) || turn);
      state.historyView.turns = turns;
    }
    state.turnCursor = result.nextCursor;
    $('older-turns').hidden = !result.nextCursor;
    if (anchorTop !== null && anchor.isConnected && anchor.checkVisibility()) $('timeline').scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else $('timeline').scrollTop = top + $('timeline').scrollHeight - height;
  } finally { if (state.olderHistory === operation) { state.olderHistory = null; $('older-turns').disabled = false; updateBusy(); } } })();
  return operation.promise;
}
$('older-turns').onclick = () => loadOlderTurns().catch(showError);
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }; });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); if (!state.connecting && !state.sending && !state.commandBusy) resetThread(); } });
document.addEventListener('keydown', unreadShortcut);
$('threads').addEventListener('keydown', conversationArrow);
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  const editor = event.target?.closest?.('dialog[open] textarea, #edit-message-form textarea');
  if (!editor?.form || editor.disabled || editor.readOnly) return;
  event.preventDefault();
  if (event.repeat) return;
  const submit = editor.form.querySelector('button[type="submit"],input[type="submit"]');
  if (submit && !submit.matches(':disabled') && !submit.hidden) editor.form.requestSubmit(submit);
});
globalThis.addEventListener('focus', acknowledgeVisibleThread);
globalThis.addEventListener('focus', () => { if (usage.timer && state.connected && Date.now() - usage.updatedAt > 60000) refreshUsage(); });
globalThis.addEventListener('focus', () => {
  if (usage.timer) refreshSchedules().catch(showError);
  if (usage.timer && state.connected && !isLocal() && state.options?.sharedServer && !state.connecting && !state.loading && !state.sending && !state.commandBusy) refreshProjects().catch(showError);
});
document.addEventListener('visibilitychange', acknowledgeVisibleThread);
for (const event of ['online', 'offline']) globalThis.addEventListener(event, () => trace('network.' + event, { connected: state.connected }));
document.addEventListener('close', acknowledgeVisibleThread, true);
$('timeline').addEventListener('scroll', acknowledgeVisibleThread);
$('timeline').addEventListener('pointerdown', acknowledgeVisibleThread);
$('timeline').addEventListener('wheel', acknowledgeVisibleThread, { passive: true });
$('timeline').addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) acknowledgeVisibleThread(event); });
function readTimelineDiff(event) {
  const entry = event.target.closest?.('.changed-file-entry[open]');
  if (entry) setTimelineFollowing(false, entry);
  else if (timelineView.reading) setTimelineFollowing(false);
}
$('timeline').addEventListener('pointerdown', readTimelineDiff);
$('timeline').addEventListener('focusin', readTimelineDiff);
$('timeline').addEventListener('wheel', event => {
  readTimelineDiff(event);
  if (event.deltaY < 0 && !timelineView.reading) setTimelineFollowing(false);
}, { passive: true });
$('timeline').addEventListener('scroll', () => {
  if (timelineView.reading || state.loading && !state.historyView) return;
  setTimelineFollowing(timelineAtBottom());
});
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
document.addEventListener('keydown', event => { if (event.key === 'Escape') { hideSyncTooltip(); $('thread-menu').hidden = true; $('project-menu').hidden = true; clearProjectDrag(); } });
async function init() {
  if (!api) { showError('Open Remote Codex as a desktop app to connect to Codex.'); return; }
  api.onNotification(handleNotification);
  Object.assign(preferences, await api.preferences()); applyTheme(preferences.theme);
  renderShortcuts(); renderShortcutSaveStatus(preferences.shortcutMoveQueued);
  await restoreQueues();
  await refreshSchedules();
  const options = await api.settings();
  agents.available = await api.providers();
  fillSettings(options);
  if (options.settingsError) {
    state.options = options; connectionLabels(); status('Not connected');
    $('settings-error').textContent = options.settingsError;
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
    showError(options.settingsError);
  } else await connect(options);
  usage.timer = setInterval(() => { if (state.connected && !document.hidden) refreshUsage(); }, 60000);
}
init().catch(showError);

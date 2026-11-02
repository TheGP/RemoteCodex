/* global marked, DOMPurify */
const controls = new Map([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
const $ = id => controls.get(id);
const api = window.codex;
const projects = { data: [], selected: null, focused: null, cursors: new Map(), collapsed: new Set(), generation: 0 };
const preferences = { theme: 'system', startupProjects: {} };
const threadDrag = { source: null, pending: new Set(), type: 'application/x-remote-codex-thread' };
const projectDrag = { source: null, pending: null, type: 'application/x-remote-codex-project' };
const state = { owned: new Set(), resuming: new Map(), writerConflicts: new Set(), completions: new Map(), unread: new Set(), queues: new Map(), dispatching: new Set(), finished: new Set(), names: new Map(), titling: new Set(), titleTask: Promise.resolve(), titleFailed: false, images: [], connected: false, connecting: false, threads: [], pinnedIds: new Set(), pinnedThreads: new Map(), pinning: new Set(), thread: null, threadCursor: null, turnCursor: null, active: new Map(), items: new Map(), requests: new Map(), requestCards: new Map(), models: [], loading: false, sending: false, selection: 0, historyEvents: null, listGeneration: 0, folderPath: null, folderGeneration: 0 };
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
const titleOf = thread => state.names.get(thread.id) || thread.name || thread.preview?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'New conversation';
const isLocal = () => state.options?.mode === 'local';
const connectedStatus = () => isLocal() ? 'Connected locally' : 'Connected via SSH';

function applyTheme(value) {
  const theme = [...$('theme-select').options].some(option => option.value === value) ? value : 'system';
  document.documentElement.dataset.theme = theme; $('theme-select').value = theme;
}
async function savePreferences(patch) {
  Object.assign(preferences, await api.savePreferences(patch));
}
$('theme-select').onchange = async () => {
  const theme = $('theme-select').value; const previous = document.documentElement.dataset.theme || 'system';
  applyTheme(theme);
  try { await savePreferences({ theme }); }
  catch (error) { if (document.documentElement.dataset.theme === theme) applyTheme(previous); showError(error); }
};

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
}

function fillSettings(options) {
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
  $('connect').textContent = state.connecting ? 'Connecting…' : state.connected ? 'Reconnect' : 'Connect';
  $('connect').disabled = state.connecting;
  $('save-connect').disabled = state.connecting;
  updateBusy();
}
function updateBusy() {
  const busy = state.owned.has(state.thread?.id) && Boolean(state.active.get(state.thread?.id));
  $('writer-notice').hidden = !state.writerConflicts.has(queueKey(state.thread?.id));
  $('activity').hidden = !$('writer-notice').hidden && !busy && !state.sending && !state.loading;
  $('retry-writer').disabled = state.sending || state.loading || !state.connected;
  $('stop').hidden = !busy;
  $('send').hidden = false;
  $('send').textContent = busy ? 'Queue' : '↑';
  $('send').classList.toggle('queue-send', busy);
  $('send').title = busy ? 'Send after the current turn finishes' : 'Send message';
  $('send').setAttribute('aria-label', busy ? 'Queue message' : 'Send message');
  $('send').disabled = !state.connected || state.connecting || state.sending || state.commandBusy || state.loading || state.images.some(image => !image.url);
  $('attach-images').disabled = state.sending || state.loading;
  $('prompt').disabled = state.loading;
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
  $('add-project').disabled = !state.connected || state.sending || state.loading || Boolean(state.commandBusy);
  renderQueue();
  renderThreadIndicators();
  const turns = new Set();
  for (const button of $('messages').querySelectorAll('.edit-message')) {
    const turnId = button.dataset.turnId;
    button.hidden = turns.has(turnId); turns.add(turnId);
    button.disabled = !state.connected || state.sending || state.commandBusy || state.loading;
  }
}
function scrollToBottom(force = false) {
  const el = $('timeline');
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 180) el.scrollTop = el.scrollHeight;
}
function renderThreads() {
  const fragment = document.createDocumentFragment();
  const search = $('search').value.trim().toLowerCase();
  const focused = projects.data.find(project => project.id === projects.focused);
  $('project-focus-bar').hidden = !focused;
  const projectIds = new Set(projects.data.map(project => project.id));
  const available = [...new Map([...state.pinnedThreads.values(), ...state.threads].map(thread => [thread.id, thread])).values()];
  const pinned = focused ? [] : [...state.pinnedIds].map(id => state.pinnedThreads.get(id) || { id, preview: 'Unavailable conversation' }).filter(thread => !projectIds.has(thread.projectId) && (!search || titleOf(thread).toLowerCase().includes(search)));
  const recent = focused ? [] : state.threads.filter(thread => !state.pinnedIds.has(thread.id) && !projectIds.has(thread.projectId));
  const heading = (text, target = fragment) => {
    const label = document.createElement('div'); label.className = 'list-heading thread-group'; label.textContent = text; target.append(label);
  };
  const row = (thread, target = fragment) => {
    const container = document.createElement('div'); container.className = 'thread-row';
    const button = document.createElement('button');
    button.className = 'thread' + (state.thread?.id === thread.id ? ' selected' : '');
    button.dataset.threadId = thread.id;
    button.setAttribute('aria-current', state.thread?.id === thread.id ? 'true' : 'false');
    const name = document.createElement('strong');
    name.textContent = titleOf(thread);
    button.append(name);
    button.oncontextmenu = event => { event.preventDefault(); showThreadMenu(thread, event.clientX, event.clientY); };
    button.title = titleOf(thread);
    button.onclick = () => openThread(thread).catch(showError);
    button.draggable = state.connected;
    button.ondragstart = event => {
      if (!state.connected || threadDrag.pending.has(queueKey(thread.id)) || !event.dataTransfer) { event.preventDefault(); return; }
      clearThreadDrag();
      clearProjectDrag();
      threadDrag.source = { thread, options: state.options, token: crypto.randomUUID() };
      event.dataTransfer.setData(threadDrag.type, threadDrag.source.token);
      event.dataTransfer.setData('text/plain', titleOf(thread)); event.dataTransfer.effectAllowed = 'move';
      button.classList.add('dragging'); $('thread-menu').hidden = true;
      for (const group of $('threads').querySelectorAll('[data-search-hidden]')) group.hidden = false;
    };
    button.ondragend = clearThreadDrag;
    const pin = document.createElement('button');
    const isPinned = state.pinnedIds.has(thread.id);
    pin.className = 'pin-thread' + (isPinned ? ' pinned' : '');
    pin.title = isPinned ? 'Unpin conversation' : 'Pin conversation';
    pin.setAttribute('aria-label', `${pin.title}: ${titleOf(thread)}`);
    pin.setAttribute('aria-pressed', String(isPinned));
    pin.disabled = !state.connected || state.pinning.has(thread.id);
    pin.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 9V3H8v6l-3 3v2h14v-2l-3-3M12 14v7"/></svg>';
    pin.onclick = () => togglePin(thread).catch(showError);
    container.append(button, pin);
    target.append(container);
  };
  if (pinned.length) { heading('PINNED'); pinned.forEach(thread => row(thread)); }
  let hasProjectGroups = false;
  for (const project of projects.data) {
    if (focused && project.id !== focused.id) continue;
    const members = available.filter(thread => thread.projectId === project.id && (!search || titleOf(thread).toLowerCase().includes(search)));
    members.sort((a, b) => Number(state.pinnedIds.has(b.id)) - Number(state.pinnedIds.has(a.id)));
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
  if (!focused && projects.data.length) {
    const other = document.createElement('section'); other.className = 'other-conversations'; other.setAttribute('aria-label', 'Other conversations');
    bindThreadDrop(other, null); heading('OTHER CONVERSATIONS', other); recent.forEach(thread => row(thread, other));
    if (!recent.length && !pinned.length && !search) { const hint = document.createElement('p'); hint.className = 'project-empty'; hint.textContent = 'Drop conversations here'; other.append(hint); }
    fragment.append(other);
  } else if (!focused) {
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
  $('more-threads').hidden = Boolean(focused) || !state.threadCursor;
  renderThreadIndicators();
  for (const thread of available) if (!focused || thread.projectId === focused.id) requestTitle(thread);
}

async function loadProjects() {
  const generation = ++projects.generation; const options = state.options;
  const data = []; let cursor = null;
  do { const page = await rpc('project/list', { limit: 100, cursor, sortKey: 'position', sortDirection: 'asc' }); data.push(...page.data); cursor = page.nextCursor; } while (cursor && state.options === options && generation === projects.generation);
  if (state.options !== options || generation !== projects.generation) return false;
  projects.data = data;
  if (!data.some(project => project.id === projects.selected)) projects.selected = null;
  if (!data.some(project => project.id === projects.focused)) projects.focused = null;
  return true;
}
async function refreshProjects() { if (state.connected && await loadProjects()) await loadThreads(); }
async function focusProject(project, load = true) {
  if (!state.connected || state.sending || state.commandBusy || state.loading || !projects.data.some(entry => entry.id === project.id) || !project.roots[0]?.path) return;
  projects.focused = project.id; projects.selected = project.id;
  projects.collapsed.delete(project.id); $('search').value = ''; $('workspace').value = project.roots[0].path;
  if (state.thread?.projectId !== project.id) resetThread(); else renderThreads();
  if (load) await loadThreads();
}
async function restoreStartupProject() {
  const project = projects.data.find(entry => entry.id === preferences.startupProjects[accessKey()]);
  if (project) await focusProject(project, false);
}
$('all-projects').onclick = async () => {
  projects.focused = null; renderThreads();
  try { await loadThreads(); } catch (error) { showError(error); }
};
function projectAtPath(path) {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return projects.data.find(project => project.roots.some(root => normalize(root.path) === normalize(path)));
}
function startProject(project) {
  if (!state.connected || state.sending || state.commandBusy || !project.roots[0]?.path) return;
  if (projects.focused && projects.focused !== project.id) { focusProject(project).catch(showError); return; }
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
    let indicator = button.querySelector('.thread-state');
    if (!label) { indicator?.remove(); button.removeAttribute('aria-label'); button.title = button.querySelector('strong').textContent; continue; }
    if (!indicator) { indicator = document.createElement('span'); indicator.setAttribute('role', 'img'); }
    button.prepend(indicator);
    indicator.className = 'thread-state ' + (working ? 'working' : unread ? 'unread' : completion);
    indicator.setAttribute('aria-label', label); indicator.title = label;
    button.setAttribute('aria-label', button.querySelector('strong').textContent + ' · ' + label);
    button.title = button.getAttribute('aria-label');
  }
}
function restoreUnread() {
  const prefix = accessKey() + ':';
  for (const key of state.unread) if (key.startsWith(prefix)) state.unread.delete(key);
  try {
    const saved = JSON.parse(localStorage.getItem(accessKey() + ':unread') || '[]');
    if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string' && id) state.unread.add(queueKey(id));
  } catch (error) { showError(`Could not load unread markers: ${error.message}`); }
}
function setUnread(threadId, unread) {
  const key = queueKey(threadId);
  if (state.unread.has(key) === unread) return true;
  const next = new Set(state.unread);
  if (unread) next.add(key); else next.delete(key);
  const prefix = accessKey() + ':';
  try {
    localStorage.setItem(accessKey() + ':unread', JSON.stringify([...next].filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length))));
    state.unread = next; renderThreadIndicators(); return true;
  } catch (error) { showError(`Could not save unread markers: ${error.message}`); return false; }
}
function markUnread(thread) {
  if (!thread?.id || state.loading && state.thread?.id === thread.id) return;
  setUnread(thread.id, true);
  $('thread-menu').hidden = true;
}
function unreadShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.isComposing || event.key?.toLowerCase() !== 'u' || document.querySelector('dialog[open]') || !state.thread || state.loading) return;
  event.preventDefault(); markUnread(state.thread);
}
function setThreadRuntimeStatus(threadId, status) {
  for (const thread of [...state.threads, ...state.pinnedThreads.values(), ...(state.thread ? [state.thread] : [])]) if (thread.id === threadId) thread.status = status;
}

async function togglePin(thread) {
  if (!state.connected || state.pinning.has(thread.id)) return;
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
  const filters = more ? [projectId || projects.focused] : projects.focused ? [projects.focused] : [null, ...projects.data.map(project => project.id)];
  const pages = await Promise.all(filters.map(id => rpc('thread/list', { limit: id && id !== projects.focused ? 5 : 50, sortKey: 'updated_at', modelProviders: [], searchTerm: $('search').value.trim() || null, cursor: more ? (id ? projects.cursors.get(id) : state.threadCursor) : null, ...(projects.data.length ? { projectId: id } : {}) })));
  if (generation !== state.listGeneration) return;
  const combined = [...(more ? state.threads : []), ...pages.flatMap(page => page.data)];
  state.threads = [...new Map(combined.map(thread => [thread.id, thread])).values()];
  if (!more) projects.cursors.clear();
  filters.forEach((id, index) => { if (id) projects.cursors.set(id, pages[index].nextCursor); else state.threadCursor = pages[index].nextCursor; });
  for (const thread of state.threads) if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
  const missing = [...state.pinnedIds].filter(id => !state.pinnedThreads.has(id));
  const pinned = await Promise.allSettled(missing.map(threadId => rpc('thread/read', { threadId, includeTurns: false })));
  if (generation !== state.listGeneration) return;
  for (const result of pinned) if (result.status === 'fulfilled' && state.pinnedIds.has(result.value.thread.id)) state.pinnedThreads.set(result.value.thread.id, result.value.thread);
  renderThreads();
}
function resetThread() {
  state.selection++;
  const project = projects.data.find(project => project.id === projects.selected);
  if (project?.roots[0]?.path) $('workspace').value = project.roots[0].path;
  modes.plan = false; hideSlash();
  state.images = [];
  renderImages();
  state.historyEvents = null;
  state.loading = false;
  state.thread = null;
  state.items.clear();
  state.turnCursor = null;
  $('messages').replaceChildren();
  $('welcome').hidden = false;
  $('older-turns').hidden = true;
  $('thread-title').textContent = 'New conversation';
  $('thread-path').textContent = $('workspace').value;
  $('prompt').value = '';
  renderThreads();
  renderRequests();
  updateBusy();
  $('prompt').focus();
}
function setThread(thread) {
  if (state.thread?.id !== thread.id) modes.plan = modes.threads.get(thread.id) || false;
  state.thread = thread;
  projects.selected = thread.projectId || null;
  if (state.pinnedIds.has(thread.id)) state.pinnedThreads.set(thread.id, thread);
  $('thread-title').textContent = titleOf(thread);
  $('thread-path').textContent = thread.cwd;
  $('welcome').hidden = true;
  if (thread.model && [...$('model').options].some(option => option.value === thread.model)) $('model').value = thread.model;
  updateEfforts(thread.reasoningEffort);
  renderThreads();
  renderRequests();
  updateBusy();
}
async function openThread(thread, allowBusy = false) {
  if (!state.connected || state.sending || state.commandBusy && !allowBusy) return;
  const selection = ++state.selection;
  $('error').hidden = true;
  if (state.thread?.id !== thread.id) { state.images = []; renderImages(); }
  state.loading = true;
  state.items.clear();
  state.historyEvents = [];
  $('messages').replaceChildren();
  setThread(thread);
  try {
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
    state.completions.delete(queueKey(thread.id)); renderThreadIndicators();
  } finally {
    if (selection === state.selection) { state.loading = false; state.historyEvents = null; updateBusy(); flushQueue(thread.id).catch(showError); }
  }
}
function markdown(element, text) {
  element.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { breaks: true }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'a', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub'],
    ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  });
}
function renderItem(item, prepend = false, turnId = null) {
  if (!item?.id) return;
  let record = state.items.get(item.id);
  const isMessage = ['userMessage', 'agentMessage', 'plan', 'exitedReviewMode'].includes(item.type);
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
    if (prepend) $('messages').prepend(element); else $('messages').append(element);
  }
  record.item = { ...record.item, ...item };
  if (turnId) record.turnId = turnId;
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
      else if (part.type === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(part.url || '')) {
        const image = document.createElement('img'); image.className = 'message-image'; image.src = part.url; image.alt = 'Attached image'; record.body.append(image);
      } else if (part.type === 'image' || part.type === 'localImage') record.body.append(document.createTextNode('[Image]'));
    }
  } else if (isMessage) {
    record.label.replaceChildren();
    const mark = document.createElement('span');
    mark.className = 'mini-mark'; mark.textContent = '›_';
    record.label.append(mark, document.createTextNode(item.type === 'plan' ? 'Plan' : 'Codex'));
    markdown(record.body, item.type === 'exitedReviewMode' ? item.review : item.text);
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
    record.body.textContent = JSON.stringify(item.result || item.output || item.arguments || item, null, 2);
  }
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
  if (state.dispatching.has(queue.key) || queue.saving) return;
  state.queueEdit = { queue, message }; queue.editing = true;
  $('queued-text').value = message.text;
  $('queued-attachments').textContent = message.images.length ? message.images.map(image => image.name).join(', ') : '';
  $('edit-queue-dialog').showModal(); $('queued-text').focus();
}
$('edit-queue-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.queueEdit; const text = $('queued-text').value.trim();
  if (!target || (!text && !target.message.images.length)) return;
  const previous = { text: target.message.text, input: target.message.input };
  target.message.text = text;
  target.message.input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...target.message.input.filter(part => part.type !== 'text' && part.type !== 'skill'), ...skillInputs(text, target.message.input.filter(part => part.type === 'skill'), target.queue.thread.cwd)];
  try { await persistQueue(target.queue); target.queue.editing = false; $('edit-queue-dialog').close(); renderQueue(); if (target.queue.machine === accessKey()) await flushQueue(target.queue.thread.id); }
  catch (error) { Object.assign(target.message, previous); showError(error); }
};
$('cancel-queue-edit').onclick = () => $('edit-queue-dialog').close();
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
function queueKey(threadId) { return accessKey() + ':' + threadId; }
async function persistQueue(queue) {
  queue.saving = (queue.saving || 0) + 1; renderQueue();
  try { await api.saveQueue({ key: queue.key, machine: queue.machine, thread: queue.thread, messages: queue.messages, paused: queue.paused }); }
  catch (error) { queue.paused = true; renderQueue(); throw new Error(`Could not save queued messages: ${error.message}`); }
  finally { queue.saving--; renderQueue(); }
}
async function restoreQueues() {
  const saved = await api.queues();
  for (const queue of saved) state.queues.set(queue.key, { ...queue, paused: true, editing: false });
}
function pauseQueue(queue) { queue.paused = true; queue.retry = null; return persistQueue(queue); }
function pauseQueues() {
  for (const queue of state.queues.values()) if (queue.machine === accessKey() && queue.messages.length) pauseQueue(queue).catch(showError);
}
async function retryQueue(queue) {
  const retry = {}; queue.retry = retry;
  await ensureWritable(queue.thread.id);
  if (queue.retry !== retry || !state.connected || queue.machine !== accessKey()) return;
  queue.paused = false; await persistQueue(queue); renderQueue(); await flushQueue(queue.thread.id);
}
function renderQueue() {
  const queue = state.queues.get(queueKey(state.thread?.id));
  $('queued-messages').replaceChildren();
  $('queued-messages').hidden = !queue?.messages.length;
  for (const message of queue?.messages || []) {
    const row = document.createElement('div'); row.className = 'queued-message';
    const label = document.createElement('button'); label.type = 'button'; label.className = 'queued-copy';
    label.title = 'Edit queued message';
    label.disabled = state.dispatching.has(queue.key) || Boolean(queue.saving);
    label.onclick = () => editQueuedMessage(queue, message);
    label.textContent = (queue.paused ? 'Waiting · ' : 'Queued · ') + (message.text || `${message.images.length} image(s)`);
    row.append(label);
    const action = (text, run) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle'; button.textContent = text;
      button.disabled = state.sending || state.dispatching.has(queue.key) || Boolean(queue.saving) || !state.connected;
      button.onclick = () => run().catch(showError); row.append(button);
    };
    action('Edit', async () => editQueuedMessage(queue, message));
    if (state.owned.has(queue.thread.id) && state.active.has(queue.thread.id)) action('Steer', async () => { await sendQueued(queue, message, true); await flushQueue(queue.thread.id); });
    else if (queue.paused) action('Retry', async () => retryQueue(queue));
    action('×', async () => { const previous = queue.messages; queue.messages = queue.messages.filter(entry => entry !== message); try { await persistQueue(queue); } catch (error) { queue.messages = previous; throw error; } finally { renderQueue(); } });
    row.lastChild.setAttribute('aria-label', 'Remove queued message');
    $('queued-messages').append(row);
  }
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
  state.completions.delete(key);
  state.dispatching.add(key); updateBusy();
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
    if (accessKey() === message.machine) requestTitle({ ...message.thread, preview: message.text });
  } catch (error) {
    if (visible()) { state.items.get(temporary)?.element.remove(); state.items.delete(temporary); }
    throw error;
  } finally { state.dispatching.delete(key); updateBusy(); }
}
async function sendQueued(queue, message, steer = false) {
  if (!state.connected || accessKey() !== queue.machine || state.dispatching.has(queue.key) || queue.saving) return;
  try {
    await persistQueue(queue);
    if (!steer && queue.paused) return;
    if (!state.connected || accessKey() !== queue.machine) { await pauseQueue(queue); return; }
    await submitMessage(message, steer);
    queue.messages = queue.messages.filter(entry => entry !== message);
    await persistQueue(queue);
  } catch (error) {
    await pauseQueue(queue).catch(showError);
    showError(`Queued message was not confirmed: ${error.message} Check history before retrying.`);
  }
  renderQueue();
}
async function flushQueue(threadId) {
  const queue = state.queues.get(queueKey(threadId));
  if (!queue || queue.paused || queue.editing || queue.saving || !state.connected || state.sending || state.dispatching.has(queue.key) || state.active.has(threadId) || (state.loading && state.thread?.id === threadId)) return;
  const message = queue.messages[0];
  if (!message) return;
  await sendQueued(queue, message);
  if (!queue.paused && queue.messages.length && !state.active.has(threadId)) await flushQueue(threadId);
}
async function send(event, steer = false, action = null) {
  event?.preventDefault();
  if (state.connecting) return;
  const text = $('prompt').value.trim();
  if (!action && !steer && /^\/[a-z-]*(?:\s|$)/i.test(text)) { await executeSlash(text); return; }
  if (state.commandBusy && !action) return;
  if ((!text && !state.images.length) || state.images.some(image => !image.url) || !state.connected || state.sending || state.loading) return;
  const images = [...state.images];
  const input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'image', url: image.url })), ...skillInputs(text)];
  const access = policy();
  const message = { text, images, input, access, review: Boolean(action?.review), mode: modes.plan ? 'plan' : 'default', model: $('model').value, effort: $('effort').value, machine: accessKey(), thread: state.thread };
  state.sending = true; updateBusy();
  try {
    if (!state.thread) {
      const result = await rpc('thread/start', { cwd: $('workspace').value.trim(), ...access, ...(projects.selected ? { projectId: projects.selected } : {}), ...(message.model ? { model: message.model } : {}) });
      if (!result.thread.preview?.trim()) result.thread.preview = text || 'Image';
      state.owned.add(result.thread.id);
      modes.threads.set(result.thread.id, message.mode === 'plan');
      setThread(result.thread);
      state.threads.unshift(result.thread); renderThreads();
      message.thread = result.thread;
    } else if (!state.owned.has(state.thread.id)) await ensureWritable(state.thread.id);
    const key = queueKey(state.thread.id);
    if (!steer && (state.active.has(state.thread.id) || state.dispatching.has(key) || state.queues.get(key)?.messages.length)) {
      const queue = state.queues.get(key) || { key, machine: message.machine, thread: state.thread, messages: [], paused: false };
      queue.messages.push(message); state.queues.set(key, queue);
      try { await persistQueue(queue); } catch (error) { queue.messages = queue.messages.filter(entry => entry !== message); throw error; }
      $('prompt').value = ''; hideSlash(); state.images = []; renderImages();
      return;
    }
    $('prompt').value = ''; hideSlash(); state.images = []; renderImages();
    await submitMessage(message, steer);
  } catch (error) {
    if (!$('prompt').value) $('prompt').value = text;
    state.images = images; renderImages(); showError(error);
  } finally {
    state.sending = false; updateBusy();
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
  if (!api.title || !thread.preview?.trim() || thread.name || state.names.has(thread.id) || state.titling.has(thread.id) || state.titleFailed) return;
  const options = state.options;
  state.titling.add(thread.id);
  state.titleTask = state.titleTask.catch(() => {}).then(async () => {
    if (state.options !== options || state.titleFailed) return;
    try {
      const name = await api.title(thread.id, thread.preview.slice(0, 4000));
      if (state.options === options && name && !state.names.has(thread.id)) applyName(thread.id, name);
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
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
  $('clone-conversation').focus();
}
function openMessageEdit(record) {
  if (!state.connected || state.sending || state.commandBusy || state.loading || !record.turnId || state.items.get(record.item.id) !== record) return;
  state.messageEdit = { thread: state.thread, turnId: record.turnId, content: record.item.content || [], options: state.options };
  $('edited-message').value = state.messageEdit.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const count = state.messageEdit.content.filter(part => part.type !== 'text' && part.type !== 'skill').length;
  $('edited-message-attachments').textContent = count ? `${count} attachment(s) will be kept.` : '';
  $('edit-message-dialog').showModal(); $('edited-message').focus();
}
async function cloneConversation(source, edit = null) {
  if (!source || !state.connected || state.sending || state.commandBusy || state.loading || edit && (edit.options !== state.options || source.id !== state.thread?.id)) return;
  const options = state.options; const selection = state.selection; const machine = accessKey();
  const mode = source.id === state.thread?.id ? modes.plan : modes.threads.get(source.id) || false;
  const access = policy();
  const model = $('model').value; const effort = $('effort').value;
  const operation = {}; state.branching = operation;
  const current = () => state.branching === operation && state.options === options && state.connected;
  state.commandBusy = true; hideSlash(); updateBusy();
  let fork, message, sent = false;
  try {
    const result = await rpc('thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true, ...access, ...(edit ? { beforeTurnId: edit.turnId } : {}) });
    if (!current()) return;
    fork = result.thread;
    const name = titleOf(source).slice(0, 110) + (edit ? ' (edited)' : ' (copy)');
    fork.name = name;
    state.owned.add(fork.id); modes.threads.set(fork.id, mode);
    state.threads.unshift(fork);
    if (edit) {
      message = { text: edit.text, images: [], input: [...(edit.text ? [{ type: 'text', text: edit.text, text_elements: [] }] : []), ...edit.content.filter(part => !['text', 'skill'].includes(part.type)), ...skillInputs(edit.text, edit.content.filter(part => part.type === 'skill'), source.cwd)], access, mode: mode ? 'plan' : 'default', model, effort, machine, thread: fork };
      $('edit-message-dialog').close();
    }
    renderThreads();
    await rpc('thread/name/set', { threadId: fork.id, name });
    if (!current()) return;
    applyName(fork.id, name);
    if (source.projectId && fork.projectId !== source.projectId) {
      await rpc('thread/metadata/update', { threadId: fork.id, projectId: source.projectId });
      if (!current()) return;
      fork.projectId = source.projectId;
    }
    if (selection !== state.selection) return;
    await openThread(fork, true);
    if (message && current() && state.thread?.id === fork.id) { await submitMessage(message); sent = true; }
    return fork;
  } catch (error) {
    if (state.branching !== operation || state.options !== options) return;
    if (message) {
      showError(`Edited message was not confirmed; it is saved in the copy's queue. Check its history before retrying. ${error.message}`);
    } else showError(error);
  } finally {
    if (message && !sent) {
      const key = machine + ':' + fork.id;
      state.queues.set(key, { key, machine, thread: fork, messages: [message], paused: true });
      await persistQueue(state.queues.get(key)).catch(showError);
    }
    if (state.branching === operation) { state.branching = null; state.commandBusy = false; updateBusy(); }
  }
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
  clearThreadDrag();
  clearProjectDrag(); $('project-menu').hidden = true;
  pauseQueues();
  state.connecting = true;
  state.connected = false;
  state.options = options;
  state.commandBusy = false; state.branching = null;
  projects.generation++; projects.data = []; projects.selected = null; projects.focused = null; projects.cursors.clear(); projects.collapsed.clear();
  try { const saved = JSON.parse(localStorage.getItem(accessKey() + ':collapsed-projects') || '[]'); if (Array.isArray(saved)) projects.collapsed = new Set(saved.filter(id => typeof id === 'string')); } catch {}
  $('project-dialog').close(); state.projectDraft = null; $('move-project-dialog').close(); $('project-view-dialog').close();
  state.owned.clear(); state.resuming.clear();
  state.names.clear(); state.titling.clear(); state.titleFailed = false;
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
  state.listGeneration++;
  state.folderGeneration++;
  $('folder-dialog').close();
  state.active.clear();
  state.requests.clear();
  connectionLabels();
  resetThread();
  status('Connecting…');
  renderRequests();
  $('settings-error').textContent = '';
  try {
    await api.connect(options);
    state.connected = true;
    $('workspace').value = isLocal() ? options.localCwd : options.cwd;
    $('thread-path').textContent = $('workspace').value;
    $('settings-dialog').close();
    $('error').hidden = true;
    resetThread();
    status(connectedStatus());
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
  } finally { state.connecting = false; status(state.connected ? connectedStatus() : 'Not connected'); }
}
function handleNotification(message) {
  const { method, params = {}, id } = message;
  if (method === 'connection/closed') {
    clearThreadDrag();
    clearProjectDrag(); $('project-menu').hidden = true;
    pauseQueues();
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
  if (method === 'thread/status/changed') { setThreadRuntimeStatus(params.threadId, params.status); renderThreadIndicators(); return; }
  if (method === 'turn/started' && !state.finished.has(params.turn.id)) {
    state.owned.add(params.threadId); state.writerConflicts.delete(queueKey(params.threadId));
    state.completions.delete(queueKey(params.threadId));
    setThreadRuntimeStatus(params.threadId, { type: 'active' });
    state.active.set(params.threadId, params.turn.id); updateBusy();
  }
  if (method === 'turn/completed') {
    const activeTurn = state.active.get(params.threadId);
    if (!state.finished.has(params.turn.id) && (!activeTurn || activeTurn === params.turn.id)) {
      setThreadRuntimeStatus(params.threadId, { type: 'idle' });
      if (['completed', 'failed'].includes(params.turn.status)) state.completions.set(queueKey(params.threadId), params.turn.status);
      const queue = state.queues.get(queueKey(params.threadId));
      if (queue && ['failed', 'interrupted'].includes(params.turn.status)) pauseQueue(queue).catch(showError);
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
    if (queue && !params.willRetry) { pauseQueue(queue).catch(showError); renderQueue(); }
    showError(params.error?.message || params.message || 'Codex reported an error.');
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
    renderItem({ ...previous, id: params.itemId, type: 'commandExecution', aggregatedOutput: (previous?.aggregatedOutput || '') + params.delta });
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    const previous = state.items.get(params.itemId)?.item;
    const summary = [...(previous?.summary || [])];
    summary[params.summaryIndex || 0] = (summary[params.summaryIndex || 0] || '') + params.delta;
    renderItem({ id: params.itemId, type: 'reasoning', summary });
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
$('add-project').onclick = () => openProjectPicker('project');
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
  $('open-project').disabled = !state.connected || projects.focused === project.id || state.sending || state.commandBusy || state.loading;
  $('rename-project').disabled = !state.connected;
  $('move-project-up').disabled = !state.connected || projectDrag.pending === state.options || index <= 0;
  $('move-project-down').disabled = !state.connected || projectDrag.pending === state.options || index < 0 || index === projects.data.length - 1;
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
  $('rename-project').focus();
}
$('open-project').onclick = () => {
  const target = state.contextProject;
  if (target?.options === state.options) return focusProject(target.project).catch(showError);
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
  try { await focusProject(target.project); } catch (error) { showError(error); }
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
  for (const group of $('threads').querySelectorAll('[data-search-hidden]')) group.hidden = true;
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
$('dismiss-error').onclick = () => { $('error').hidden = true; };
$('browse-key').onclick = async () => { try { const key = await api.chooseKey(); if (key) $('key').value = key; } catch (error) { showError(error); } };
$('settings-form').onsubmit = event => { event.preventDefault(); connect({ mode: $('connection-mode').value, host: $('host').value, port: $('port').value, key: $('key').value, cwd: $('default-cwd').value, localCwd: $('local-cwd').value, codexPath: $('codex-path').value }); };
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
$('unread-shortcut').textContent = navigator.platform.includes('Mac') ? '⌘⇧U' : 'Ctrl+Shift+U';
$('mark-unread').setAttribute('aria-keyshortcuts', navigator.platform.includes('Mac') ? 'Meta+Shift+U' : 'Control+Shift+U');
$('clone-conversation').onclick = () => cloneConversation(state.contextThread);
$('cancel-message-edit').onclick = () => $('edit-message-dialog').close();
$('edit-message-dialog').onclose = () => { if (!$('edit-message-dialog').open) state.messageEdit = null; };
$('edit-message-form').onsubmit = async event => {
  event.preventDefault();
  const target = state.messageEdit; const text = $('edited-message').value.trim();
  if (!target || !text && !target.content.some(part => !['text', 'skill'].includes(part.type))) return;
  await cloneConversation(target.thread, { ...target, text });
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
$('prompt').oninput = () => { slash.dismissed = null; slash.index = 0; slash.skillOnly = false; updateSlash(); };
$('prompt').onkeydown = promptKeydown;
$('plan-mode').onclick = () => { modes.plan = false; if (state.thread) modes.threads.set(state.thread.id, false); updateBusy(); };
$('model').onchange = () => updateEfforts();
$('workspace').oninput = () => { $('thread-path').textContent = $('workspace').value; projects.selected = projectAtPath($('workspace').value.trim())?.id || null; };
$('refresh').onclick = () => refreshProjects().catch(showError);
$('more-threads').onclick = async () => {
  $('more-threads').disabled = true;
  try { await loadThreads(true); } catch (error) { showError(error); } finally { $('more-threads').disabled = false; }
};
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadThreads().catch(showError), 250); };
$('stop').onclick = async () => {
  try {
    const turnId = state.active.get(state.thread?.id);
    if (turnId) await rpc('turn/interrupt', { threadId: state.thread.id, turnId });
  } catch (error) { showError(error); }
};
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
document.addEventListener('click', event => { if (!event.target.closest('#composer')) hideSlash(); $('thread-menu').hidden = true; $('project-menu').hidden = true; if (event.target.closest('a')) event.preventDefault(); });
document.addEventListener('drop', event => { if (threadDrag.source && event.dataTransfer?.types.includes(threadDrag.type)) { event.preventDefault(); clearThreadDrag(); } });
document.addEventListener('drop', event => { if (projectDrag.source && event.dataTransfer?.types.includes(projectDrag.type)) { event.preventDefault(); clearProjectDrag(); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('thread-menu').hidden = true; $('project-menu').hidden = true; clearProjectDrag(); } });
async function init() {
  if (!api) { showError('Open Remote Codex as a desktop app to connect to Codex.'); return; }
  api.onNotification(handleNotification);
  Object.assign(preferences, await api.preferences()); applyTheme(preferences.theme);
  await restoreQueues();
  const options = await api.settings();
  fillSettings(options);
  await connect(options);
}
init().catch(showError);

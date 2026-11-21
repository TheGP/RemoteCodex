const readline = require('node:readline');
const { randomUUID, createHash } = require('node:crypto');

const sessions = new Map(), subscriptions = new Map(), uploads = new Map(), deferredEdits = new Map();
const at = 1_763_000_000_000;
let ordinal = 0;
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const respond = (request, result) => write({ id: request.id, result });
const row = (rowId, turnId, kind, fields) => ({ rowId, turnId, entityId: 'entity-' + rowId, productTurnId: turnId, createdAt: at + rowId, createdAtSeq: rowId, kind, ...fields });

function snapshot(sessionId, title = 'Fixture conversation') {
  return {
    protocolVersion: 1, sessionId, logEpoch: sessionId + '-epoch', seq: 0, revision: 1,
    runtimeInitialization: { status: 'ready', attemptId: 'fixture-init' },
    control: { phase: 'completedSuccess', sessionEnded: true, canStop: false, stopState: 'idle', stopTargetKind: 'unknown', activeWorks: [], lastError: null, apiRetry: null },
    availability: Object.fromEntries(['fork', 'compact', 'switchModelConfig', 'setFollowupMode', 'queueEdit', 'sendQueuedNow', 'pauseGoal', 'resumeGoal'].map(key => [key, { allowed: true }])),
    inputRouting: { mode: 'startNow' }, meta: { title, titleSource: 'custom' },
    config: { provider: 'fixture', model: 'model-a', thought: 'high', thoughtLevels: ['low', 'high'], modelSelection: { providerId: 'fixture', modelId: 'model-a', options: { reasoningLevel: 'high' } }, followupMode: 'queue', mode: 'build', planEnabled: false },
    usage: { contextWindow: { usedTokens: 1200, maxTokens: 128000, autoCompactThresholdTokens: 100000 }, cumulative: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: true }, pendingInteractions: [], pendingCommands: [], backgroundWorks: [], goal: null, plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null }
  };
}
const old = snapshot('history-session');
old.rows.window = [
  row(1, 'history-turn', 'turnHeader', { origin: 'userInput', executionKind: 'agent', sourceCommandId: 'old-command', state: 'completedSuccess', startedAt: at, endedAt: at + 3 }),
  row(2, 'history-turn', 'userInput', { text: 'Saved question', origin: 'realUser', sourceCommandId: 'old-command', actions: { canEdit: true, editDisposition: 'rewind' }, attachments: [{ attachmentId: 'original-image', name: 'original.png', mimeType: 'image/png' }] }),
  row(3, 'history-turn', 'assistantText', { text: 'Saved answer', state: 'complete' })
];
old.rows.totalCount = 3; old.rows.firstRowId = 1; sessions.set(old.sessionId, old);

function emitFrame(topic, payload, fromSeq, toSeq, fragments = false) {
  const subscription = subscriptions.get(topic);
  if (!subscription) return;
  const frame = { topic, subscriptionId: subscription.id, fromSeq, toSeq, sentAt: at + ordinal, payload };
  ordinal++;
  const outer = { wireVersion: 3, deliveryKind: payload.kind === 'snapshot' ? 'initial' : 'online', logicalFrameId: randomUUID(), logicalFrameOrdinal: ++subscription.ordinal, topic, subscriptionId: subscription.id };
  if (!fragments) return write({ method: 'v4/conversation/frame', params: { ...outer, kind: 'complete', frame } });
  const bytes = Buffer.from(JSON.stringify(frame));
  let crc = -1;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  const checksum = { algorithm: 'crc32', value: ((crc ^ -1) >>> 0).toString(16).padStart(8, '0') };
  const marker = bytes.indexOf(Buffer.from('世界🙂'));
  const boundary = marker >= 0 ? marker + 1 : Math.ceil(bytes.length / 3);
  const pieces = [bytes.subarray(0, boundary), bytes.subarray(boundary, boundary + 2), bytes.subarray(boundary + 2)];
  for (let index = 0; index < pieces.length; index++) write({ method: 'v4/conversation/frame', params: { ...outer, kind: 'fragment', fragmentIndex: index, fragmentCount: pieces.length, logicalBytes: bytes.length, checksum, dataBase64: pieces[index].toString('base64') } });
}
function stateForTopic(topic, workspace) {
  if (topic.startsWith('conversation/')) return sessions.get(topic.slice('conversation/'.length));
  if (topic.startsWith('sessions-index/')) return { protocolVersion: 1, workspaceId: workspace, logEpoch: 'sessions-epoch', sessions: [...sessions.values()].map(value => ({ sessionId: value.sessionId, workspaceId: workspace, title: value.meta.title, titleSource: value.meta.titleSource, phase: value.control.phase, sessionEnded: value.control.sessionEnded, hasBackgroundWork: false, lastActivityAt: at + 100, createdAt: at })) };
  return { protocolVersion: 1, workspaceId: workspace, logEpoch: 'config-epoch', config: { configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'fixture/model-a', options: [{ value: 'fixture/model-a', name: 'Fixture Model', modelProviderId: 'fixture', modelProviderName: 'Fixture', modelThoughtLevels: ['low', 'high'], modelDefaultThoughtLevel: 'high' }] }], slashCommands: [] } };
}
function emitSnapshot(topic, workspace, fragments) {
  const value = stateForTopic(topic, workspace);
  if (value) emitFrame(topic, { kind: 'snapshot', snapshot: value }, 0, value.seq || 0, fragments);
}
function delta(sessionId, operations, fragments = false) {
  const value = sessions.get(sessionId), from = value.seq;
  for (const operation of operations) {
    if (operation.op === 'state.updated') Object.assign(value, operation.patch);
    else if (operation.op === 'row.removed') value.rows.window = value.rows.window.filter(row => row.rowId < operation.fromRowId);
    else if (operation.op === 'row.appended') value.rows.window.push(operation.row);
    else if (operation.op === 'row.upserted') { const index = value.rows.window.findIndex(entry => entry.rowId === operation.row.rowId); if (index >= 0) value.rows.window[index] = operation.row; }
    else if (operation.op === 'row.delta') {
      const target = value.rows.window.find(entry => entry.rowId === operation.rowId);
      if (!target) continue;
      if (operation.path === 'output.text') target.output = { ...target.output, text: (target.output?.text || '') + operation.append };
      else target[operation.path] = (target[operation.path] || '') + operation.append;
    }
  }
  value.rows.totalCount = value.rows.window.length; value.rows.firstRowId = value.rows.window[0]?.rowId ?? null;
  value.seq += operations.length; value.revision++;
  emitFrame('conversation/' + sessionId, { kind: 'deltas', deltas: operations }, from, value.seq, fragments);
}
function ack(request, envelope, result, status = 'accepted') {
  respond(request, { commandId: envelope.commandId, status, revisionAtDecision: sessions.get(envelope.sessionId)?.revision || 1, ...(result ? { result } : {}) });
}
function command(request) {
  const envelope = request.params, payload = envelope.payload || {};
  const value = sessions.get(envelope.sessionId);
  if (envelope.type === 'createSession') {
    const id = payload.sessionId || 'created-session'; sessions.set(id, snapshot(id, 'New conversation'));
    return ack(request, envelope, { type: 'createSession', sessionId: id });
  }
  if (envelope.type === 'sendText' || envelope.type === 'editUserQuery') {
    const editing = envelope.type === 'editUserQuery', text = editing ? payload.newText : payload.text;
    let attachments = payload.attachments;
    const first = Math.max(value.nextRowId || 0, ...value.rows.window.map(entry => entry.rowId)) + 1;
    if (editing) {
      const user = value.rows.window.find(entry => entry.rowId === payload.target.rowId && entry.entityId === payload.target.entityId);
      const latest = value.rows.window.findLast(entry => entry.kind === 'userInput' && entry.origin === 'realUser');
      if (!user || user !== latest || user.actions?.canEdit !== true) return respond(request, { commandId: envelope.commandId, status: 'rejected', revisionAtDecision: value.revision, reasonCode: 'guard.latestQueryEditOnly' });
      attachments ??= user.attachments;
      if (text === 'reject edit') return respond(request, { commandId: envelope.commandId, status: 'rejected', revisionAtDecision: value.revision, reasonCode: 'guard.auth', message: 'Sign in through ZCode before editing.' });
      const header = value.rows.window.find(entry => entry.kind === 'turnHeader' && entry.turnId === user.turnId);
      delta(envelope.sessionId, [{ op: 'row.removed', fromRowId: header.rowId }]);
      if (text === 'fail edit after cut') return respond(request, { commandId: envelope.commandId, status: 'failed', revisionAtDecision: value.revision, reasonCode: 'fault.command.executionFailed', message: 'Edit interrupted after branch change' });
    }
    if (payload.text === 'reject this input') return respond(request, { commandId: envelope.commandId, status: 'rejected', revisionAtDecision: value.revision, reasonCode: 'guard.fixture', message: 'Fixture rejected input' });
    ack(request, envelope, editing ? { type: 'editUserQuery', disposition: 'rewind', sessionId: envelope.sessionId } : { type: 'inputAccepted', delivery: text === 'queue this input' ? 'queue' : 'startNow', inputId: 'input-' + envelope.commandId });
    if (editing && text === 'queue edited input') return delta(envelope.sessionId, [{ op: 'state.updated', patch: { queue: { items: [{ sourceCommandId: envelope.commandId, queueItemId: 'queue_' + envelope.commandId, text }], autoDrain: false } } }]);
    if (payload.text === 'queue this input') return;
    const turnId = 'turn-' + envelope.commandId;
    value.nextRowId = first + 2;
    const control = { ...value.control, phase: 'running', sessionEnded: false, canStop: true, stopState: 'stoppable', activeWorks: [{ kind: 'primaryTurn', foregroundExecutionId: turnId, sourceCommandId: envelope.commandId, startedAt: at }] };
    const publish = () => {
      delta(envelope.sessionId, [
        ...value.rows.window.filter(entry => entry.kind === 'userInput' && entry.actions?.canEdit).map(entry => ({ op: 'row.upserted', row: { ...entry, actions: {} } })),
        { op: 'row.appended', row: row(first, turnId, 'turnHeader', { origin: 'userInput', executionKind: 'agent', sourceCommandId: envelope.commandId, state: 'running', startedAt: at }) },
        { op: 'row.appended', row: row(first + 1, turnId, 'userInput', { text, origin: 'realUser', sourceCommandId: envelope.commandId, actions: { canEdit: true, editDisposition: 'rewind' }, ...(attachments ? { attachments } : {}) }) },
        { op: 'state.updated', patch: { control, inputRouting: { mode: 'enqueue' } } }
      ]);
      if (text === 'hold this input') return;
      if (text === 'fail after admission') {
        delta(envelope.sessionId, [
          { op: 'row.upserted', row: { ...value.rows.window.find(entry => entry.rowId === first), state: 'failed', endedAt: at + 10 } },
          { op: 'state.updated', patch: { control: { ...control, phase: 'error', sessionEnded: false, canStop: false, stopState: 'idle', activeWorks: [], lastError: { code: 'fixture.provider', message: 'Fixture provider request failed', recoverable: false, at: at + 10, source: 'provider' } }, inputRouting: { mode: 'startNow' } } }
        ]);
        return;
      }
      const assistant = row(first + 2, turnId, 'assistantText', { text: 'Hello', state: 'streaming' });
      delta(envelope.sessionId, [{ op: 'row.appended', row: assistant }]);
      delta(envelope.sessionId, [{ op: 'row.delta', rowId: assistant.rowId, path: 'text', append: ' 世界🙂' }]);
      delta(envelope.sessionId, [{ op: 'row.upserted', row: { ...assistant, state: 'complete' } }, { op: 'row.upserted', row: { ...value.rows.window.find(entry => entry.rowId === first), state: 'completedSuccess', endedAt: at + 10 } }, { op: 'state.updated', patch: { control: { ...control, phase: 'completedSuccess', sessionEnded: true, canStop: false, stopState: 'idle', activeWorks: [] }, inputRouting: { mode: 'startNow' } } }]);
    };
    if (editing && text === 'wait for edit projection') deferredEdits.set(envelope.sessionId, publish);
    else setTimeout(publish, 10);
    return;
  }
  if (envelope.type === 'stop') {
    ack(request, envelope);
    const turn = [...value.rows.window].reverse().find(entry => entry.kind === 'turnHeader');
    if (turn) delta(envelope.sessionId, [{ op: 'row.upserted', row: { ...turn, state: 'completedInterrupted', endedAt: at + 10 } }, { op: 'state.updated', patch: { control: { ...value.control, phase: 'completedInterrupted', sessionEnded: true, canStop: false, stopState: 'idle', activeWorks: [] }, queue: { items: [], autoDrain: false, pauseReason: 'stopped' } } }]);
    return;
  }
  if (envelope.type === 'resolveInteraction') {
    ack(request, envelope, { type: 'resolveInteraction', resolvedBy: { clientId: envelope.clientId, optionId: payload.answer?.optionId } });
    delta(envelope.sessionId, [{ op: 'state.updated', patch: { pendingInteractions: value.pendingInteractions.filter(entry => entry.interactionId !== payload.interactionId) } }]);
    return;
  }
  if (envelope.type === 'renameSession') {
    ack(request, envelope); delta(envelope.sessionId, [{ op: 'state.updated', patch: { meta: { title: payload.title, titleSource: 'custom' } } }]); return;
  }
  ack(request, envelope);
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); process.send?.({ request });
  if (request.method === 'runtime/capabilities') return respond(request, { protocolVersion: 4, independentPlanState: true, historyFirst: true });
  if (request.method === 'remote-codex/usage') return respond(request, {
    rateLimits: { limitId: 'zcode', primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1800000000 } },
    plan: { name: 'GLM Coding Plan', expiresAt: 1800010000 }
  });
  if (request.method === 'remote-codex/catalog') return respond(request, { models: [{ providerId: 'fixture', providerName: 'Fixture', modelId: 'model-a', modelName: 'Fixture Model', reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high' }], defaultModelSelection: { providerId: 'fixture', modelId: 'model-a', options: { reasoningLevel: 'high' } } });
  if (request.method === 'session/list') return respond(request, { sessions: [...sessions.values()].map(value => ({ sessionId: value.sessionId, title: value.meta.title, titleSource: value.meta.titleSource, createdAt: at, updatedAt: at + 100, status: value.control.phase === 'running' ? 'running' : 'idle', mode: value.config.mode, model: value.config.modelSelection, sessionKind: 'interactive', workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() } })) });
  if (request.method === 'v4/conversation/subscribe' || request.method === 'v4/conversation/resync') {
    const { topic, workspace } = request.params;
    const id = request.method.endsWith('/resync') ? subscriptions.get(topic)?.id : randomUUID();
    subscriptions.set(topic, { id, ordinal: request.method.endsWith('/resync') ? subscriptions.get(topic)?.ordinal || 0 : 0, workspace: workspace?.workspaceKey || workspace?.workspacePath || process.cwd() });
    const state = stateForTopic(topic, subscriptions.get(topic).workspace);
    respond(request, { ack: { subscriptionId: id, mode: 'snapshot', logEpoch: state?.logEpoch || 'missing' } });
    setTimeout(() => emitSnapshot(topic, subscriptions.get(topic).workspace), 5); return;
  }
  if (request.method === 'v4/conversation/rowsRange') {
    const value = sessions.get(request.params.sessionId), before = request.params.beforeRowId ?? Infinity;
    const rows = value.rows.window.filter(entry => entry.rowId < before).slice(-request.params.limit);
    return respond(request, { rows, atSeq: value.seq, atRevision: value.revision, atLogEpoch: value.logEpoch, hasMore: rows.length && rows[0].rowId > value.rows.firstRowId });
  }
  if (request.method === 'v4/command') return command(request);
  if (request.method === 'v4/attachment/begin') {
    uploads.set(request.params.uploadId, { ...request.params, chunks: [] });
    return respond(request, { uploadId: request.params.uploadId, state: 'staging', nextChunkIndex: 0 });
  }
  if (request.method === 'v4/attachment/chunk') {
    const upload = uploads.get(request.params.uploadId);
    if (!upload || upload.chunks.length !== request.params.chunkIndex) return write({ id: request.id, error: { code: -32602, message: 'Invalid fixture upload chunk order' } });
    upload.chunks.push(Buffer.from(request.params.dataBase64, 'base64'));
    return respond(request, { uploadId: upload.uploadId, nextChunkIndex: upload.chunks.length });
  }
  if (request.method === 'v4/attachment/commit') {
    const upload = uploads.get(request.params.uploadId), bytes = upload && Buffer.concat(upload.chunks);
    if (!upload || bytes.length !== upload.totalBytes || upload.chunks.length !== upload.totalChunks || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== upload.checksum) return write({ id: request.id, error: { code: -32602, message: 'Fixture upload failed byte/checksum validation' } });
    return respond(request, { ref: '/fixture-upload/' + upload.uploadId + '.png' });
  }
  if (request.method === 'v4/attachment/abort') { uploads.delete(request.params.uploadId); return respond(request, {}); }
  if (request.method === 'workspace/readPresentation') return respond(request, { workspaceId: process.cwd(), configOptions: stateForTopic('workspace-config/test', process.cwd()).config.configOptions });
  if (request.method === 'v4/conversation/unsubscribe') return respond(request, {});
  write({ id: request.id, error: { code: -32601, message: 'Fixture method not found: ' + request.method } });
});
process.on('message', control => {
  const value = sessions.get(control.sessionId || 'history-session');
  if (control.action === 'publish-edit') { const publish = deferredEdits.get(value.sessionId); deferredEdits.delete(value.sessionId); return publish?.(); }
  if (control.action === 'close') return process.exit(0);
  if (control.action === 'gap') {
    value.seq += 3;
    return delta(value.sessionId, [{ op: 'state.updated', patch: { meta: { title: 'Recovered after gap', titleSource: 'custom' } } }]);
  }
  if (control.action === 'fragment') {
    value.rows.window.find(entry => entry.kind === 'assistantText').text = 'Recovered 世界🙂';
    value.seq++; value.revision++;
    return emitSnapshot('conversation/' + value.sessionId, process.cwd(), true);
  }
  if (control.action === 'tools') {
    const first = Math.max(0, ...value.rows.window.map(entry => entry.rowId)) + 1;
    const bash = row(first, 'history-turn', 'toolCall', { toolCallId: 'bash-fixture', toolName: 'Bash', status: 'running', inputText: '{"command":"printf fixture"}', input: { command: 'printf fixture' }, output: { text: 'fixture output' } });
    delta(value.sessionId, [{ op: 'row.appended', row: bash }]);
    return delta(value.sessionId, [
      { op: 'row.upserted', row: { ...bash, status: 'success' } },
      { op: 'row.appended', row: row(first + 1, 'history-turn', 'toolCall', { toolCallId: 'edit-fixture', toolName: 'Edit', status: 'success', inputText: '{}', output: { text: 'File updated', display: { kind: 'file_diff', filePath: process.cwd() + '/example.ts', additions: 1, deletions: 1, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const count = 1;', '+const count = 2;'] }] } } }) }
    ]);
  }
  if (control.action === 'stream-paths') {
    const first = Math.max(0, ...value.rows.window.map(entry => entry.rowId)) + 1;
    delta(value.sessionId, [
      { op: 'row.appended', row: row(first, 'history-turn', 'toolCall', { toolCallId: 'stream-fixture', toolName: 'Bash', status: 'running', inputText: '{}', input: { command: 'echo fixture' }, output: { text: 'First' } }) },
      { op: 'row.appended', row: row(first + 1, 'history-turn', 'subagent', { subagentType: 'explore', status: 'running', summaryText: 'Looking' }) }
    ]);
    delta(value.sessionId, [{ op: 'row.delta', rowId: first, path: 'output.text', append: ' output' }, { op: 'row.delta', rowId: first + 1, path: 'summaryText', append: ' carefully' }]);
    return;
  }
  if (control.action === 'outside-window') return delta(value.sessionId, [
    { op: 'row.delta', rowId: 99999, path: 'text', append: 'Do not show this' },
    { op: 'row.upserted', row: row(99999, 'outside-turn', 'assistantText', { text: 'Do not insert this', state: 'complete' }) },
    { op: 'state.updated', patch: { meta: { title: 'Kept after outside-window deltas', titleSource: 'custom' } } }
  ]);
  if (control.action === 'interaction') {
    const permission = control.kind === 'permission';
    const payload = permission ? { kind: 'permission', toolCallId: 'tool-permission', toolName: 'Bash', summary: 'Run fixture command?', detail: { command: 'echo fixture' }, options: [{ optionId: 'allow-once', label: 'Allow once', kind: 'allowOnce' }, { optionId: 'deny', label: 'Deny', kind: 'deny' }] } : { kind: 'userInput', prompt: 'Choose fixture option', freeText: true, toolName: 'AskUserQuestion', questions: [{ question: 'Which fixture option?', header: 'Fixture', options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }] }] };
    return delta(value.sessionId, [{ op: 'state.updated', patch: { pendingInteractions: [{ interactionId: control.id || 'interaction-1', kind: payload.kind, anchorRowId: null, createdAt: at, payload }] } }]);
  }
});
setImmediate(() => write({ method: 'remote-codex/ready', params: {} }));

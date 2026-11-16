const fs = require('node:fs');
const path = require('node:path');

const themes = new Set(['system', 'light', 'dark', 'purple', 'claude-code', 'nord', 'midnight']);
const fileOpeners = new Set(['vscode', 'antigravity', 'gitferry', 'reveal']);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const validConversationState = data => data && Array.isArray(data.unread) && data.unread.every(validId) && data.completions && typeof data.completions === 'object' && !Array.isArray(data.completions) && Object.entries(data.completions).every(([id, status]) => validId(id) && ['completed', 'failed', 'interrupted'].includes(status));
const validActiveRuns = values => values && typeof values === 'object' && !Array.isArray(values) && Object.entries(values).every(([machine, runs]) => machine.startsWith('access:') && machine.length <= 300 && runs && typeof runs === 'object' && !Array.isArray(runs) && Object.entries(runs).every(([id, run]) => validPinId(id) && validId(run?.turnId) && typeof run.provider === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(run?.provider)));
const validOrders = orders => orders && typeof orders === 'object' && !Array.isArray(orders) && Object.entries(orders).every(([projectId, ids]) => validId(projectId) && Array.isArray(ids) && ids.every(validId));
const validCutoff = value => Number.isSafeInteger(value) && value >= 0;
const validVolume = value => Number.isInteger(value) && value >= 0 && value <= 100;
const validPinId = id => validId(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const validNote = text => typeof text === 'string' && text.length <= 4000 && !text.includes('\0');
const validNotes = notes => notes && typeof notes === 'object' && !Array.isArray(notes) && Object.entries(notes).every(([id, text]) => validPinId(id) && validNote(text) && text.trim());
const validMessagePin = pin => pin && validPinId(pin.itemId) && validId(pin.turnId) && typeof pin.preview === 'string' && pin.preview.length > 0 && pin.preview.length <= 200;
const validMessagePins = value => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([threadId, pins]) => validPinId(threadId) && Array.isArray(pins) && pins.length <= 50 && pins.every(validMessagePin) && new Set(pins.map(pin => pin.itemId)).size === pins.length);
const validCutoffs = values => values && typeof values === 'object' && !Array.isArray(values) && Object.entries(values).every(([projectId, cutoff]) => validId(projectId) && validCutoff(cutoff));
const validShortcuts = values => Array.isArray(values) && values.length <= 50 && new Set(values.map(value => value?.id)).size === values.length && values.every(value => validId(value?.id) && typeof value.label === 'string' && value.label.trim() && value.label.length <= 32 && typeof value.prompt === 'string' && value.prompt.trim() && value.prompt.length <= 20000 && (value.mode === undefined || ['send', 'fill'].includes(value.mode)));

class PreferencesStore {
  constructor(file) { this.file = file; this.finishedRuns = new Set(); }

  read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return { theme: 'system', startupProjects: {} };
      throw error;
    }
    if (!themes.has(data?.theme) || !data.startupProjects || typeof data.startupProjects !== 'object' || Array.isArray(data.startupProjects) || Object.entries(data.startupProjects).some(([machine, id]) => !machine.startsWith('access:') || typeof id !== 'string' || !id)) throw new Error('Invalid app preferences.');
    if (data.conversationStates !== undefined && (!data.conversationStates || typeof data.conversationStates !== 'object' || Array.isArray(data.conversationStates) || Object.entries(data.conversationStates).some(([machine, value]) => !machine.startsWith('access:') || !validConversationState(value)))) throw new Error('Invalid saved conversation markers.');
    if (data.activeRuns !== undefined && !validActiveRuns(data.activeRuns)) throw new Error('Invalid saved active runs.');
    if (data.conversationNotes !== undefined && (!data.conversationNotes || typeof data.conversationNotes !== 'object' || Array.isArray(data.conversationNotes) || Object.entries(data.conversationNotes).some(([machine, notes]) => !machine.startsWith('access:') || !validNotes(notes)))) throw new Error('Invalid saved conversation notes.');
    if (data.finishedThreads !== undefined && (!data.finishedThreads || typeof data.finishedThreads !== 'object' || Array.isArray(data.finishedThreads) || Object.entries(data.finishedThreads).some(([machine, ids]) => !machine.startsWith('access:') || !Array.isArray(ids) || !ids.every(validId)))) throw new Error('Invalid saved finished conversations.');
    if (data.threadOrders !== undefined && (!data.threadOrders || typeof data.threadOrders !== 'object' || Array.isArray(data.threadOrders) || Object.entries(data.threadOrders).some(([machine, value]) => !machine.startsWith('access:') || !validOrders(value)))) throw new Error('Invalid saved conversation order.');
    if (data.threadOrderCutoffs !== undefined && (!data.threadOrderCutoffs || typeof data.threadOrderCutoffs !== 'object' || Array.isArray(data.threadOrderCutoffs) || Object.entries(data.threadOrderCutoffs).some(([machine, value]) => !machine.startsWith('access:') || !validCutoffs(value)))) throw new Error('Invalid saved conversation cutoff.');
    if (data.fileOpener !== undefined && !fileOpeners.has(data.fileOpener)) throw new Error('Invalid saved file opener.');
    if (data.shortcuts !== undefined && !validShortcuts(data.shortcuts)) throw new Error('Invalid saved prompt shortcuts.');
    if (data.completionSound !== undefined && typeof data.completionSound !== 'boolean') throw new Error('Invalid completion sound preference.');
    if (data.skipTestDiffs !== undefined && typeof data.skipTestDiffs !== 'boolean') throw new Error('Invalid test diff preference.');
    if (data.completionVolume !== undefined && !validVolume(data.completionVolume)) throw new Error('Invalid completion volume.');
    if (data.messagePins !== undefined && (!data.messagePins || typeof data.messagePins !== 'object' || Array.isArray(data.messagePins) || Object.entries(data.messagePins).some(([machine, value]) => !machine.startsWith('access:') || !validMessagePins(value)))) throw new Error('Invalid saved message pins.');
    return data;
  }

  recordRun(machine, threadId, turnId, provider = 'codex') {
    if (typeof machine !== 'string' || !validPinId(threadId) || !validId(turnId) || !validActiveRuns({ [machine]: { [threadId]: { turnId, provider } } })) throw new Error('Invalid active run.');
    const key = JSON.stringify([machine, provider, threadId, turnId]);
    if (this.finishedRuns.has(key)) return false;
    const next = this.read(), previous = next.activeRuns?.[machine]?.[threadId];
    if (previous?.turnId === turnId && previous.provider === provider) return false;
    next.activeRuns = { ...next.activeRuns, [machine]: { ...next.activeRuns?.[machine], [threadId]: { turnId, provider } } };
    if (next.conversationStates?.[machine]) delete next.conversationStates[machine].completions[threadId];
    this.write(next); return true;
  }

  finishRun(machine, threadId, turnId, provider = 'codex') {
    if (typeof machine !== 'string' || !validPinId(threadId) || !validId(turnId) || !validActiveRuns({ [machine]: { [threadId]: { turnId, provider } } })) throw new Error('Invalid active run.');
    const key = JSON.stringify([machine, provider, threadId, turnId]);
    this.finishedRuns.add(key);
    if (this.finishedRuns.size > 1000) this.finishedRuns.delete(this.finishedRuns.values().next().value);
    const next = this.read(), run = next.activeRuns?.[machine]?.[threadId];
    if (!run || run.turnId !== turnId || run.provider !== provider) return false;
    delete next.activeRuns[machine][threadId];
    if (!Object.keys(next.activeRuns[machine]).length) delete next.activeRuns[machine];
    if (!Object.keys(next.activeRuns).length) delete next.activeRuns;
    this.write(next); return true;
  }

  recoverInterruptedRuns() {
    const next = this.read(), recovered = [];
    for (const [machine, runs] of Object.entries(next.activeRuns || {})) for (const [threadId, run] of Object.entries(runs)) {
      next.conversationStates ||= {};
      const markers = next.conversationStates[machine] ||= { unread: [], completions: {} };
      markers.completions[threadId] = 'interrupted';
      recovered.push({ machine, threadId, ...run });
    }
    if (recovered.length) { delete next.activeRuns; this.write(next); }
    return recovered;
  }

  write(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return next;
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['theme', 'startupProject', 'conversationState', 'threadOrder', 'fileOpener', 'shortcuts', 'completionSound', 'completionVolume', 'messagePin', 'skipTestDiffs', 'finishedThread', 'conversationNote'].includes(key))) throw new Error('Invalid preferences change.');
    const next = this.read();
    if ('conversationNote' in patch) {
      const value = patch.conversationNote;
      if (typeof value?.machine !== 'string' || !value.machine.startsWith('access:') || value.machine.length > 300 || !validPinId(value.threadId) || !validNote(value.text) || value.expected !== undefined && !validNote(value.expected)) throw new Error('Invalid conversation note.');
      const notes = { ...next.conversationNotes?.[value.machine] };
      const text = value.text.trim();
      if (text) notes[value.threadId] = text; else delete notes[value.threadId];
      next.conversationNotes = { ...next.conversationNotes, [value.machine]: notes };
    }
    if ('finishedThread' in patch) {
      const value = patch.finishedThread;
      if (typeof value?.machine !== 'string' || !value.machine.startsWith('access:') || value.machine.length > 300 || !validId(value.threadId) || typeof value.finished !== 'boolean') throw new Error('Invalid finished conversation.');
      const ids = new Set(next.finishedThreads?.[value.machine] || []);
      if (value.finished) ids.add(value.threadId); else ids.delete(value.threadId);
      next.finishedThreads = { ...next.finishedThreads, [value.machine]: [...ids] };
    }
    if ('messagePin' in patch) {
      const value = patch.messagePin;
      if (typeof value?.machine !== 'string' || !value.machine.startsWith('access:') || value.machine.length > 300 || !validPinId(value.threadId) || !validPinId(value.itemId) || typeof value.pinned !== 'boolean' || value.pinned && !validMessagePin(value)) throw new Error('Invalid message pin.');
      next.messagePins ||= {};
      const threads = next.messagePins[value.machine] || {};
      const pins = (threads[value.threadId] || []).filter(pin => pin.itemId !== value.itemId);
      if (value.pinned) pins.push({ itemId: value.itemId, turnId: value.turnId, preview: value.preview });
      if (pins.length > 50) throw new Error('Pin up to 50 messages per conversation.');
      next.messagePins[value.machine] = { ...threads, [value.threadId]: pins };
      if (!pins.length) delete next.messagePins[value.machine][value.threadId];
    }
    if ('completionSound' in patch) {
      if (typeof patch.completionSound !== 'boolean') throw new Error('Invalid completion sound preference.');
      next.completionSound = patch.completionSound;
    }
    if ('skipTestDiffs' in patch) {
      if (typeof patch.skipTestDiffs !== 'boolean') throw new Error('Invalid test diff preference.');
      next.skipTestDiffs = patch.skipTestDiffs;
    }
    if ('completionVolume' in patch) {
      if (!validVolume(patch.completionVolume)) throw new Error('Invalid completion volume.');
      next.completionVolume = patch.completionVolume;
    }
    if ('shortcuts' in patch) {
      if (!validShortcuts(patch.shortcuts)) throw new Error('Invalid prompt shortcuts.');
      next.shortcuts = patch.shortcuts.map(({ id, label, prompt, mode }) => ({ id, label: label.trim(), prompt, ...(mode === undefined ? {} : { mode }) }));
    }
    if ('fileOpener' in patch) {
      if (!fileOpeners.has(patch.fileOpener)) throw new Error('Unknown file opener.');
      next.fileOpener = patch.fileOpener;
    }
    if ('theme' in patch) {
      if (!themes.has(patch.theme)) throw new Error('Unknown theme.');
      next.theme = patch.theme;
    }
    if ('startupProject' in patch) {
      const { machine, projectId } = patch.startupProject || {};
      if (typeof machine !== 'string' || !machine.startsWith('access:') || machine.length > 300 || projectId !== null && (typeof projectId !== 'string' || !projectId || projectId.length > 200)) throw new Error('Invalid startup project.');
      if (projectId === null) delete next.startupProjects[machine]; else next.startupProjects[machine] = projectId;
    }
    if ('conversationState' in patch) {
      const value = patch.conversationState;
      if (typeof value?.machine !== 'string' || !value.machine.startsWith('access:') || value.machine.length > 300 || !validConversationState(value)) throw new Error('Invalid conversation markers.');
      next.conversationStates ||= {};
      next.conversationStates[value.machine] = { unread: [...new Set(value.unread)], completions: { ...value.completions } };
    }
    if ('threadOrder' in patch) {
      const value = patch.threadOrder;
      if (typeof value?.machine !== 'string' || !value.machine.startsWith('access:') || value.machine.length > 300 || !validId(value.projectId) || value.ids !== undefined && (!Array.isArray(value.ids) || !value.ids.every(validId)) || value.cutoff !== undefined && !validCutoff(value.cutoff) || value.ids === undefined && value.cutoff === undefined) throw new Error('Invalid conversation order.');
      if (value.ids !== undefined) {
        next.threadOrders ||= {};
        next.threadOrders[value.machine] = { ...next.threadOrders[value.machine], [value.projectId]: [...new Set(value.ids)] };
      }
      if (value.cutoff !== undefined) {
        next.threadOrderCutoffs ||= {};
        const previous = next.threadOrderCutoffs[value.machine]?.[value.projectId];
        next.threadOrderCutoffs[value.machine] = { ...next.threadOrderCutoffs[value.machine], [value.projectId]: value.ids === undefined && previous !== undefined ? previous : value.cutoff };
      }
    }
    return this.write(next);
  }
}

module.exports = { PreferencesStore };

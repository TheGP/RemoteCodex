const fs = require('node:fs');
const path = require('node:path');

const themes = new Set(['system', 'light', 'dark', 'purple', 'claude-code', 'nord', 'midnight']);
const fileOpeners = new Set(['vscode', 'antigravity', 'gitferry', 'reveal']);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const validConversationState = data => data && Array.isArray(data.unread) && data.unread.every(validId) && data.completions && typeof data.completions === 'object' && !Array.isArray(data.completions) && Object.entries(data.completions).every(([id, status]) => validId(id) && ['completed', 'failed'].includes(status));
const validOrders = orders => orders && typeof orders === 'object' && !Array.isArray(orders) && Object.entries(orders).every(([projectId, ids]) => validId(projectId) && Array.isArray(ids) && ids.every(validId));
const validCutoff = value => Number.isSafeInteger(value) && value >= 0;
const validVolume = value => Number.isInteger(value) && value >= 0 && value <= 100;
const validPinId = id => validId(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const validMessagePin = pin => pin && validPinId(pin.itemId) && validId(pin.turnId) && typeof pin.preview === 'string' && pin.preview.length > 0 && pin.preview.length <= 200;
const validMessagePins = value => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([threadId, pins]) => validPinId(threadId) && Array.isArray(pins) && pins.length <= 50 && pins.every(validMessagePin) && new Set(pins.map(pin => pin.itemId)).size === pins.length);
const validCutoffs = values => values && typeof values === 'object' && !Array.isArray(values) && Object.entries(values).every(([projectId, cutoff]) => validId(projectId) && validCutoff(cutoff));
const validShortcuts = values => Array.isArray(values) && values.length <= 50 && new Set(values.map(value => value?.id)).size === values.length && values.every(value => validId(value?.id) && typeof value.label === 'string' && value.label.trim() && value.label.length <= 32 && typeof value.prompt === 'string' && value.prompt.trim() && value.prompt.length <= 20000 && (value.mode === undefined || ['send', 'fill'].includes(value.mode)));

class PreferencesStore {
  constructor(file) { this.file = file; }

  read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return { theme: 'system', startupProjects: {} };
      throw error;
    }
    if (!themes.has(data?.theme) || !data.startupProjects || typeof data.startupProjects !== 'object' || Array.isArray(data.startupProjects) || Object.entries(data.startupProjects).some(([machine, id]) => !machine.startsWith('access:') || typeof id !== 'string' || !id)) throw new Error('Invalid app preferences.');
    if (data.conversationStates !== undefined && (!data.conversationStates || typeof data.conversationStates !== 'object' || Array.isArray(data.conversationStates) || Object.entries(data.conversationStates).some(([machine, value]) => !machine.startsWith('access:') || !validConversationState(value)))) throw new Error('Invalid saved conversation markers.');
    if (data.threadOrders !== undefined && (!data.threadOrders || typeof data.threadOrders !== 'object' || Array.isArray(data.threadOrders) || Object.entries(data.threadOrders).some(([machine, value]) => !machine.startsWith('access:') || !validOrders(value)))) throw new Error('Invalid saved conversation order.');
    if (data.threadOrderCutoffs !== undefined && (!data.threadOrderCutoffs || typeof data.threadOrderCutoffs !== 'object' || Array.isArray(data.threadOrderCutoffs) || Object.entries(data.threadOrderCutoffs).some(([machine, value]) => !machine.startsWith('access:') || !validCutoffs(value)))) throw new Error('Invalid saved conversation cutoff.');
    if (data.fileOpener !== undefined && !fileOpeners.has(data.fileOpener)) throw new Error('Invalid saved file opener.');
    if (data.shortcuts !== undefined && !validShortcuts(data.shortcuts)) throw new Error('Invalid saved prompt shortcuts.');
    if (data.completionSound !== undefined && typeof data.completionSound !== 'boolean') throw new Error('Invalid completion sound preference.');
    if (data.completionVolume !== undefined && !validVolume(data.completionVolume)) throw new Error('Invalid completion volume.');
    if (data.messagePins !== undefined && (!data.messagePins || typeof data.messagePins !== 'object' || Array.isArray(data.messagePins) || Object.entries(data.messagePins).some(([machine, value]) => !machine.startsWith('access:') || !validMessagePins(value)))) throw new Error('Invalid saved message pins.');
    return data;
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['theme', 'startupProject', 'conversationState', 'threadOrder', 'fileOpener', 'shortcuts', 'completionSound', 'completionVolume', 'messagePin'].includes(key))) throw new Error('Invalid preferences change.');
    const next = this.read();
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return next;
  }
}

module.exports = { PreferencesStore };

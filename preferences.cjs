const fs = require('node:fs');
const path = require('node:path');

const themes = new Set(['system', 'light', 'dark', 'purple', 'claude-code', 'nord', 'midnight']);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const validConversationState = data => data && Array.isArray(data.unread) && data.unread.every(validId) && data.completions && typeof data.completions === 'object' && !Array.isArray(data.completions) && Object.entries(data.completions).every(([id, status]) => validId(id) && ['completed', 'failed'].includes(status));
const validOrders = orders => orders && typeof orders === 'object' && !Array.isArray(orders) && Object.entries(orders).every(([projectId, ids]) => validId(projectId) && Array.isArray(ids) && ids.every(validId));

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
    return data;
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['theme', 'startupProject', 'conversationState', 'threadOrder'].includes(key))) throw new Error('Invalid preferences change.');
    const next = this.read();
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
      if (typeof value?.machine !== 'string' || !value.machine.startsWith('access:') || value.machine.length > 300 || !validId(value.projectId) || !Array.isArray(value.ids) || !value.ids.every(validId)) throw new Error('Invalid conversation order.');
      next.threadOrders ||= {};
      next.threadOrders[value.machine] = { ...next.threadOrders[value.machine], [value.projectId]: [...new Set(value.ids)] };
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return next;
  }
}

module.exports = { PreferencesStore };

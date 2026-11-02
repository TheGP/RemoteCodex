const fs = require('node:fs');
const path = require('node:path');

const themes = new Set(['system', 'light', 'dark', 'purple', 'claude-code', 'nord', 'midnight']);

class PreferencesStore {
  constructor(file) { this.file = file; }

  read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return { theme: 'system', startupProjects: {} };
      throw error;
    }
    if (!themes.has(data?.theme) || !data.startupProjects || typeof data.startupProjects !== 'object' || Array.isArray(data.startupProjects) || Object.entries(data.startupProjects).some(([machine, id]) => !machine.startsWith('access:') || typeof id !== 'string' || !id)) throw new Error('Invalid app preferences.');
    return data;
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['theme', 'startupProject'].includes(key))) throw new Error('Invalid preferences change.');
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return next;
  }
}

module.exports = { PreferencesStore };

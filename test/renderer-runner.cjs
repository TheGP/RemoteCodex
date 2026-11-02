const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(app.getPath('temp'), 'remote-codex-renderer-tests'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    for (const result of await require('./renderer.cjs')()) console.log('PASS', result);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});

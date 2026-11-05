const test = require('node:test');
const assert = require('node:assert/strict');
const { readImage } = require('../images.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
function fixture(bytes = png) {
  const calls = [];
  const connection = { ready: true, child: {}, call: async (method, params) => { calls.push({ method, params }); return { dataBase64: bytes.toString('base64') }; } };
  return { calls, connection };
}

test('image reads use the connected Codex filesystem and identify raster contents', async () => {
  for (const [bytes, mime] of [[png, 'png'], [Buffer.from([255, 216, 255, 224]), 'jpeg'], [Buffer.from('GIF89a'), 'gif'], [Buffer.from('RIFF0000WEBP'), 'webp']]) {
    const { connection, calls } = fixture(bytes);
    assert.match(await readImage(connection, '/tmp/screenshots/../preview.png'), new RegExp(`^data:image/${mime};base64,`));
    assert.deepEqual(calls, [{ method: 'fs/readFile', params: { path: '/tmp/preview.png' } }]);
  }
  const { connection, calls } = fixture();
  await readImage(connection, 'C:\\work\\preview.png');
  assert.equal(calls[0].params.path, 'C:\\work\\preview.png');
});

test('image reads reject non-image paths and active content without returning file contents', async () => {
  const { connection, calls } = fixture();
  for (const file of ['relative.png', '/tmp/key.txt', '/tmp/script.svg', 'https://example.com/a.png', '//server/share/a.png', '\\\\server\\a.png', '/tmp/a\0.png']) await assert.rejects(readImage(connection, file));
  assert.equal(calls.length, 0);
  await assert.rejects(readImage(fixture(Buffer.from('<html>secret</html>')).connection, '/tmp/fake.png'), /not a supported image/);
  await assert.rejects(readImage(fixture(Buffer.from('<svg onload="alert(1)">')).connection, '/tmp/fake.png'), /not a supported image/);
});

test('oversized, corrupt, missing, and disconnected images fail safely', async () => {
  const { connection } = fixture();
  connection.call = async () => ({ dataBase64: 'A'.repeat(28 * 1024 * 1024) });
  await assert.rejects(readImage(connection, '/tmp/large.png'), /20 MB/);
  connection.call = async () => ({ dataBase64: 'not base64!' });
  await assert.rejects(readImage(connection, '/tmp/corrupt.png'), /invalid/);
  connection.call = async () => { throw new Error('File not found'); };
  await assert.rejects(readImage(connection, '/tmp/missing.png'), /not found/);
  connection.call = async () => { connection.child = {}; return { dataBase64: png.toString('base64') }; };
  await assert.rejects(readImage(connection, '/tmp/stale.png'), /connection changed/);
  connection.ready = false;
  await assert.rejects(readImage(connection, '/tmp/offline.png'), /Connect to Codex/);
});

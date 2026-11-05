const path = require('node:path');

async function readImage(connection, file) {
  if (typeof file !== 'string' || file.length > 8192 || file.includes('\0') || !/\.(png|jpe?g|webp|gif)$/i.test(file) || !file.startsWith('/') && !/^[a-z]:[\\/]/i.test(file) || /^[\\/]{2}/.test(file)) throw new Error('Use a PNG, JPEG, WebP, or GIF path on the connected machine.');
  if (!connection.ready) throw new Error('Connect to Codex to load this image.');
  const child = connection.child;
  const filePath = /^[a-z]:/i.test(file) ? path.win32.normalize(file) : path.posix.normalize(file);
  const result = await connection.call('fs/readFile', { path: filePath });
  if (!connection.ready || connection.child !== child) throw new Error('The image connection changed.');
  const data = result.dataBase64;
  if (typeof data !== 'string' || !data.length || data.length % 4 || data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Image is invalid or exceeds 20 MB.');
  const bytes = Buffer.from(data, 'base64');
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  if (!mime) throw new Error('This file is not a supported image.');
  return `data:${mime};base64,${data}`;
}

module.exports = { readImage };

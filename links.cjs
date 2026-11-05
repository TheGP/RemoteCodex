async function openWebLink(value, openExternal) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid link.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Use a complete HTTP or HTTPS link.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can open in the browser.');
  await openExternal(url.href);
}

module.exports = { openWebLink };

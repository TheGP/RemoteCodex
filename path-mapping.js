function mapProjectPath(file, mapping) {
  if (typeof file !== 'string' || !mapping?.root || !Array.isArray(mapping.roots)) return file;
  const normalize = value => {
    const input = value.replace(/\\/g, '/');
    if (!input.startsWith('/') && !/^[a-z]:\//i.test(input) || input.startsWith('//')) return null;
    const prefix = input.startsWith('/') ? '/' : input.slice(0, 3);
    const parts = [];
    for (const part of input.slice(prefix.length).split('/')) {
      if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    }
    return prefix + parts.join('/');
  };
  const target = normalize(file), root = normalize(mapping.root);
  if (!target || !root) return file;
  const relative = (file, base) => {
    const windows = /^[a-z]:\//i.test(base);
    const match = windows ? file.toLowerCase() : file;
    const prefix = (windows ? base.toLowerCase() : base).replace(/\/$/, '');
    return match === prefix ? '' : match.startsWith(prefix + '/') ? file.slice(prefix.length + 1) : null;
  };
  if (relative(target, root) !== null) return file;
  for (const source of mapping.roots.map(normalize).filter(Boolean).sort((a, b) => b.length - a.length)) {
    const suffix = relative(target, source);
    if (suffix !== null) {
      const mapped = root.replace(/\/$/, '') + (suffix ? '/' + suffix : '');
      return /^[a-z]:\\/i.test(mapping.root) ? mapped.replace(/\//g, '\\') : mapped;
    }
  }
  return file;
}
if (typeof module !== 'undefined') module.exports = { mapProjectPath };

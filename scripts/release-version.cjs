const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function releaseVersion(tags, headTags, baseVersion) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(baseVersion)) throw new Error('Expected a stable base version.');
  const prefix = baseVersion.slice(0, baseVersion.lastIndexOf('.') + 1);
  const patch = tag => {
    if (!tag.startsWith('v' + prefix)) return null;
    const value = tag.slice(prefix.length + 1);
    if (!/^(0|[1-9]\d*)$/.test(value)) return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('Release patch number is too large.');
    return number;
  };
  const current = headTags.map(patch).filter(value => value !== null);
  const previous = tags.map(patch).filter(value => value !== null);
  const next = current.length ? Math.max(...current) : Math.max(Number(baseVersion.split('.').at(-1)), ...previous.map(value => value + 1));
  if (!Number.isSafeInteger(next)) throw new Error('Release patch number is too large.');
  const version = prefix + next;
  return { version, tag: 'v' + version };
}

if (require.main === module) {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const release = releaseVersion(git(['tag', '--list']), git(['tag', '--points-at', 'HEAD']), require('../package.json').version);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${release.version}\ntag=${release.tag}\n`);
  console.log(JSON.stringify(release));
}

module.exports = { releaseVersion };

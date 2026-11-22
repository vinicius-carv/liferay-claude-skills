import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseProperties(text) {
  const entries = new Map();
  const seen = new Map();
  const errors = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = i + 1;
    let line = lines[i].replace(/^\s+/, '');
    if (line === '' || line[0] === '#' || line[0] === '!') continue;
    // An odd number of trailing backslashes continues the entry on the next line.
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }
    const m = /^((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/.exec(line);
    if (!m) {
      errors.push({ line: start, message: 'missing key' });
      continue;
    }
    const [, key, value] = m;
    entries.set(key, value);
    seen.set(key, [...(seen.get(key) ?? []), start]);
  }
  const duplicates = [...seen].filter(([, l]) => l.length > 1).map(([key, lines]) => ({ key, lines }));
  return { entries, duplicates, errors };
}

function readProps(file) {
  return existsSync(file) ? parseProperties(readFileSync(file, 'utf8')).entries : new Map();
}

export function readWorkspace(dir) {
  const settings = join(dir, 'settings.gradle');
  const isWorkspace = existsSync(settings) && readFileSync(settings, 'utf8').includes('com.liferay.workspace');
  const props = new Map([...readProps(join(dir, 'gradle.properties')), ...readProps(join(dir, 'gradle-local.properties'))]);
  return {
    isWorkspace,
    product: props.get('liferay.workspace.product'),
    targetPlatformVersion: props.get('liferay.workspace.target.platform.version'),
    environment: props.get('liferay.workspace.environment') || 'local',
  };
}

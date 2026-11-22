import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseProperties, readWorkspace } from '../../../lib/workspace.mjs';

const STR = '"(?:[^"\\\\]|\\\\.)*"';
const SCALAR = new RegExp(`^[TILFDXSCBilfdxscb]?${STR}$`);
const ARRAY = new RegExp(`^[TILFDXSCBilfdxscb]?\\[\\s*(?:${STR}(?:\\s*,\\s*${STR})*)?\\s*\\]$`);

export function parseConfigFile(text) {
  const values = {};
  const errors = [];
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line[0] === '#') return;
    const m = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return errors.push({ line: i + 1, message: 'expected key=value' });
    const v = m[2];
    if (SCALAR.test(v) || ARRAY.test(v)) values[m[1]] = v;
    else errors.push({ line: i + 1, message: `value must be quoted: ${m[1]}` });
  });
  return { values, errors };
}

export function checkConfigFileName(name) {
  if (/\.cfg$/.test(name)) return { kind: 'cfg', pid: name.slice(0, -4) };
  const m = /^([\w.$~-]+)\.config$/.exec(name);
  if (!m) return { kind: 'invalid' };
  const base = m[1];
  if (/^[\w.$]+$/.test(base)) return { kind: 'single', pid: base };
  const tilde = base.indexOf('~');
  if (tilde > 0) return { kind: 'factory', pid: base.slice(0, tilde) };
  const dash = base.indexOf('-');
  if (dash > 0 && base.slice(0, dash).includes('.')) return { kind: 'legacy-factory', pid: base.slice(0, dash) };
  return { kind: 'invalid' };
}

const DEFAULT_PORTS = { mysql: 3306, postgresql: 5432, mariadb: 3306, sqlserver: 1433, oracle: 1521 };

function defaultProbe(host, port) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 2000 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });
}

export async function checkWorkspace(dir, { env, probe = defaultProbe } = {}) {
  const findings = [];
  const add = (severity, file, message, line) => findings.push({ severity, file, message, ...(line && { line }) });
  const rel = (p) => relative(dir, p) || '.';
  const ws = readWorkspace(dir);
  if (!ws.isWorkspace) {
    add('error', 'settings.gradle', 'not a Liferay workspace (settings.gradle missing com.liferay.workspace)');
    return findings;
  }
  env ??= ws.environment;
  const common = join(dir, 'configs', 'common');
  const envDir = join(dir, 'configs', env);
  for (const d of [common, envDir]) if (!existsSync(d)) add('warn', rel(d), 'directory missing');

  const files = [
    join(common, 'portal-ext.properties'),
    join(envDir, 'portal-ext.properties'),
    join(dir, 'bundles', 'portal-ext.properties'),
    join(dir, 'bundles', 'portal-setup-wizard.properties'),
  ].filter(existsSync);
  const effective = new Map();
  for (const f of files) {
    const p = parseProperties(readFileSync(f, 'utf8'));
    for (const d of p.duplicates) add('warn', rel(f), `duplicate key ${d.key} (lines ${d.lines.join(', ')})`, d.lines[0]);
    for (const e of p.errors) add('error', rel(f), e.message, e.line);
    // Only configs/ files take part in env-over-common precedence.
    if (f.startsWith(join(dir, 'configs'))) for (const [k, v] of p.entries) effective.set(k, v);
  }

  const url = effective.get('jdbc.default.url');
  if (!url) {
    add('info', 'configs', 'no jdbc.default.url: embedded HSQL — fine for dev, not for shared data');
  } else {
    const m = /^jdbc:(\w+):.*?\/\/([^:/;?]+)(?::(\d+))?/.exec(url);
    const port = m && (m[3] ? Number(m[3]) : DEFAULT_PORTS[m[1]]);
    if (port && !(await probe(m[2], port))) add('error', 'configs', `database unreachable at ${m[2]}:${port}`);
  }

  if (effective.get('module.framework.properties.osgi.console')?.trim() === '') {
    add('warn', 'configs', 'Gogo disabled; bundle health check will be unverified');
  }

  const configsDir = join(dir, 'configs');
  for (const sub of existsSync(configsDir) ? readdirSync(configsDir) : []) {
    const osgi = join(configsDir, sub, 'osgi', 'configs');
    if (!existsSync(osgi)) continue;
    for (const ent of readdirSync(osgi, { withFileTypes: true })) {
      if (!ent.isFile() || ent.name.startsWith('.')) continue;
      const name = ent.name;
      const f = join(osgi, name);
      const { kind } = checkConfigFileName(name);
      if (kind === 'invalid') add('error', rel(f), 'invalid configuration file name');
      else if (kind === 'legacy-factory') add('info', rel(f), 'legacy factory name (use pid~name)');
      else if (kind === 'cfg') add('info', rel(f), 'untyped .cfg file (values are all strings)');
      if (kind === 'cfg') continue;
      for (const e of parseConfigFile(readFileSync(f, 'utf8')).errors) add('error', rel(f), e.message, e.line);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const ei = args.indexOf('--env');
  const env = ei >= 0 ? args[ei + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith('--') && (ei < 0 || i !== ei + 1));
  if (!dir) {
    console.error('usage: check-config.mjs <workspace> [--env <name>] [--json]');
    process.exit(2);
  }
  const findings = await checkWorkspace(dir, { env });
  if (args.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else {
    for (const sev of ['error', 'warn', 'info']) {
      for (const f of findings.filter((x) => x.severity === sev)) {
        console.log(`${sev.toUpperCase().padEnd(5)} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`);
      }
    }
    if (!findings.length) console.log('OK no findings');
  }
  process.exit(findings.some((f) => f.severity === 'error') ? 1 : 0);
}

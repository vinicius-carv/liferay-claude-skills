#!/usr/bin/env node
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseLb(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\|\s*(\w+)\s*\|\s*(\d+)\|\s*(.+?)\s*(?:\(.*\))?\s*$/.exec(line);
    if (m) rows.push({ id: +m[1], state: m[2], level: +m[3], name: m[4] });
  }
  return rows;
}

export function parseManifestBsn(text) {
  const unwrapped = text.replace(/\r?\n /g, '');
  const m = /^Bundle-SymbolicName:\s*([^;\r\n]+)/m.exec(unwrapped);
  return m ? m[1].trim() : null;
}

const jarBin = () => (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jar') : 'jar');

function findJars(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findJars(p, out);
    else if (e.name.endsWith('.jar') && dir.endsWith(join('build', 'libs'))) out.push(p);
  }
  return out;
}

export function workspaceBundles(dir) {
  const names = [];
  const tmp = mkdtempSync(join(tmpdir(), 'bsn-'));
  try {
    for (const jar of findJars(join(dir, 'modules'))) {
      execFileSync(jarBin(), ['xf', jar, 'META-INF/MANIFEST.MF'], { cwd: tmp });
      const bsn = parseManifestBsn(readFileSync(join(tmp, 'META-INF', 'MANIFEST.MF'), 'utf8'));
      if (bsn) names.push(bsn);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const unchecked = ['client-extensions', 'themes', 'wars'].filter((d) => existsSync(join(dir, d)));
  return { names, unchecked };
}

const PROMPT = 'g! ';
// shortcut: IAC options are dropped as 0xFF + 2 bytes (no subnegotiation), fine for Gogo's telnet handshake.
const stripIac = (b) => { const o = []; for (let i = 0; i < b.length; i++) { if (b[i] === 0xff) i += 2; else o.push(b[i]); } return Buffer.from(o).toString('utf8'); };

export function gogo(commands, { host = 'localhost', port = 11311, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const outputs = [];
    let raw = Buffer.alloc(0), stage = -1; // -1 = waiting for the welcome prompt
    const fail = (cause) => { sock.destroy(); reject(Object.assign(new Error(`Gogo unreachable at ${host}:${port}: ${cause.message ?? cause}`), { code: 'GOGO_UNREACHABLE' })); };
    sock.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    sock.on('error', fail);
    sock.on('close', () => stage >= commands.length && resolve(outputs)); // wait for close so disconnect is flushed
    sock.on('data', (d) => {
      raw = Buffer.concat([raw, d]);
      const text = stripIac(raw);
      if (!text.endsWith(PROMPT)) return;
      raw = Buffer.alloc(0);
      if (stage >= 0) outputs.push(text.slice(0, -PROMPT.length));
      stage++;
      if (stage < commands.length) sock.write(commands[stage] + '\r\n');
      else { sock.write('disconnect\r\n'); sock.end(); }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '.';
  const { names, unchecked } = workspaceBundles(dir);
  const conn = { host: opt('--host', 'localhost'), port: +opt('--port', 11311) };
  let lb;
  try { [lb] = await gogo(['lb -s'], conn); } catch (e) {
    console.error(`${e.message}\nEnable the Gogo console via module.framework.properties.osgi.console=localhost:11311 in portal-ext.properties (or gradle-local.properties).`);
    process.exit(2);
  }
  const byName = new Map(parseLb(lb).map((r) => [r.name, r]));
  const rows = names.map((n) => byName.get(n) ?? { id: null, state: 'missing', name: n });
  const bad = rows.filter((r) => r.state !== 'Active');
  for (const r of rows) console.log(`${String(r.id ?? '-').padStart(6)}  ${r.state.padEnd(10)}  ${r.name}`);
  if (bad.some((r) => r.id != null)) {
    const diags = await gogo(bad.filter((r) => r.id != null).map((r) => `diag ${r.id}`), conn);
    console.log('\n' + diags.join('\n'));
  }
  if (unchecked.length) console.log(`\nNot checked (no jar bundle names): ${unchecked.join(', ')}`);
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

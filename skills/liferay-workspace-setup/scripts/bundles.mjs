#!/usr/bin/env node
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseLb(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\|\s*(\w+)\s*\|\s*(\d+)\|\s*(.+?)\s*(?:\([^)|]*\))?\s*(?:\|.*)?$/.exec(line);
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
    if (e.isDirectory()) { if (e.name !== 'node_modules') findJars(p, out); }
    else if (e.name.endsWith('.jar') && dir.endsWith(join('build', 'libs'))) out.push(p);
  }
  return out;
}

export function workspaceBundles(dir) {
  const names = [], fragments = [];
  for (const jar of findJars(join(dir, 'modules'))) {
    const tmp = mkdtempSync(join(tmpdir(), 'bsn-')); // fresh dir per jar: no stale manifest
    try {
      execFileSync(jarBin(), ['xf', resolve(jar), 'META-INF/MANIFEST.MF'], { cwd: tmp });
      const mf = join(tmp, 'META-INF', 'MANIFEST.MF');
      if (!existsSync(mf)) continue;
      const text = readFileSync(mf, 'utf8');
      const bsn = parseManifestBsn(text);
      if (!bsn) continue;
      names.push(bsn);
      if (/^Fragment-Host:/m.test(text)) fragments.push(bsn);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  const unchecked = ['client-extensions', 'themes', 'wars'].filter((d) => existsSync(join(dir, d)));
  return { names, fragments, unchecked };
}

const PROMPT = 'g! ';
// Telnet: drop IAC commands (IAC cmd opt) and subnegotiations (IAC SB ... IAC SE); keep the rest as text.
const stripIac = (b) => {
  const o = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0xff) { o.push(b[i]); continue; }
    if (b[i + 1] === 0xfa) { i += 2; while (i < b.length && !(b[i] === 0xff && b[i + 1] === 0xf0)) i++; i++; } // SB ... IAC SE
    else i += 2;
  }
  return Buffer.from(o).toString('utf8');
};
// Felix Gogo's telnet server prints no prompt until the client answers its TTYPE/NAWS requests.
const negotiate = (b) => {
  const out = [];
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    if (b[i + 1] === 0xfd && b[i + 2] === 0x18) out.push(0xff, 0xfb, 0x18); // DO TTYPE -> WILL TTYPE
    else if (b[i + 1] === 0xfd && b[i + 2] === 0x1f) out.push(0xff, 0xfb, 0x1f, 0xff, 0xfa, 0x1f, 0, 200, 0, 50, 0xff, 0xf0); // DO NAWS -> WILL NAWS + 200x50
    else if (b[i + 1] === 0xfa && b[i + 2] === 0x18) out.push(0xff, 0xfa, 0x18, 0, ...Buffer.from('xterm'), 0xff, 0xf0); // SB TTYPE SEND -> IS xterm
  }
  return Buffer.from(out);
};

const FORBIDDEN = new Set(['exit', 'shutdown', 'stop', 'uninstall', 'update']);

export function gogo(commands, { host = 'localhost', port = 11311, timeoutMs = 15000 } = {}) {
  const bad = commands.find((c) => FORBIDDEN.has(c.trim().split(/\s+/)[0].toLowerCase().replace(/^.*:/, '')));
  if (bad) return Promise.reject(new Error(`refusing to send destructive Gogo command: ${bad}`));
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const outputs = [];
    let raw = Buffer.alloc(0), stage = -1; // -1 = waiting for the welcome prompt
    const fail = (cause) => { sock.destroy(); reject(Object.assign(new Error(`Gogo unreachable at ${host}:${port}: ${cause.message ?? cause}`), { code: 'GOGO_UNREACHABLE' })); };
    sock.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    sock.on('error', fail);
    sock.on('close', () => (stage >= commands.length ? resolve(outputs) : fail(new Error('connection closed early')))); // resolve on close so disconnect is flushed
    sock.on('data', (d) => {
      raw = Buffer.concat([raw, d]);
      const reply = negotiate(d);
      if (reply.length) sock.write(reply);
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
  const { names, fragments, unchecked } = workspaceBundles(dir);
  if (!names.length) {
    console.error('no module jars found under modules/**/build/libs - run a build first');
    process.exit(1);
  }
  const conn = { host: opt('--host', 'localhost'), port: +opt('--port', 11311) };
  const unreachable = (e) => {
    console.error(`${e.message}\nEnable the Gogo console via module.framework.properties.osgi.console=localhost:11311 in configs/local/portal-ext.properties (copy it into the bundle, e.g. via initBundle, then restart).`);
    process.exit(2);
  };
  let lb;
  try { [lb] = await gogo(['lb -s'], conn); } catch (e) { unreachable(e); }
  const byName = new Map(parseLb(lb).map((r) => [r.name, r]));
  const rows = names.map((n) => byName.get(n) ?? { id: null, state: 'missing', name: n });
  // Fragments never start: Resolved is their healthy state.
  const bad = rows.filter((r) => r.state !== 'Active' && !(r.state === 'Resolved' && fragments.includes(r.name)));
  for (const r of rows) console.log(`${String(r.id ?? '-').padStart(6)}  ${r.state.padEnd(10)}  ${r.name}`);
  const diagIds = bad.filter((r) => r.id != null);
  if (diagIds.length) {
    try { console.log('\n' + (await gogo(diagIds.map((r) => `diag ${r.id}`), conn)).join('\n')); } catch (e) { unreachable(e); }
  }
  if (unchecked.length) console.log(`\nNot checked (no jar bundle names): ${unchecked.join(', ')}`);
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLb, parseManifestBsn, workspaceBundles, gogo } from '../skills/liferay-workspace-setup/scripts/bundles.mjs';

const fixture = readFileSync(new URL('./fixtures/lb-s.txt', import.meta.url), 'utf8');

test('parseLb reads real rows incl. fragments and the not-Active module', () => {
  const rows = parseLb(fixture);
  assert.equal(rows.length, 19);
  assert.deepEqual(rows[1], { id: 3, state: 'Active', level: 6, name: 'com.liferay.osgi.util' });
  assert.deepEqual(rows[17], { id: 1624, state: 'Installed', level: 10, name: 'org.acme.broken.api' });
});

test('parseManifestBsn unwraps continuation and strips directives (CRLF)', () => {
  assert.equal(
    parseManifestBsn('Bundle-SymbolicName: com.acme.very.long.na\r\n me.portlet;singleton:=true\r\n'),
    'com.acme.very.long.name.portlet');
  assert.equal(parseManifestBsn('Foo: bar\n'), null);
});

test('workspaceBundles reads jar manifests and lists unchecked folders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundles-'));
  const libs = join(dir, 'modules', 'a', 'build', 'libs');
  mkdirSync(libs, { recursive: true });
  mkdirSync(join(dir, 'themes'));
  writeFileSync(join(dir, 'MANIFEST.MF'), 'Manifest-Version: 1.0\r\nBundle-SymbolicName: com.acme.a;singleton:=true\r\n\r\n');
  const jar = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jar') : 'jar';
  execFileSync(jar, ['cfm', join(libs, 'a.jar'), join(dir, 'MANIFEST.MF')], { cwd: dir });
  assert.deepEqual(workspaceBundles(dir), { names: ['com.acme.a'], fragments: [], unchecked: ['themes'] });
});

test('gogo sends commands, disconnects, never exits', async () => {
  const received = [];
  const server = net.createServer((s) => {
    s.write(Buffer.concat([Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfb, 0x03]), Buffer.from('Welcome\r\ng! ')]));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); received.push(line);
        if (line === 'lb -s') s.write(fixture.replace(/g! $/, '') + 'g! ');
        if (line === 'disconnect') s.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const out = await gogo(['lb -s'], { host: '127.0.0.1', port: server.address().port });
  server.close();
  assert.equal(parseLb(out[0]).length, 19);
  assert.ok(received.includes('disconnect'));
  assert.ok(!received.includes('exit'));
});

test('gogo rejects GOGO_UNREACHABLE on closed port', async () => {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  await assert.rejects(gogo(['lb -s'], { host: '127.0.0.1', port, timeoutMs: 2000 }), { code: 'GOGO_UNREACHABLE' });
});

const jarBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jar') : 'jar';
function mkJar(dir, name, manifest) {
  const libs = join(dir, 'modules', name, 'build', 'libs');
  mkdirSync(libs, { recursive: true });
  if (manifest) {
    writeFileSync(join(dir, name + '.MF'), manifest);
    execFileSync(jarBin, ['cfm', join(libs, name + '.jar'), join(dir, name + '.MF')], { cwd: dir });
  } else {
    writeFileSync(join(dir, 'x.txt'), 'x');
    execFileSync(jarBin, ['cf', join(libs, name + '.jar'), 'x.txt'], { cwd: dir });
  }
}

test('gogo rejects when server closes early', async () => {
  const server = net.createServer((s) => { s.write('g! '); setTimeout(() => s.destroy(), 20); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await assert.rejects(gogo(['lb -s'], { host: '127.0.0.1', port: server.address().port, timeoutMs: 2000 }), { code: 'GOGO_UNREACHABLE' });
  server.close();
});

test('workspaceBundles reports fragments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundles-'));
  mkJar(dir, 'frag', 'Manifest-Version: 1.0\r\nBundle-SymbolicName: com.acme.frag\r\nFragment-Host: com.acme.host\r\n\r\n');
  const r = workspaceBundles(dir);
  assert.deepEqual(r.names, ['com.acme.frag']);
  assert.deepEqual(r.fragments, ['com.acme.frag']);
});

test('workspaceBundles: jar without manifest does not reuse previous name; skips node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundles-'));
  mkJar(dir, 'a', 'Manifest-Version: 1.0\r\nBundle-SymbolicName: com.acme.a\r\n\r\n');
  mkJar(dir, 'b', null);
  mkdirSync(join(dir, 'modules', 'node_modules', 'n', 'build', 'libs'), { recursive: true });
  writeFileSync(join(dir, 'modules', 'node_modules', 'n', 'build', 'libs', 'n.jar'), 'junk');
  assert.deepEqual(workspaceBundles(dir).names, ['com.acme.a']);
});

test('gogo refuses dangerous commands before connecting', async () => {
  for (const c of ['felix:stop 5', 'system:exit', 'EXIT', 'exit', 'shutdown 0', 'stop 5', 'uninstall 5', 'update 5'])
    await assert.rejects(gogo([c], { port: 1 }), /refus/i);
});

test('workspaceBundles accepts a relative workspace dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundles-rel-'));
  const libs = join(dir, 'modules', 'a', 'build', 'libs');
  mkdirSync(libs, { recursive: true });
  writeFileSync(join(dir, 'MANIFEST.MF'), 'Manifest-Version: 1.0\r\nBundle-SymbolicName: com.acme.rel\r\n\r\n');
  const jar = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jar') : 'jar';
  execFileSync(jar, ['cfm', join(libs, 'a.jar'), join(dir, 'MANIFEST.MF')], { cwd: dir });
  const prev = process.cwd();
  process.chdir(dir);
  try { assert.deepEqual(workspaceBundles('.').names, ['com.acme.rel']); } finally { process.chdir(prev); }
});

test('parseLb handles "name (version)|version" rows from a real Gogo', () => {
  const rows = parseLb('    3|Active     |    6|com.liferay.osgi.util (8.1.0)|8.1.0\r\n');
  assert.deepEqual(rows, [{ id: 3, state: 'Active', level: 6, name: 'com.liferay.osgi.util' }]);
});

test('gogo answers telnet TTYPE negotiation before the prompt appears (real Felix Gogo)', async () => {
  const server = net.createServer((s) => {
    s.write(Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfb, 0x03, 0xff, 0xfd, 0x1f, 0xff, 0xfd, 0x18]));
    let sent = false, buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!sent && buf.includes(Buffer.from([0xff, 0xfb, 0x18]))) { // client WILL TTYPE -> ask for it
        sent = true; s.write(Buffer.from([0xff, 0xfa, 0x18, 0x01, 0xff, 0xf0]));
      } else if (sent && buf.includes(Buffer.from([0xff, 0xf0])) && !buf.includes('Welcome')) {
        buf = Buffer.from('Welcome'); s.write('Welcome\r\ng! ');
      }
      if (buf.includes('disconnect')) s.end();
      if (buf.includes('lb -s\r\n')) { buf = Buffer.alloc(0); s.write('1|Active|0|a.b (1.0)|1.0\r\ng! '); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const out = await gogo(['lb -s'], { host: '127.0.0.1', port: server.address().port, timeoutMs: 3000 });
  server.close();
  assert.equal(parseLb(out[0])[0].name, 'a.b');
});

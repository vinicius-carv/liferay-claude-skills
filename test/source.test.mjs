import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXUS, bomUrl, fetchSources, parseBom, resolveRelease, sourcesJarUrl } from '../skills/liferay-source-lookup/scripts/source.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const releases = JSON.parse(fx('releases.json'));
const journal = { groupId: 'com.liferay', artifactId: 'com.liferay.journal.service', version: '7.0.193' };

test('resolveRelease maps release keys', () => {
  const r = resolveRelease(releases, 'dxp-7.4-u92');
  assert.equal(r.targetPlatformVersion, '7.4.13.u92');
  assert.equal(r.product, 'dxp');
  assert.equal(resolveRelease(releases, 'portal-7.4-ga132').product, 'portal');
});

test('resolveRelease unknown key lists similar keys', () => {
  assert.throws(() => resolveRelease(releases, 'dxp-2025.q1.99-lts'), /dxp-2025\.q1\.23-lts/);
});

test('bomUrl', () => {
  assert.equal(bomUrl('dxp', '2025.q1.23'), `${NEXUS}/com/liferay/portal/release.dxp.bom/2025.q1.23/release.dxp.bom-2025.q1.23.pom`);
});

test('parseBom', () => {
  const a = parseBom(fx('bom-sample.pom'));
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { groupId: 'com.liferay.portal', artifactId: 'com.liferay.portal.kernel', version: '188.1.0' });
  assert.equal(a[1].groupId, 'com.liferay');
});

test('sourcesJarUrl', () => {
  assert.equal(sourcesJarUrl(journal), `${NEXUS}/com/liferay/com.liferay.journal.service/7.0.193/com.liferay.journal.service-7.0.193-sources.jar`);
});

test('fetchSources downloads once, then uses cache; 404 rejects', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'lfr-src-'));
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  const extract = (jar, dest) => assert.equal(readFileSync(jar).length, 3) ?? writeFileSync(join(dest, 'x.java'), '');
  const dir = await fetchSources(journal, { cacheDir, fetchImpl, extract });
  assert.equal(dir, join(cacheDir, 'com.liferay.journal.service-7.0.193'));
  assert.ok(existsSync(join(dir, 'x.java')));
  await fetchSources(journal, { cacheDir, fetchImpl, extract });
  assert.equal(calls, 1);
  const nf = async () => ({ ok: false, status: 404 });
  await assert.rejects(fetchSources({ ...journal, version: '1.0.0' }, { cacheDir, fetchImpl: nf, extract }), /no sources jar/);
  assert.ok(!existsSync(join(cacheDir, 'com.liferay.journal.service-1.0.0')));
});

test('network: real release + sources jar', { skip: process.env.LIFERAY_NET_TESTS !== '1', timeout: 300000 }, async () => {
  const all = await (await fetch('https://releases-cdn.liferay.com/releases.json')).json();
  assert.equal(resolveRelease(all, 'dxp-2025.q1.23-lts').targetPlatformVersion, '2025.q1.23');
  const cacheDir = mkdtempSync(join(tmpdir(), 'lfr-net-'));
  const bom = parseBom(await (await fetch(bomUrl('dxp', '2025.q1.23'))).text());
  const kernel = bom.find((a) => a.artifactId === 'com.liferay.portal.kernel');
  const dir = await fetchSources(kernel, { cacheDir });
  assert.ok(existsSync(join(dir, 'com', 'liferay', 'portal', 'kernel', 'model', 'User.java')));
});

test('parseBom keeps ids ending in s and trims whitespace/newlines', () => {
  const xml = `<dependency><groupId>com.liferay</groupId><artifactId>
      com.liferay.foo.options </artifactId><version>
  1.0.0
</version></dependency>`;
  assert.deepEqual(parseBom(xml), [{ groupId: 'com.liferay', artifactId: 'com.liferay.foo.options', version: '1.0.0' }]);
  assert.ok(parseBom(fx('bom-sample.pom')).some((a) => a.artifactId === 'com.liferay.journal.service'));
});

test('fetchSources removes the jar after extraction, also on failure', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'lfr-jar-'));
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer });
  const jar = join(cacheDir, 'com.liferay.journal.service-7.0.193-sources.jar');
  await fetchSources(journal, { cacheDir, fetchImpl, extract: () => {} });
  assert.ok(!existsSync(jar));
  const bad = { ...journal, version: '9.9.9' };
  await assert.rejects(fetchSources(bad, { cacheDir, fetchImpl, extract: () => { throw new Error('boom'); } }), /boom/);
  assert.ok(!existsSync(join(cacheDir, 'com.liferay.journal.service-9.9.9-sources.jar')));
});

test('resolve returns bom url; workspace without version info errors clearly', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const script = new URL('../skills/liferay-source-lookup/scripts/source.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const mk = (props) => {
    const d = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(d, 'settings.gradle'), 'apply plugin: "com.liferay.workspace"\n');
    writeFileSync(join(d, 'gradle.properties'), props);
    return d;
  };
  const ok = spawnSync('node', [script, 'resolve', mk('liferay.workspace.product=dxp-2025.q1.23-lts\nliferay.workspace.target.platform.version=2025.q1.23\n')], { encoding: 'utf8' });
  assert.equal(JSON.parse(ok.stdout).bom, bomUrl('dxp', '2025.q1.23'));
  const bad = spawnSync('node', [script, 'resolve', mk('# nothing\n')], { encoding: 'utf8' });
  assert.match(bad.stderr, /workspace has no liferay\.workspace\.product or liferay\.workspace\.target\.platform\.version; pass --tpv and --product/);
});

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

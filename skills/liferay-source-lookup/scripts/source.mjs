import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWorkspace } from '../../../lib/workspace.mjs';

export const NEXUS = 'https://repository-cdn.liferay.com/nexus/content/groups/public';
const RELEASES = 'https://releases-cdn.liferay.com/releases.json';
const ROOT = join(homedir(), '.liferay-claude');

export function resolveRelease(releases, productKey) {
  const r = releases.find((x) => x.releaseKey === productKey);
  if (!r) {
    const [p, g = ''] = productKey.split('-');
    const prefix = `${p}-${g.split('.').slice(0, 2).join('.')}`; // dxp-2025.q1.99-lts -> dxp-2025.q1
    const similar = releases.map((x) => x.releaseKey).filter((k) => k.startsWith(prefix)).slice(0, 5);
    throw new Error(`unknown release ${productKey}; similar: ${similar.join(', ') || 'none'}`);
  }
  return { product: r.product, releaseKey: r.releaseKey, targetPlatformVersion: r.targetPlatformVersion };
}

export const bomUrl = (product, tpv) => `${NEXUS}/com/liferay/portal/release.${product}.bom/${tpv}/release.${product}.bom-${tpv}.pom`;

export function parseBom(xml) {
  const tag = (s, t) => new RegExp(`<${t}>\s*([^<]*?)\s*</${t}>`).exec(s)?.[1];
  return [...xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)]
    .map(([, d]) => ({ groupId: tag(d, 'groupId'), artifactId: tag(d, 'artifactId'), version: tag(d, 'version') }))
    .filter((a) => a.groupId && a.artifactId && a.version);
}

export const sourcesJarUrl = ({ groupId, artifactId, version }) =>
  `${NEXUS}/${groupId.replaceAll('.', '/')}/${artifactId}/${version}/${artifactId}-${version}-sources.jar`;

const jarBin = () => (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jar') : 'jar');
const jarExtract = (jarPath, destDir) => execFileSync(jarBin(), ['xf', jarPath], { cwd: destDir });

export async function fetchSources(a, { cacheDir = join(ROOT, 'sources'), fetchImpl = fetch, extract = jarExtract } = {}) {
  const dir = join(cacheDir, `${a.artifactId}-${a.version}`);
  if (existsSync(dir)) return dir;
  const res = await fetchImpl(sourcesJarUrl(a));
  if (res.status === 404) throw new Error(`no sources jar for ${a.artifactId}:${a.version}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching sources for ${a.artifactId}:${a.version}`);
  mkdirSync(dir, { recursive: true });
  const jar = join(dir, '..', `${a.artifactId}-${a.version}-sources.jar`);
  try {
    writeFileSync(jar, Buffer.from(await res.arrayBuffer()));
    extract(jar, dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true }); // never leave a partial dir that looks cached
    throw e;
  }
  return dir;
}

async function getText(url, cacheFile) {
  if (cacheFile && existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  if (cacheFile) {
    mkdirSync(join(cacheFile, '..'), { recursive: true });
    writeFileSync(cacheFile, text);
  }
  return text;
}

async function resolveTarget(target) {
  if (existsSync(target)) {
    const ws = readWorkspace(target);
    if (!ws.isWorkspace) throw new Error(`not a Liferay workspace: ${target}`);
    // Workspace tpv wins over releases.json.
    const product = (ws.product ?? '').split('-')[0];
    if (ws.targetPlatformVersion) return { product: product || 'dxp', releaseKey: ws.product, targetPlatformVersion: ws.targetPlatformVersion };
    return resolveRelease(JSON.parse(await getText(RELEASES)), ws.product);
  }
  return resolveRelease(JSON.parse(await getText(RELEASES)), target);
}

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? (opt[argv[i].slice(2)] = argv[++i]) : pos.push(argv[i]);
  return { pos, opt };
}

async function bomFor({ ws, tpv, product }) {
  const r = tpv ? { product: product ?? 'dxp', targetPlatformVersion: tpv } : await resolveTarget(ws ?? process.cwd());
  const xml = await getText(bomUrl(r.product, r.targetPlatformVersion), join(ROOT, 'bom', `${r.product}-${r.targetPlatformVersion}.pom`));
  return parseBom(xml);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (cmd === 'resolve') console.log(JSON.stringify(await resolveTarget(pos[0] ?? process.cwd())));
  else if (cmd === 'search' && pos[0]) {
    const kw = pos[0].toLowerCase();
    for (const a of (await bomFor(opt)).filter((a) => a.artifactId.toLowerCase().includes(kw))) console.log(`${a.groupId}:${a.artifactId}:${a.version}`);
  } else if (cmd === 'fetch' && pos.length) {
    const bom = await bomFor(opt);
    for (const id of pos) {
      const a = bom.find((x) => x.artifactId === id);
      if (!a) throw new Error(`${id} not in BOM`);
      console.log(await fetchSources(a));
    }
  } else {
    console.error('usage: source.mjs resolve <workspaceDir|productKey> | search <kw> | fetch <artifactId>... [--ws dir] [--tpv v] [--product dxp|portal]');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => (console.error(e.message), process.exit(1)));

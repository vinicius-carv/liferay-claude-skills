# liferay-claude-skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin with three Liferay skills (workspace setup, config check, source lookup) backed by small tested Node scripts.

**Architecture:** Each skill is a `SKILL.md` (the brains) plus, where exactness matters, an `.mjs` script in its `scripts/` folder. Shared workspace parsing lives in `lib/workspace.mjs`. Scripts export pure functions (unit-tested) and run a CLI when executed directly.

**Tech Stack:** Node ≥ 20 built-ins only (`node:test`, `fetch`, `net`, `fs`, `child_process`), JDK `jar` for zip extraction, Claude Code plugin format.

**Spec:** `docs/superpowers/specs/2026-11-22-liferay-claude-skills-design.md`

## Global Constraints

- Zero npm dependencies. `package.json` only holds `"type": "module"` and `"scripts": {"test": "node --test"}`.
- Node ≥ 20; must pass on Windows and Linux (CI matrix ubuntu-latest + windows-latest, Node 20 + 22).
- Paths via `node:path`; never hard-code `/` separators in fs calls.
- CLI preference in skills: `lfr` → `blade` → `./gradlew` (`gradlew.bat` on Windows).
- Skills branch on exit codes of lfr/blade/gradlew, never parse their text.
- Never send `exit` to Gogo (it stops the OSGi framework); end sessions with `disconnect`.
- Nexus base: `https://repository-cdn.liferay.com/nexus/content/groups/public`. Releases: `https://releases-cdn.liferay.com/releases.json`.
- Cache root: `~/.liferay-claude/` (`sources/<artifactId>-<version>/`, `bom/<tpv>.pom`).
- No client-derived content anywhere. Commit messages: English conventional commits ending with the two attribution lines (`Generated with AI` / `Co-Authored-By: AI <ai@example.com>`).

## Review Focus

1. Windows CRLF in `.properties` / `.config` files → parsed identically to LF (test in Task 2).
2. `portal-ext.properties` value with `\` line continuation spanning lines → one entry, no false duplicate (Task 2).
3. Gogo greeting containing telnet IAC bytes (0xFF …) before `g! ` prompt → client still finds prompt (Task 4).
4. Manifest `Bundle-SymbolicName` wrapped across 72-char continuation lines and carrying `;singleton:=true` → bare name returned (Task 4).
5. Workspace with `liferay.workspace.product` only in `gradle-local.properties`, or overridden there → override wins (Task 2).

---

### Task 1: Plugin skeleton + CI

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `.gitignore`, `LICENSE` (MIT, 2026, vinicius-carv), `.github/workflows/ci.yml`, `test/smoke.test.mjs`

**Interfaces:** Produces: `npm test` runs every `test/*.test.mjs`.

- [ ] **Step 1:** `plugin.json`: `name: "liferay-claude-skills"`, `version: "0.1.0"`, description "Claude Code skills for Liferay DXP/Portal workspaces: setup with verified bundle health, config checks, version-exact source lookup", `author: {name: "vinicius-carv"}`, `license: "MIT"`. `marketplace.json`: `name: "liferay-claude-skills"`, `owner: {name: "vinicius-carv"}`, `plugins: [{name: "liferay-claude-skills", source: "./", description: <same>}]`.
- [ ] **Step 2:** `test/smoke.test.mjs`: asserts both JSON files parse and `plugin.json.name === marketplace.plugins[0].name`.
- [ ] **Step 3:** Run `npm test` → 1 pass. Run `claude plugin validate .` → no errors (if the subcommand is absent, note it and skip).
- [ ] **Step 4:** CI workflow: checkout, setup-node (matrix 20, 22), `npm test`, on ubuntu-latest + windows-latest.
- [ ] **Step 5:** Commit `chore: plugin skeleton and CI`.

### Task 2: `lib/workspace.mjs` + `liferay-config-check` script

**Files:**
- Create: `lib/workspace.mjs`, `skills/liferay-config-check/scripts/check-config.mjs`, `test/workspace.test.mjs`, `test/check-config.test.mjs`, `test/fixtures/ws-good/**`, `test/fixtures/ws-broken/**`

**Interfaces:**
- Produces (`lib/workspace.mjs`):
  - `parseProperties(text: string) -> { entries: Map<string,string>, duplicates: {key, lines:number[]}[], errors: {line:number, message:string}[] }` — handles CRLF, `#`/`!` comments, `\` continuations, `=`/`:` separators; line numbers 1-based of the entry start.
  - `readWorkspace(dir: string) -> { isWorkspace: boolean, product?: string, targetPlatformVersion?: string, environment: string }` — `isWorkspace` = `settings.gradle` contains `com.liferay.workspace`; props from `gradle.properties`, then `gradle-local.properties` overrides; `environment` from `liferay.workspace.environment`, default `"local"`; `targetPlatformVersion` from `liferay.workspace.target.platform.version`.
- Produces (`check-config.mjs`):
  - `parseConfigFile(text) -> { values: Record<string,string>, errors: {line, message}[] }` — Felix typed format: `key="v"`, `key=I"1"` (type letters `T I L F D X S C B`, lowercase for primitives), arrays `key=["a","b"]` / `key=I["1","2"]`; `#` comments; unquoted value → error "value must be quoted".
  - `checkConfigFileName(name) -> { kind: 'single'|'factory'|'legacy-factory'|'cfg'|'invalid', pid?: string }` — `<pid>.config`, `<factoryPid>~<name>.config`, `<factoryPid>-<name>.config` → legacy-factory (only if pid segment before `-` contains a dot), `.cfg` → cfg.
  - `checkWorkspace(dir, { env?, probe? }) -> Promise<Finding[]>`, `Finding = { severity: 'error'|'warn'|'info', file: string, line?: number, message: string }`. `probe(host, port) -> Promise<boolean>` defaults to a 2 s `net.connect` check.
  - CLI: `node check-config.mjs <workspace> [--env <name>] [--json]`; prints findings grouped by severity; exit 1 if any error, else 0.

Checks `checkWorkspace` must emit (spec §Skill 2): not a workspace → error; missing `configs/common` or `configs/<env>` → warn; each portal-ext.properties (`configs/common`, `configs/<env>`, and `bundles/portal-ext.properties`, `bundles/portal-setup-wizard.properties` if present): duplicates → warn, parse errors → error; effective (env over common) without `jdbc.default.url` → info "embedded HSQL — fine for dev, not for shared data"; jdbc URL host:port (parse `//host:port` with defaults mysql 3306, postgresql 5432, mariadb 3306, sqlserver 1433, oracle 1521) unreachable → error; `module.framework.properties.osgi.console` set to empty/disabled → warn "Gogo disabled; bundle health check will be unverified"; every file under `configs/*/osgi/configs`: name kind invalid → error, legacy-factory → info, cfg → info "untyped"; parse errors → error.

- [ ] **Step 1:** Fixtures. `ws-good`: settings.gradle with `com.liferay.workspace`, gradle.properties `liferay.workspace.product=portal-7.4-ga106`, configs/common/portal-ext.properties (jdbc mysql localhost:3306), configs/local/osgi/configs/`com.liferay.foo.Config.config` with `enabled=B"true"`. `ws-broken`: duplicate key, unquoted `.config` value, file `bad name.config`, jdbc to `db.invalid:3306`, gradle-local.properties overriding product to `dxp-2025.q1.23-lts`. Write a CRLF copy of one properties file in the test itself (don't commit CRLF fixtures; add `.gitattributes` `test/fixtures/** -text`).
- [ ] **Step 2:** Tests (`workspace.test.mjs`): `parseProperties` continuation → one entry `a=b c`, no duplicate; CRLF text → same entries as LF; duplicates report both line numbers; `readWorkspace(ws-broken).product === 'dxp-2025.q1.23-lts'`; `readWorkspace(ws-good).environment === 'local'`.
- [ ] **Step 3:** Tests (`check-config.test.mjs`): `parseConfigFile('a="x"\nb=I"2"\nc=["p","q"]')` → no errors, `values.b === 'I"2"'`; `parseConfigFile('a=x')` → 1 error at line 1; `checkConfigFileName('com.x.Y~one.config').kind === 'factory'`; `checkConfigFileName('bad name.config').kind === 'invalid'`; `checkWorkspace(ws-good, {probe: async () => true})` → zero errors; `checkWorkspace(ws-broken, {probe: async () => false})` → contains errors for unquoted value, invalid name, unreachable DB, and a warn for duplicate key.
- [ ] **Step 4:** Run `npm test` → new tests fail (modules missing).
- [ ] **Step 5:** Implement both modules. CLI guard: `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`.
- [ ] **Step 6:** `npm test` → all pass. `node skills/liferay-config-check/scripts/check-config.mjs test/fixtures/ws-broken` → exit 1, findings printed.
- [ ] **Step 7:** Commit `feat: config check script and workspace parser`.

### Task 3: `liferay-source-lookup` script

**Files:**
- Create: `skills/liferay-source-lookup/scripts/source.mjs`, `test/source.test.mjs`, `test/fixtures/releases.json` (3 real-shaped entries: `dxp-2025.q1.23-lts`→`2025.q1.23`, `dxp-7.4-u92`→`7.4.13.u92`, one `portal-7.4-ga*` entry copied from the live file), `test/fixtures/bom-sample.pom` (dependencyManagement with `com.liferay.portal:com.liferay.portal.kernel:188.1.0` and `com.liferay:com.liferay.journal.service:7.0.193`)

**Interfaces:**
- Consumes: `readWorkspace(dir)` from Task 2.
- Produces:
  - `resolveRelease(releases: object[], productKey: string) -> { product: 'dxp'|'portal', releaseKey, targetPlatformVersion }`; unknown key throws `Error` whose message lists up to 5 keys sharing the first two `-`-segments (e.g. `dxp-2025.q1`).
  - `bomUrl(product, tpv) -> string` = `${NEXUS}/com/liferay/portal/release.${product}.bom/${tpv}/release.${product}.bom-${tpv}.pom`.
  - `parseBom(xml) -> { groupId, artifactId, version }[]`.
  - `sourcesJarUrl({groupId, artifactId, version}) -> string` (groupId dots → `/`).
  - `fetchSources(artifact, { cacheDir?, fetchImpl?, extract? }) -> Promise<string>` returns extracted dir; skips download if dir exists; `extract(jarPath, destDir)` defaults to `execFileSync('jar', ['xf', jarPath], {cwd: destDir})` (use `JAVA_HOME/bin/jar` if set). HTTP 404 → throws "no sources jar for <a>:<v>".
  - CLI: `resolve <workspaceDir|productKey>` (prints JSON), `search <keyword> [--ws <dir>] [--tpv <v>] [--product dxp|portal]` (prints `groupId:artifactId:version` lines, case-insensitive substring on artifactId), `fetch <artifactId>... [--ws/--tpv/--product]` (prints one extracted path per line). BOM cached at `~/.liferay-claude/bom/<product>-<tpv>.pom`. Workspace `targetPlatformVersion` wins over releases.json.
- [ ] **Step 1:** Tests: resolve `dxp-7.4-u92` → tpv `7.4.13.u92`, product `dxp`; unknown `dxp-2025.q1.99-lts` throws, message includes `dxp-2025.q1.23-lts`; `bomUrl('dxp','2025.q1.23')` equals the exact URL; `parseBom` fixture → 2 entries with right groupIds; `sourcesJarUrl` for journal.service equals `${NEXUS}/com/liferay/com.liferay.journal.service/7.0.193/com.liferay.journal.service-7.0.193-sources.jar`; `fetchSources` with stub fetch (200, small buffer) + stub extract writes jar and returns `<cache>/com.liferay.journal.service-7.0.193`; second call doesn't call fetch; stub 404 → rejects with "no sources jar".
- [ ] **Step 2:** Opt-in network test, skipped unless `LIFERAY_NET_TESTS=1`: real `resolve('dxp-2025.q1.23-lts')` → tpv `2025.q1.23`; real fetch of `com.liferay.portal.kernel` sources → extracted dir contains `com/liferay/portal/kernel/model/User.java`.
- [ ] **Step 3:** Run → fail. Implement. Run `npm test` → pass; `LIFERAY_NET_TESTS=1 node --test test/source.test.mjs` → pass.
- [ ] **Step 4:** Commit `feat: version-exact Liferay source lookup script`.

### Task 4: `bundles.mjs` (Gogo bundle health)

**Files:**
- Create: `skills/liferay-workspace-setup/scripts/bundles.mjs`, `test/bundles.test.mjs`, `test/fixtures/lb-s.txt` (hand-written now; replaced with real capture in Task 6)

**Interfaces:**
- Produces:
  - `parseLb(text) -> { id:number, state:string, level:number, name:string }[]` — rows like `  512|Installed  |   15|com.acme.broken (1.0.0)`; skip header/prompt lines.
  - `parseManifestBsn(text) -> string|null` — unwraps continuation lines (line starting with one space), strips `;…` directives, CRLF-safe.
  - `workspaceBundles(dir) -> { names: string[], unchecked: string[] }` — `names` from `modules/**/build/libs/*.jar` via `jar xf <jar> META-INF/MANIFEST.MF` into a temp dir + `parseManifestBsn`; `unchecked` = top-level folder names present among `client-extensions`, `themes`, `wars`.
  - `gogo(commands: string[], { host='localhost', port=11311, timeoutMs=15000 }) -> Promise<string[]>` — raw `net` socket; strip IAC sequences (0xFF + 2 bytes; reply nothing); wait for `g! `; send each command + `\r\n`, collect output until the next `g! `; then send `disconnect`. Rejects with code `'GOGO_UNREACHABLE'` on connect error/timeout.
  - CLI: `node bundles.mjs <workspace> [--host] [--port]`: runs `lb -s`; for each workspace name not `Active` (or missing → state `missing`) runs `diag <id>`; prints a table + diag text + unchecked list. Exit 0 all Active, 1 some not, 2 unreachable (message names `module.framework.properties.osgi.console`).
- [ ] **Step 1:** Tests: `parseLb(fixture)` returns Active and Installed rows with ids/names; `parseManifestBsn('Bundle-SymbolicName: com.acme.very.long.na\r\n me.portlet;singleton:=true\r\n')` → `com.acme.very.long.name.portlet`; `gogo` against a `net.createServer` fake that writes `\xff\xfb\x01\xff\xfb\x03Welcome\r\ng! `, echoes canned `lb -s` output then `g! `, and records received lines → returns that output and the fake received `disconnect` and never `exit`; `gogo` to an unused port rejects with `GOGO_UNREACHABLE`.
- [ ] **Step 2:** Run → fail. Implement. Run `npm test` → pass.
- [ ] **Step 3:** Commit `feat: Gogo bundle health check script`.

### Task 5: The three SKILL.md files

**Files:**
- Create: `skills/liferay-config-check/SKILL.md`, `skills/liferay-source-lookup/SKILL.md`, `skills/liferay-workspace-setup/SKILL.md`

**Interfaces:** Consumes the CLIs from Tasks 2–4, invoked as `node "<skill base dir>/scripts/<name>.mjs" …` (the base directory is given to the model when the skill loads).

Each SKILL.md: frontmatter `name` + `description` (third person, says *when* to use: e.g. "Use when bringing up an existing Liferay workspace after a clone, or when deploys succeed but the portal misbehaves"); body = numbered flow from the spec section, the CLI mapping table rows it needs, what to report (verified facts only), what never to do (send `exit` to Gogo; claim success from exit codes; write config without user confirmation).
- config-check: run script → explain each finding with the fix; "define" flow: ask DB type + host/port/db/user, write `configs/local/portal-ext.properties` from the embedded template (setup wizard off `setup.wizard.enabled=false`, `jdbc.default.*` block per MySQL/PostgreSQL, `browser.launcher.url=`, `include-and-override=portal-developer.properties`) only after the user confirms; never put passwords in chat — point to `gradle-local.properties`/env.
- source-lookup: resolve → search (suggest `com.liferay.portal.kernel` / `com.liferay.portal.impl` for core APIs, module artifact names for apps) → fetch → Grep/Read in returned path → answer with file paths relative to the cache and the version; fallback link `https://github.com/liferay/liferay-portal/tree/<tag>`.
- workspace-setup: spec §Skill 1 steps 1–7, with startup wait policy (10 s poll, 10 min max, last 30 log lines on timeout) and Gogo-unverified wording.
- [ ] **Step 1:** Write the three files. Keep each under ~120 lines.
- [ ] **Step 2:** `claude plugin validate .` (if available) and `claude plugin details liferay-claude-skills` after local install (Task 6) show 3 skills.
- [ ] **Step 3:** Commit `feat: setup, config-check and source-lookup skills`.

### Task 6: End-to-end on a sample workspace + README

**Files:**
- Create: `README.md`, `docs/e2e-2026-11-22.md` (captured evidence)
- Modify: `test/fixtures/lb-s.txt` (real capture, trimmed to ~20 rows incl. the broken module)

- [ ] **Step 1:** `cd C:\wt; lfr create workspace lr-sample` (Gradle, portal 7.4); set `liferay.workspace.product=portal-7.4-ga106` (bundle cached in `~/.liferay/bundles`). Add `lfr create mvc-portlet hello-portlet` and an `api` module `broken-api` whose `bnd.bnd` adds `Import-Package: com.example.missing,*`.
- [ ] **Step 2:** Install the plugin locally: `claude plugin marketplace add C:\Users\vinic\Documents\projects\liferay-claude-skills` then `claude plugin install liferay-claude-skills@liferay-claude-skills`. Confirm listed.
- [ ] **Step 3:** Run each skill through Claude Code in `C:\wt\lr-sample` (headless `claude -p` is fine): config-check (expect info HSQL + any warns), workspace-setup (expect hello-portlet Active, broken-api not Active with `diag` naming `com.example.missing`), source-lookup ("where is `MVCPortlet` defined and what does `doView` do?" → path inside a fetched sources jar for the GA106 platform). Record outputs in `docs/e2e-2026-11-22.md`. If Gogo is unreachable on GA106, record that and the property fix — do not fake it.
- [ ] **Step 4:** Replace `lb-s.txt` with the real capture; `npm test` still passes.
- [ ] **Step 5:** Stop the portal (`lfr stop`).
- [ ] **Step 6:** README (English): what/why (2 pains), install (marketplace add + install), the 3 skills with one example each from the e2e doc, requirements (Node ≥ 20, JDK, lfr or blade), CLI preference, limits (Gradle only tested; DXP license screens not covered; 7.4+), dev (`npm test`, `LIFERAY_NET_TESTS=1`), and one pt-BR line: "🇧🇷 Plugin do Claude Code para acelerar o setup de workspaces Liferay e a consulta ao código-fonte na versão exata do projeto."
- [ ] **Step 7:** Commit `docs: README and end-to-end evidence`.

# liferay-claude-skills — design

Date: 2026-11-22 · Status: draft after builder check, awaiting approval

## Intent

A public Claude Code plugin that removes the two biggest time sinks in day-to-day Liferay DXP/Portal backend work:

1. **Bringing up an existing Liferay workspace** after a fresh clone: dependencies, bundle, config, deploy, start, and *knowing* it is healthy.
2. **Looking up Liferay source** for the exact version the workspace targets (reference implementations, extension points, templates) without cloning the ~10 GB `liferay-portal` repo.

It is also a portfolio piece (mid-level, international remote + Brazilian market): it must read as engineering — deterministic, tested helpers — not as a pile of prompts. Uses only public Liferay knowledge; no client code, names or data.

## Goals

- Skill `liferay-workspace-setup`: from a cloned workspace to a running, verified portal, reporting only what was actually verified.
- Skill `liferay-config-check`: verify portal-ext.properties, `configs/<env>` overlay and OSGi `.config` files; and quickly *define* a minimal local config when missing.
- Skill `liferay-source-lookup`: version-exact source lookup via Liferay's published `-sources.jar` artifacts, cached locally, searched with Claude's Grep.
- Small zero-dependency Node scripts for the parts that must be exact, each with `node --test` tests; GitHub Actions CI (ubuntu + windows).
- Installs locally via a plugin marketplace file; English README + one pt-BR line.

## Non-goals (v1)

Scaffolding (modules, client extensions, Service Builder), upgrade checks, DB import/dumps, Docker, Liferay Cloud/PaaS (`lcp`), an MCP server, Maven workspaces (lfr supports them; we only test Gradle — documented as untested), Liferay versions older than 7.4.

## Anti-goals (failure even if it "works")

- Skills that restate the docs without running or checking anything.
- Reporting success from a command exit code alone (a green `gradlew deploy` does not mean bundles are Active).
- Any client-derived content.
- Requiring a full `liferay-portal` clone.

## Constraints

- Cross-platform: Windows (PowerShell / Git Bash), macOS, Linux. Hence Node scripts, not bash/Python.
- Node ≥ 20, built-ins only (`fetch`, `net`, `node:test`). No npm dependencies.
- JDK is assumed present (Liferay requires it); `jar xf` extracts sources jars.
- CLI preference: **`lfr`** (lgdd/lfr-cli, v3.1.0 verified locally) when on PATH, else **`blade`**, else **`./gradlew`** directly. User's call: lfr is "more sophisticated and updated".

## Approaches considered

- **A. Skills only (prose).** Smallest; but non-deterministic, nothing to test, reads as "nice prompts". Rejected.
- **B. Skills + small Node helper scripts with tests.** Skills stay the brains; scripts do version resolution, config parsing, health/bundle checks. **Chosen by user.**
- **C. MCP server + skills.** Reusable from any MCP client, but much more code and overlaps the next portfolio project (`mcp-brasil`). Rejected.

## Design

### Repo layout

```
.claude-plugin/plugin.json          name, version, description, author, license
.claude-plugin/marketplace.json     single-plugin local marketplace (source: "./")
skills/liferay-workspace-setup/SKILL.md
skills/liferay-config-check/SKILL.md
skills/liferay-config-check/scripts/check-config.mjs
skills/liferay-source-lookup/SKILL.md
skills/liferay-source-lookup/scripts/source.mjs
skills/liferay-workspace-setup/scripts/bundles.mjs
test/*.test.mjs + test/fixtures/   (node --test)
.github/workflows/ci.yml
README.md  LICENSE (MIT)
```

Scripts live inside their skill folder and are invoked by the skill using the skill's base directory (Claude Code tells the model the skill's base directory when it loads). Skills are slash-invocable (`/liferay-workspace-setup` etc.), so no separate `commands/`.

### CLI mapping (used by skills)

| Step | lfr | blade | gradlew |
|---|---|---|---|
| env check | `lfr diagnose` | `blade version` + `java -version` | `java -version` |
| bundle | `lfr init` | `blade gw initBundle` | `./gradlew initBundle` |
| build | `lfr build` | `blade gw build` | `./gradlew build` |
| deploy | `lfr deploy` | `blade deploy` | `./gradlew deploy` |
| start/stop/status | `lfr start/stop/status` | `blade server start/stop` | `bundles/tomcat*/bin/catalina start` |
| logs | `lfr logs` | — | tail `bundles/logs/liferay.*.log` |
| gogo | `lfr shell` (interactive) | `blade sh "<cmd>"` | `bundles.mjs` (own client) |

### Skill 1 — `liferay-workspace-setup`

Trigger: user wants to run / set up / bring up an existing Liferay workspace.

Flow:
1. Detect workspace: `settings.gradle` applies `com.liferay.workspace`; read `liferay.workspace.product` and `liferay.workspace.environment` (default `local`) from `gradle.properties` (+ `gradle-local.properties` override).
2. Env check via `lfr diagnose` (or fallbacks); stop with a clear message if JDK is incompatible.
3. Run `liferay-config-check` (skill 2) on the workspace; offer to define missing local config.
4. Init bundle (uses `~/.liferay/bundles` cache), build, deploy.
5. Start; wait for startup (log line `Server startup in` / HTTP 200|302 on `http://localhost:8080/`).
6. `node bundles.mjs <workspace>`: connects to Gogo (`localhost:11311`), runs `lb -s`, matches against the workspace's module bundle symbolic names, prints any not `Active` and runs `diag <id>` for each.
7. Report: verified facts only (bundle path, portal URL responding, N/N workspace bundles Active, or exactly which are not and why).

`bundles.mjs`: parses `lb -s` output (pure function, unit-tested); takes workspace symbolic names from the **built jars' manifests** (`modules/**/build/libs/*.jar` → `META-INF/MANIFEST.MF` `Bundle-SymbolicName`, read via `jar xf`), so it matches what was actually deployed. Client extensions, themes and WARs are listed as "not checked by Gogo" rather than guessed. Exit 0 all Active, 1 some not Active, 2 Gogo unreachable.

Builder-check calls (mine, 2026-11-22):
- Gogo: raw TCP client on `localhost:11311` (Liferay's default `module.framework.properties.osgi.console`), tolerating telnet negotiation bytes. If unreachable: exit 2, the skill reports "bundle state unverified" and names the property to set; config-check warns if the property is overridden to disable it.
- `lb -s` fixture: start from a hand-written sample, replace it with real output captured from the sample workspace's portal during the end-to-end test.
- Startup wait: poll every 10 s for up to 10 min (first start is slow); on timeout report "not started" with the last 30 log lines. Not a silent pass.
- `lfr`/`blade` output is shown to the user only; the skill branches on exit codes, never on parsing their text.

### Skill 2 — `liferay-config-check`

`check-config.mjs <workspace> [--env local]` → human-readable report + JSON (`--json`). Checks:
- `configs/common` and `configs/<env>` exist; effective portal-ext.properties = env overrides common (also `bundles/portal-ext.properties` / `portal-setup-wizard.properties` if bundle exists).
- portal-ext.properties: duplicate keys, line-continuation errors, `jdbc.default.driverClassName/url/username` presence (else "embedded HSQL — fine for dev, not for shared data"), DB host:port TCP reachable (2 s timeout).
- OSGi `.config` files in `configs/*/osgi/configs`: Felix typed format (`key="v"`, `key=I"1"`, `key=B"true"`, `key=["a","b"]`, `#` comments), unquoted values flagged; filename is `<pid>.config` or `<factoryPid>~<name>.config` (legacy `-name` noted); `.cfg` files noted as untyped.
- Severity: error / warn / info; exit 1 on any error.

"Define": SKILL.md carries a minimal local `portal-ext.properties` template (setup wizard off, JDBC block for MySQL/PostgreSQL/HSQL, common dev properties) that the skill writes into `configs/local/` only after the user confirms values. No script.

### Skill 3 — `liferay-source-lookup`

`source.mjs` subcommands:
- `resolve <workspace|productKey>` → `{ product, releaseKey, targetPlatformVersion, bom }` via `https://releases-cdn.liferay.com/releases.json` (`releaseKey` → `targetPlatformVersion`). BOM: `com/liferay/portal/release.{dxp|portal}.bom/<tpv>/release.*.bom-<tpv>.pom` on `https://repository-cdn.liferay.com/nexus/content/groups/public`.
  Mapping (verified): the workspace's `liferay.workspace.product` value *is* a `releaseKey` in releases.json (e.g. `dxp-2025.q1.23-lts`, `dxp-7.4-u92` → `7.4.13.u92`, `portal-7.4-ga132`; the script reads `targetPlatformVersion` from the JSON, never derives it). If `liferay.workspace.target.platform.version` is set, it wins and releases.json is skipped. Unknown key → clear error listing the nearest keys; no guessing. Product prefix (`dxp`/`portal`) picks the BOM.
- `search <keyword>` → BOM artifacts (groupId, artifactId, version) whose artifactId contains the keyword.
- `fetch <artifactId>...` → downloads `<artifactId>-<version>-sources.jar`, extracts with `jar xf` into `~/.liferay-claude/sources/<artifactId>-<version>/`, prints the path. Cached: re-fetch is a no-op.

Skill flow: resolve version → pick candidate artifacts (BOM search; `com.liferay.portal.kernel` / `portal.impl` for core) → fetch → Grep/Read in the cache → answer with file paths and the version they came from. Fallback if no sources jar: GitHub `liferay/liferay-portal` at the matching tag (link only).

Verified facts (2026-11-22): BOM versions drop `-lts` (e.g. `2025.q1.23`); 2026.q3.9 BOM lists ~1500 artifacts incl. `com.liferay.portal.kernel`, `com.liferay.portal.impl`; sources jars present (e.g. `com.liferay.journal.service-7.0.193-sources.jar`).

### Testing

- Unit (`node --test`, CI on ubuntu + windows): `lb -s` parser, `.config` / properties parser + checks over fixture workspaces (good + broken), product key → BOM URL mapping with a stubbed `releases.json`.
- Opt-in network test (`LIFERAY_NET_TESTS=1`): real resolve + fetch of a small sources jar.
- Manual end-to-end (recorded in README): sample workspace `C:\wt\lr-sample` created with `lfr create workspace` (one MVC portlet + one module with a deliberate unresolved import), run each skill through Claude Code, capture output. Sample workspace not committed.

### Packaging & install

`/plugin marketplace add <path-or-github>` then `/plugin install liferay-claude-skills@liferay-claude-skills`. Verified locally in v1; GitHub publishing only after the user's explicit yes.

## Left to the builder

Exact SKILL.md wording; exact portal-ext template properties; log/HTTP startup detection details; output formatting.

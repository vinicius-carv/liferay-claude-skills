# liferay-claude-skills

Claude Code plugin with three skills for Liferay DXP / Portal Gradle workspaces: bring a workspace up and verify it, check its config, and read the source of the exact Liferay version it targets.

> 🇧🇷 Plugin do Claude Code para acelerar o setup de workspaces Liferay e a consulta ao código-fonte na versão exata do projeto.

## Why

1. A green `gradlew deploy` says nothing about the portal. Modules that fail to resolve (missing import, wrong Java version) sit in `Installed` state until a page breaks. The setup skill asks the running portal (Gogo `lb -s`, `diag`) and lists what is not Active and why.
2. Answers about Liferay internals only help for the version you run. The source-lookup skill downloads the `-sources.jar` for the workspace's target platform from Liferay's public Nexus into a small cache, so Claude reads real code instead of guessing or cloning the whole repository.

## Install

```
claude plugin marketplace add <local path or owner/repo of this repo>
claude plugin install liferay-claude-skills@liferay-claude-skills
```

On Windows use forward slashes in a local path. Skills are invoked automatically when your request matches, or by name: `/liferay-workspace-setup`, `/liferay-config-check`, `/liferay-source-lookup`.

## Skills

**liferay-workspace-setup** - init bundle, build, deploy, start, then verify bundles through Gogo.
Example (real run, see `docs/e2e-2026-11-22.md`): `hello-portlet` Active; `broken-api` not Active, `diag` reports `Unresolved requirement: Import-Package: com.example.missing`.

**liferay-config-check** - validates `portal-ext.properties`, `configs/<env>` and OSGi `.config` files; can draft a minimal local config (never asks for a DB password).
Example: `INFO configs no jdbc.default.url: embedded HSQL - fine for dev, not for shared data`.

**liferay-source-lookup** - resolves the target platform version, searches the BOM, fetches and caches sources in `~/.liferay-claude/`.
Example: for `portal-7.4-ga106`, `MVCPortlet` lives in `com.liferay.portal.kernel-130.0.1/com/liferay/portal/kernel/portlet/bridges/mvc/MVCPortlet.java`, and `doView` just calls `include(viewTemplate, ...)`.

## Requirements

- Node >= 20 (no npm dependencies) and a JDK (`jar` reads module manifests).
- A Liferay Gradle workspace. CLI preference: `lfr`, then `blade`, then `./gradlew`.
- Gogo enabled for bundle verification: `module.framework.properties.osgi.console=localhost:11311`.

## Limits

- Only a Gradle workspace on Portal CE 7.4 GA106 on Windows was exercised end to end. DXP (license and activation screens), Maven, macOS and Linux are untested; Liferay 7.4+ only.
- Match the JDK to the product: GA106 did not start on JDK 21 and needs JDK 11 (or 8).
- `lfr status` / `lfr stop` do nothing on Windows.
- Details and the full "not verified" list: `docs/e2e-2026-11-22.md`.

## Development

```
npm test                       # offline
LIFERAY_NET_TESTS=1 npm test   # also hits Liferay's Nexus and releases.json
```

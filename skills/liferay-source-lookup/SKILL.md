---
name: liferay-source-lookup
description: Use when you need the real Liferay source for the exact version a workspace targets, such as a reference implementation, an extension point, an OSGi component, a service API or a template, and you do not want to clone the full liferay-portal repository.
---

# Liferay source lookup

Fetches version-exact `-sources.jar` files from Liferay's public Nexus, caches them under `~/.liferay-claude/`, and lets you search them with Grep/Read. The skill's base directory is shown when it loads; the tool is `<base>/scripts/source.mjs` (needs `node` and a JDK `jar`; `JAVA_HOME` is honored).

## Flow

1. **Resolve the version.** `node "<base>/scripts/source.mjs" resolve "<workspaceDir>"` prints JSON `{ product, releaseKey, targetPlatformVersion, bom }`. It also accepts a product key such as `dxp-2025.q1.23-lts`. `liferay.workspace.target.platform.version`, if set, wins. An unknown key errors with similar keys: show those and ask; do not guess.
2. **Search the BOM.** `node "<base>/scripts/source.mjs" search <keyword> --ws "<workspaceDir>"` prints `groupId:artifactId:version` lines whose artifactId contains the keyword.
   - Core APIs: `com.liferay.portal.kernel` (public API, `com.liferay.portal.kernel.*`) and `com.liferay.portal.impl` (implementation).
   - Apps and features: the module artifact, e.g. `com.liferay.journal.service`, `com.liferay.blogs.web`. Search a short keyword (`journal`, `blogs`) and pick candidates.
   - Without a workspace use `--tpv <version> --product dxp|portal` instead of `--ws`.
3. **Fetch.** `node "<base>/scripts/source.mjs" fetch <artifactId> [<artifactId>...] --ws "<workspaceDir>"` downloads, extracts and prints the cache directory per artifact. Re-fetching is a no-op.
4. **Read.** Use Grep and Read inside the printed directory. Do not read more than needed.
5. **Answer.** Cite file paths relative to the cache root (`sources/<artifactId>-<version>/...`) and state the version the code came from. Quote only the lines that matter.

Exit codes: 0 ok, 1 error (message on stderr), 2 bad usage.

## Fallbacks

- No sources jar for an artifact (the tool says so) or artifact not in the BOM: give the link `https://github.com/liferay/liferay-portal/tree/<tag>` for the matching release and say the code was not read. Do not clone it.
- Network failure: report it; use an existing cache entry only if the user accepts possibly stale content (cache directories are named with their version, so say which).

## Report

The resolved version (and how: releases.json or explicit target platform), the artifacts fetched, the paths read, and the answer. If you inferred anything beyond what the source shows, label it as inference.

## Never

- Present code from a different version than the workspace targets without saying so.
- Derive a target platform version from the product key by pattern; the tool reads it from releases.json.
- Delete or edit files under `~/.liferay-claude/` unless the user asks.
- Copy large source blocks into the answer or into the user's project without being asked.

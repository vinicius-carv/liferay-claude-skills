---
name: liferay-workspace-setup
description: Use when the user wants to run, set up or bring up an existing Liferay workspace after a clone, when initBundle, build, deploy or startup needs to be driven end to end, or when it must be confirmed that deployed modules are actually Active in the portal.
---

# Liferay workspace setup

Takes a cloned Liferay Gradle workspace to a running portal and verifies it. The skill's base directory is shown when it loads; scripts: `<base>/scripts/bundles.mjs` and `<base>/../liferay-config-check/scripts/check-config.mjs`.

## CLI mapping

Prefer `lfr` (detect: `lfr version`), else `blade` (`blade version`), else the Gradle wrapper (`./gradlew`; `gradlew.bat` on Windows shells). Branch on exit codes only; never parse their text. Show their output to the user.

| Step | lfr | blade | gradlew |
|---|---|---|---|
| env check | `lfr diagnose` | `blade version` + `java -version` | `java -version` |
| init bundle | `lfr init` | `blade gw initBundle` | `./gradlew initBundle` |
| build | `lfr build` | `blade gw build` | `./gradlew build` |
| deploy | `lfr deploy` | `blade deploy` | `./gradlew deploy` |
| start/stop | `lfr start` / `lfr stop` | `blade server start` / `stop` | `bundles/tomcat*/bin/catalina.sh start` (`.bat` on Windows) |
| status | `lfr status` | - | - (HTTP probe: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/`) |
| logs | `lfr logs` | none | tail `bundles/tomcat*/logs/liferay.*.log` |

## Flow

1. **Detect the workspace.** `settings.gradle` applies `com.liferay.workspace`. Read `liferay.workspace.product` and `liferay.workspace.environment` (default `local`) from `gradle.properties`; `gradle-local.properties` overrides it. Not a workspace: stop and say so.
2. **Env check.** Run the env-check row. If the JDK is incompatible with the product, stop with a clear message; do not continue.
3. **Config.** Run `node "<base>/../liferay-config-check/scripts/check-config.mjs" "<workspace>"`. On errors, follow the liferay-config-check skill: explain, fix with confirmation, or offer its Define flow when no local config exists. A DB password goes in `gradle-local.properties` or `configs/local/portal-ext.properties`, entered by the user, not in chat.
4. **Bundle, build, deploy.** Init bundle (uses the `~/.liferay/bundles` cache; the first run downloads), then build, then deploy. Stop at the first non-zero exit and show the output.
5. **Start and wait.** Check status first (`lfr status`, or for blade/gradlew the HTTP probe in the table); start the server only if it is not already running. Poll every 10 s for up to 10 min: the log (`bundles/tomcat*/logs/` `liferay.*.log` or `catalina.*.log`, or `lfr logs`) shows `Server startup in`, or `http://localhost:8080/` answers 200 or 302. On timeout report "not started" with the last 30 log lines. A timeout is never a pass.
6. **Verify bundles.** `node "<base>/scripts/bundles.mjs" "<workspace>"` (optional `--host`, `--port`; Gogo defaults to `localhost:11311`). It reads `Bundle-SymbolicName` from the built jars in `modules/**/build/libs`, runs `lb -s` in Gogo, lists any bundle not Active and runs `diag <id>` for each.
   - Exit 0: all Active (fragments count when Resolved). Exit 1: some not Active, or no jars built (build first). Exit 2: Gogo unreachable.
   - Exit 2: report "bundle state unverified" and name the property `module.framework.properties.osgi.console` (default `localhost:11311`); check whether config-check flagged it as disabled. Do not claim the bundles are fine.
   - Client extensions, themes and WARs are listed as "not checked by Gogo". Do not guess their state.
   - Interactive Gogo, if needed: `lfr shell`, or `blade sh "<cmd>"`. End any session with `disconnect`.
7. **Report** as below.

## Report

Verified facts only, each with its evidence: bundle path; product and environment read; portal URL and the status code or log line seen; "N/N workspace bundles Active" from bundles.mjs, or exactly which are not and the `diag` reason. Anything not checked (Gogo unreachable, non-OSGi artifacts) is listed as unverified.

## Never

- Send `exit` to Gogo: it stops the OSGi framework. Use `disconnect`.
- Claim success from an exit code alone; a green `deploy` does not mean bundles are Active.
- Write config without user confirmation, or ask for a DB password in chat.
- Delete `bundles/`, drop a database, or push to a remote without an explicit yes.

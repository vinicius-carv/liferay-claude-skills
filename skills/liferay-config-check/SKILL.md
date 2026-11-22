---
name: liferay-config-check
description: Use when a Liferay workspace deploys fine but the portal misbehaves or ignores settings, when portal-ext.properties or OSGi .config files may be malformed, when a database connection fails, or when a local config must be created for a fresh clone.
---

# Liferay config check

Verifies `portal-ext.properties`, the `configs/<env>` overlay and OSGi `.config` files, and can define a minimal local config. The skill's base directory is shown when it loads; the checker is `<base>/scripts/check-config.mjs`.

## Check flow

1. Find the workspace root (the directory whose `settings.gradle` applies `com.liferay.workspace`).
2. Run `node "<base>/scripts/check-config.mjs" "<workspace>" [--env <name>]`. Add `--json` if you need to process findings. Default env is `local`. Exit 0 = no error findings, 1 = at least one error, 2 = bad usage.
3. Show the findings. For each one, explain what it means and give the concrete fix (file, line, corrected text). Severities: `error`, `warn`, `info`.
4. What the checker covers: missing `configs/common` or `configs/<env>`; duplicate keys; broken `\` continuations; missing `jdbc.default.*` (embedded HSQL is fine for dev, not for shared data); DB host:port reachability (2 s TCP timeout); OSGi `.config` typed-value syntax (`key="v"`, `key=I"1"`, `key=B"true"`, `key=["a","b"]`), file naming (`<pid>.config`, `<factoryPid>~<name>.config`; legacy `-name` is noted), and `.cfg` files (untyped).
5. Fix only what the user agrees to. Re-run the script after each fix and report the new result.

An unreachable DB port may just mean the database is not started yet; say so rather than declaring the config wrong.

## Define flow (no usable local config)

Use when `configs/local/portal-ext.properties` is missing and the user wants one.

1. Ask: database type (MySQL, PostgreSQL, or HSQL/embedded), host, port, database name, user.
2. **Never ask for the DB password in chat.** Tell the user to put it in `gradle-local.properties` or `configs/local/portal-ext.properties` themselves, or to supply it through an environment variable. Leave the placeholder below.
3. Show the proposed file and wait for explicit confirmation. Only then write `<workspace>/configs/local/portal-ext.properties` (create the folder if needed). Never overwrite an existing file without showing a diff and getting a yes.
4. Re-run the checker on the result.

Template (drop the `jdbc.default.*` block for HSQL):

```properties
include-and-override=portal-developer.properties
setup.wizard.enabled=false
browser.launcher.url=

# MySQL
jdbc.default.driverClassName=com.mysql.cj.jdbc.Driver
jdbc.default.url=jdbc:mysql://<host>:<port>/<db>?characterEncoding=UTF-8&dontTrackOpenResources=true&holdResultsOpenOverStatementClose=true&serverTimezone=GMT&useFastDateParsing=false&useUnicode=true
jdbc.default.username=<user>
jdbc.default.password=<set by the user, not in chat>

# PostgreSQL (use instead of the MySQL block)
# jdbc.default.driverClassName=org.postgresql.Driver
# jdbc.default.url=jdbc:postgresql://<host>:<port>/<db>
# jdbc.default.username=<user>
# jdbc.default.password=<set by the user, not in chat>
```

The database itself must already exist (UTF-8) and the JDBC driver must be available to the bundle; the checker creates neither.

## Report

Only verified facts: which files were read, the finding list with severities, what was changed and the re-run result. Say "DB reachable" only if the checker's TCP probe passed (that proves the port is open, not that credentials work).

## Never

- Write or modify config files without the user's confirmation.
- Ask for, echo or store a DB password.
- Claim the config is correct from exit code 0 alone; summarize what was actually checked.
- Edit `bundles/` copies as if they were the source; the source of truth is `configs/<env>`.

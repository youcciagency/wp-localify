# wp-localify

Pull live WordPress sites into local Docker environments — multi-site, HTTPS, one CLI.

```bash
wp-localify site add     # one-time wizard per site
wp-localify pull         # fetch files + database from the remote host
wp-localify import       # start the stack, import DB, rewrite URLs
wp-localify open         # https://<site>.test
```

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [How it works](#how-it-works)
- [Command reference](#command-reference)
  - [Global flags](#global-flags)
  - [Setup & configuration](#setup--configuration)
  - [Pull & import](#pull--import)
  - [Site lifecycle](#site-lifecycle)
  - [Inspect & debug](#inspect--debug)
  - [Gateway](#gateway)
  - [Shell completions](#shell-completions)
- [Non-interactive / CI usage](#non-interactive--ci-usage)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Security model](#security-model)
- [Database notes](#database-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- **macOS or Linux** (on Windows, run inside WSL2)
- Node.js ≥ 20
- Docker Desktop (or Docker Engine + compose plugin)
- [mkcert](https://github.com/FiloSottile/mkcert) — local TLS certificates
- `rsync` (SSH pulls), `lftp` (FTP pulls), `mysqldump` (`mysql-client`)
- `sudo` — to append entries to `/etc/hosts`

Run `wp-localify check` to verify everything is installed.

## Install

```bash
npm install -g wp-localify
# or from a checkout:
pnpm install && pnpm build && npm link
```

## How it works

Each site gets a key, a local domain (`<name>.test` by default), and a storage root under `~/wp-localify/sites/<key>/`:

```
~/wp-localify/
├── sites.json          # registry: site configs (no secrets — see below)
├── sites/<key>/
│   ├── wp/             # WordPress files pulled via rsync/lftp
│   ├── db/dump.sql.gz  # database dump pulled via mysqldump
│   ├── certs/          # mkcert certificate + key
│   ├── docker/         # docker-compose.yml + .env (chmod 600)
│   └── snapshots/      # local DB snapshots from `db-export`
└── gateway/            # shared nginx TLS proxy on :80/:443
```

All sites share one Docker network and one nginx gateway that terminates HTTPS per domain, so adding a site never interrupts the others.

## Command reference

### Global flags

Every command accepts:

| Flag            | Effect                                  |
| --------------- | --------------------------------------- |
| `-y, --yes`     | Accept confirmation prompts             |
| `--json`        | Machine-readable output where supported |
| `-v, --verbose` | Print every underlying command          |
| `-q, --quiet`   | Reduce output                           |
| `-V, --version` | Print the CLI version                   |
| `-h, --help`    | Help for any command or subcommand      |

Most site-scoped commands also accept these shared options:

| Option          | Effect                                                                                 |
| --------------- | -------------------------------------------------------------------------------------- |
| `--site <key>`  | Target a site (defaults to the active site)                                            |
| `--reconfigure` | Prompt through the config wizard first, then run the command with the updated settings |

### Setup & configuration

| Command                  | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `site add`               | Interactive wizard: writes the config, generates certs/hosts/stack, and registers the site |
| `config`                 | Create the first config or edit an existing one (`--site <key>`)                           |
| `site edit --site <key>` | Update a site's configuration and rebuild its artifacts                                    |
| `check [--site <key>]`   | Verify dependencies are installed (tailored to the site's protocol)                        |
| `init`                   | (Re)generate a site's stack artifacts, TLS certs, hosts entry, and gateway config          |

`init` is useful when you want to regenerate infrastructure without touching pulled data — for example after upgrading wp-localify or changing ports. It accepts `--site <key>` and `--reconfigure`.

Renaming a site's key via `site edit` / `config` is fully supported: wp-localify stops the old docker project, relocates its managed storage (`wp/`, dumps, certs, snapshots) under `<new-key>/`, rewrites `localWpPath`, removes the stale nginx server block, and re-keys its keychain secrets. Custom (non-managed) WordPress paths are left in place. If the local domain changed, the old cert is discarded and regenerated.

### Pull & import

| Command        | Description                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| `pull`         | Pull WP files + export DB. Skips whichever part already exists locally             |
| `pull-files`   | Files only (rsync over SSH, or parallel lftp mirror over FTP)                      |
| `pull-db`      | Export the remote DB only. `--via ssh-tunnel` for hosts that firewall direct MySQL |
| `import`       | Start the stack, import the DB, replace URLs (search-replace across all tables)    |
| `import-db`    | Import only (streamed straight into `mysql`, no temp copy)                         |
| `replace-urls` | Rewrite remote → local URLs, pin `home`/`siteurl`, flush cache                     |
| `all`          | `init` + `pull` + `import` in one go                                               |
| `rebuild`      | Fresh pull of files + DB, **wipes the local DB**, imports, replaces URLs           |

Options:

| Command     | Option                     | Effect                                                        |
| ----------- | -------------------------- | ------------------------------------------------------------- |
| `import`    | `--skip-up`                | Don't start containers (assumes the stack is already running) |
| `import-db` | `--skip-up`                | Same as above                                                 |
| `pull-db`   | `--via direct\|ssh-tunnel` | Override the site's configured DB access mode for this run    |
| `rebuild`   | `--skip-files`             | Skip pulling WordPress files                                  |
| `rebuild`   | `--skip-db`                | Skip exporting the remote database                            |
| `rebuild`   | `--no-init`                | Skip regenerating stack artifacts, certs, and hosts entry     |
| `rebuild`   | `--via direct\|ssh-tunnel` | Override the site's configured DB access mode for this run    |

`rebuild` asks for confirmation before it touches anything (bypass with `--yes`) and suggests running `wp-localify db-export` first so you keep a local snapshot.

`all` and `pull` skip pieces that already exist (`wp/` present → skip files; `dump.sql.gz` present → skip export), so they are safe to re-run. `rebuild` never skips — that is the point.

### Site lifecycle

| Command                       | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| `site list`                   | List all configured sites (`*` marks the active one)                |
| `site use [key]`              | Set the active site; prompts with a picker if `key` is omitted      |
| `site status [--site <key>]`  | Status for all sites (or one): running services, dumps, hosts entry |
| `site start [--site <key>]`   | Start one site's containers                                         |
| `site stop [--site <key>]`    | Stop one site's containers                                          |
| `site restart [--site <key>]` | Restart one site's containers                                       |
| `site start-all`              | Start every configured site                                         |
| `site stop-all`               | Stop every configured site                                          |
| `site remove [--site <key>]`  | Remove a site (see below)                                           |

`site status` prints a table by default; pass the global `--json` flag for machine-readable output.

`site remove` is safe by default: containers, registry entry, and keychain secrets are removed, but your pulled files, dumps, certs, and snapshots are kept. Add `--purge` to also delete the managed storage directory and Docker volumes (custom, non-managed WordPress paths are never deleted — the command tells you where they live). Pass `--yes` (or the global `-y`) to skip the confirmation; in non-interactive sessions `--yes` is required.

### Inspect & debug

| Command                       | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `logs [db\|wordpress\|wpcli]` | Tail container logs (default service: `wordpress`); add `-f`/`--follow` to follow |
| `open`                        | Open `https://<domain>` in your browser                                           |
| `wp <args…>`                  | Run any WP-CLI command inside the container, e.g. `wp-localify wp plugin list`    |
| `shell`                       | bash inside the WordPress container                                               |
| `db-export`                   | Snapshot the local DB to `<storage>/snapshots/<timestamp>.sql.gz`                 |

### Gateway

| Command           | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `gateway start`   | Start the shared nginx HTTPS gateway                  |
| `gateway stop`    | Stop it                                               |
| `gateway restart` | Regenerate config, stop, and start                    |
| `gateway status`  | Show whether it is running, plus the HTTP/HTTPS ports |

The gateway terminates TLS for all sites and is started automatically by `init` / `all` / `site add`; you rarely need to manage it by hand.

### Shell completions

```bash
# bash
wp-localify completions bash > ~/.wp-localify-completion.bash && echo 'source ~/.wp-localify-completion.bash' >> ~/.bashrc

# zsh
mkdir -p ~/.zfunc && wp-localify completions zsh > ~/.zfunc/_wp-localify
fpath=(~/.zfunc $fpath)          # before compinit in .zshrc
```

Running `completions` without an argument picks the script for your `$SHELL`. Completions are context-aware — subcommands per group, service names for `logs`, and your **real site keys** after `--site` — powered by an internal `__complete <tokens…>` command.

## Non-interactive / CI usage

Set `WP_LOCALIFY_NONINTERACTIVE=1` and every prompt becomes a fail-fast error with guidance instead of hanging:

```bash
export WP_LOCALIFY_NONINTERACTIVE=1
wp-localify pull --site client-x -y          # explicit site + confirmations
wp-localify rebuild --site client-x -y --skip-files
```

Commands that need a decision (site pickers, the `rebuild` confirmation) require you to pass `--site <key>` / `--yes` explicitly.

## Exit codes

| Code  | Meaning                                                |
| ----- | ------------------------------------------------------ |
| `0`   | Success                                                |
| `1`   | Error (missing dependency, failed command, bad input)  |
| `130` | Interrupted — Ctrl-C or an aborted confirmation prompt |

Errors print a one-line `💡 hint` where the CLI knows a fix. Set `WP_LOCALIFY_DEBUG=1` for full stack traces.

## Environment variables

| Variable                        | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `WP_LOCALIFY_HOME`              | Override `~/wp-localify` (handy for tests/multi-user setups) |
| `WP_LOCALIFY_NONINTERACTIVE=1`  | Never prompt; fail with actionable errors                    |
| `WP_LOCALIFY_YES=1`             | Implies `--yes`                                              |
| `WP_LOCALIFY_VERBOSE=1`         | Implies `--verbose`                                          |
| `WP_LOCALIFY_NO_UPDATE_CHECK=1` | Disable the npm update notifier                              |
| `WP_LOCALIFY_DEBUG=1`           | Full stack traces on errors                                  |

## Security model

- **Secrets never touch `sites.json`.** DB and FTP passwords are stored in your OS keychain (macOS Keychain / libsecret via `secret-tool`). If no keychain service is available, wp-localify falls back to `~/wp-localify/secrets.json` with `chmod 600` and warns.
- **Passwords never appear in process lists or on disk.**
  - `mysqldump` receives its password through the `MYSQL_PWD` environment variable.
  - lftp reads `LFTP_PASSWORD` from the environment; the generated script contains no credentials.
  - The Docker stack receives DB credentials through a `chmod 600` `.env` file next to the compose file — the compose YAML only references `${LOCAL_DB_*}` placeholders.
- **Registry writes are atomic** (temp file + rename). A corrupted `sites.json` is backed up automatically instead of crashing.
- Any older registry with plaintext secrets (or the legacy single-site `.wp-localize.json` config) is migrated into the keychain automatically on first run.

## Database notes

- Dumps stream through a sanitizer that rewrites MySQL 8's `utf8mb4_0900_*` collations to `utf8mb4_unicode_ci`, so MySQL 8 exports import cleanly into the default MariaDB 10.11 container. If your host runs MySQL 8, pick "MySQL 8" as the engine in the wizard (or set `dbEngine` in `sites.json`) for a native match.
- Table-prefix detection handles non-standard prefixes and WordPress multisite by ranking candidate prefixes against core tables and scoring each prefix's `siteurl`/`home` rows against your domains.
- If the remote DB only accepts connections from the web server itself, choose **SSH tunnel** during setup or pass `--via ssh-tunnel` to `pull-db` / `rebuild`.

## Troubleshooting

- **`wp-localify check` fails** — it names the missing tool and, where possible, the install command for your platform.
- **Site won't resolve** — the `/etc/hosts` entry may be missing after a rename or OS update; run `wp-localify init --site <key>` (needs `sudo`) to regenerate it.
- **Certificate warnings** — mkcert's local CA may not be trusted in this machine/user yet; run `mkcert -install`, then `gateway restart`.
- **Port 80/443 busy** — another service (often a local Apache/nginx) owns the gateway ports; free them and run `gateway start`.
- **Imported site shows remote URLs** — run `wp-localify replace-urls`.
- **Something blew up unexpectedly** — re-run with `WP_LOCALIFY_DEBUG=1` for a full stack trace, and with `-v` to see every underlying command as it runs.

## Development

```bash
pnpm install
pnpm dev          # rebuild on change (tsup --watch)
pnpm build        # bundle to dist/cli.js (+ postbuild step)
pnpm test         # vitest: unit suites + mocked-execa integration suites
pnpm lint         # oxlint over src, tests, scripts
pnpm fmt          # prettier
pnpm typecheck    # tsc --noEmit (strict)
node dist/cli.js --help
```

Smoke-test the built CLI against an isolated home directory without touching your real setup:

```bash
WP_LOCALIFY_HOME=/tmp/wp-localify-test node dist/cli.js site list
```

### Project layout

```
src/
├── cli.ts            # program wiring, global flags, error/interrupt handling
├── commands/         # one module per command group (lifecycle, importing, site, extras, completions)
├── site/             # site context paths, artifact generation, key renames
├── registry/         # sites.json store (atomic writes), schema, active-site selection
├── secrets/          # OS keychain integration
├── docker/           # compose invocation, gateway, compose/nginx templates
├── wordpress/        # pull-files (rsync/lftp), pull-db (+ ssh tunnel), import, URL replace, prefix detection
├── system/           # dependency checks, mkcert certs, /etc/hosts, platform helpers
├── ui/               # prompts, spinner, status rendering, global-flag/env handling
└── errors.ts         # CliError + exit codes
tests/
├── *.test.ts         # unit tests (pure helpers)
└── integration/      # CLI-level suites with mocked execa — no Docker required
```

### Adding a command

1. Register it in the matching `src/commands/*.ts` module (create a new module if it belongs to a new group), and wire the module in `buildProgram()` in `src/cli.ts`.
2. If it's site-scoped, wrap it with `addSiteOptions()` and resolve the site via `loadSiteForAction()`.
3. Add it to the completion candidates in `src/commands/completions.ts` so tab completion keeps working.
4. Cover behavior in `tests/` (unit or a mocked-execa integration suite) and run `pnpm lint && pnpm typecheck && pnpm test`.

CI runs lint, typecheck, and tests on every push/PR; the release workflow publishes tagged versions to npm.

## License

wp-localify is licensed under the [Elastic License 2.0 (ELv2)](https://www.elastic.co/licensing/elastic-license) — see [`LICENSE`](./LICENSE).

**You may** use, copy, modify, and redistribute it — freely, including inside businesses and for client work.

**You may not**:

1. offer it to third parties as a hosted or managed service,
2. circumvent license-key functionality, or
3. remove or obscure licensing, copyright, or trademark notices.

Version 1.0.0 was released under the ISC license and remains available under those terms.

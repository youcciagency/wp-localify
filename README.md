# wp-localify

Pull live WordPress sites into local Docker environments — multi-site, HTTPS, one CLI.

```
wp-localify site add     # one-time wizard per site
wp-localify pull         # fetch files + database from the remote host
wp-localify import       # start the stack, import DB, rewrite URLs
wp-localify open         # https://<site>.test
```

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

## Concepts

Each site gets a key, a local domain (`<name>.test` by default), and a storage root under `~/wp-localify/sites/<key>/`:

```
~/wp-localify/
├── sites.json          # registry: site configs (no secrets — see below)
├── sites/<key>/
│   ├── wp/             # WordPress files pulled via rsync/lftp
│   ├── db/dump.sql.gz  # database dump pulled via mysqldump
│   ├── certs/          # mkcert certificate + key
│   └── docker/         # docker-compose.yml + .env (chmod 600)
└── gateway/            # shared nginx TLS proxy on :80/:443
```

All sites share one Docker network and one nginx gateway that terminates HTTPS per domain, so adding a site never interrupts the others.

## Security model

- **Secrets never touch `sites.json`.** DB and FTP passwords are stored in your OS keychain (macOS Keychain / libsecret via `secret-tool`). If no keychain service is available, wp-localify falls back to `~/wp-localify/secrets.json` with `chmod 600` and warns.
- **Passwords never appear in process lists or on disk.**
  - `mysqldump` receives its password through the `MYSQL_PWD` environment variable.
  - lftp reads `LFTP_PASSWORD` from the environment; the generated script contains no credentials.
  - The Docker stack receives DB credentials through a `chmod 600` `.env` file next to the compose file — the compose YAML only references `${LOCAL_DB_*}` placeholders.
- **Registry writes are atomic** (temp file + rename). A corrupted `sites.json` is backed up automatically instead of crashing.
- Any older registry with plaintext secrets (or the legacy single-site `.wp-localize.json` config) is migrated into the keychain automatically on first run.

## Commands

### Setup

| Command                  | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `site add`               | Interactive wizard; writes config + initializes the site |
| `config`                 | Create the first config or edit an existing one          |
| `site edit --site <key>` | Update a site's configuration and rebuild artifacts      |
| `check [--site <key>]`   | Verify dependencies are installed                        |

Renaming a site's key via `site edit` / `config` is fully supported: wp-localify stops the old docker project, relocates its managed storage (`wp/`, dumps, certs, snapshots) under `<new-key>/`, rewrites `localWpPath`, removes the stale nginx server block, and re-keys its keychain secrets. Custom (non-managed) WordPress paths are left in place.

### Pull / import

| Command        | Description                                                                      |
| -------------- | -------------------------------------------------------------------------------- |
| `pull`         | Pull WP files + export DB (skips whichever already exists)                       |
| `pull-files`   | Files only (rsync over SSH, or parallel lftp mirror over FTP)                    |
| `pull-db`      | Export remote DB. `--via ssh-tunnel` for hosts that firewall direct MySQL access |
| `import`       | Start stack + import DB + replace URLs (search-replace across all tables)        |
| `import-db`    | Import only (streamed straight into `mysql`, no temp copy)                       |
| `replace-urls` | Rewrite remote → local URLs, pin home/siteurl, flush cache                       |
| `all`          | init + pull + import in one go                                                   |
| `rebuild`      | Fresh pull of files + DB, **wipes the local DB**, imports, replaces URLs          |

### Day-to-day

| Command                                                      | Description                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `site list` / `site use <key>`                               | List sites / set active site                                                   |
| `site start` / `stop` / `restart` / `start-all` / `stop-all` | Lifecycle                                                                      |
| `site status [--json]`                                       | Per-site status table (running services, dumps, hosts entry)                   |
| `logs [-f] [db\|wordpress\|wpcli]`                           | Tail container logs                                                            |
| `open`                                                       | Open `https://<domain>` in your browser                                        |
| `wp <args…>`                                                 | Run any WP-CLI command inside the container, e.g. `wp-localify wp plugin list` |
| `shell`                                                      | bash inside the WordPress container                                            |
| `db-export`                                                  | Snapshot the local DB to `<storage>/snapshots/<timestamp>.sql.gz`              |
| `gateway start\|stop\|restart\|status`                       | Manage the shared nginx gateway                                                |
| `site remove [--purge]`                                      | Remove a site (keeps files unless `--purge`; deletes its keychain secrets)     |
| `completions [bash\|zsh]`                                    | Print a shell completion script (see below)                                    |

### Shell completions

```bash
# bash
wp-localify completions bash > ~/.wp-localify-completion.bash && echo 'source ~/.wp-localify-completion.bash' >> ~/.bashrc

# zsh
mkdir -p ~/.zfunc && wp-localify completions zsh > ~/.zfunc/_wp-localify
fpath=(~/.zfunc $fpath)          # before compinit in .zshrc
```

Completions are context-aware — subcommands per group, service names for `logs`, and your **real site keys** after `--site` — powered by an internal `__complete <tokens…>` command.

### Global flags

| Flag            | Effect                                  |
| --------------- | --------------------------------------- |
| `-y, --yes`     | Accept confirmation prompts             |
| `--json`        | Machine-readable output where supported |
| `-v, --verbose` | Print every underlying command          |
| `-q, --quiet`   | Reduce output                           |

Non-interactive environments (CI): set `WP_LOCALIFY_NONINTERACTIVE=1`. Commands needing prompts then fail fast with guidance instead of hanging — pass `--site <key>` / `--yes` explicitly.

## Environment variables

| Variable                        | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `WP_LOCALIFY_HOME`              | Override `~/wp-localify` (handy for tests/multi-user setups) |
| `WP_LOCALIFY_NONINTERACTIVE=1`  | Never prompt; fail with actionable errors                    |
| `WP_LOCALIFY_YES=1`             | Implies `--yes`                                              |
| `WP_LOCALIFY_VERBOSE=1`         | Implies `--verbose`                                          |
| `WP_LOCALIFY_NO_UPDATE_CHECK=1` | Disable the npm update notifier                              |
| `WP_LOCALIFY_DEBUG=1`           | Full stack traces on errors                                  |

## Database notes

- Dumps stream through a sanitizer that rewrites MySQL 8's `utf8mb4_0900_*` collations to `utf8mb4_unicode_ci`, so MySQL 8 exports import cleanly into the default MariaDB 10.11 container. If your host runs MySQL 8, pick "MySQL 8" as the engine in the wizard (or set `dbEngine` in `sites.json`) for a native match.
- Table-prefix detection handles non-standard prefixes and WordPress multisite by ranking candidate prefixes against core tables and scoring each prefix's `siteurl`/`home` rows against your domains.
- If the remote DB only accepts connections from the web server itself, choose **SSH tunnel** during setup or pass `--via ssh-tunnel` to `pull-db`.

## Development

```bash
pnpm install
pnpm dev          # rebuild on change
pnpm test         # unit suites + mocked-execa integration suites
pnpm lint         # oxlint
pnpm typecheck    # tsc --noEmit (strict)
pnpm build        # bundle to dist/cli.js
node dist/cli.js --help
```

Integration smoke-testing without touching your real setup:

```bash
WP_LOCALIFY_HOME=/tmp/wp-localify-test node dist/cli.js site list
```

## License

ISC

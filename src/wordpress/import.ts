import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Options as ExecaOptions, ResultPromise } from "execa";
import { CliError } from "../errors.js";
import { pathExists } from "../fsutils.js";
import { resolveSiteSecrets } from "../secrets/keychain.js";
import { posixDoubleQuote } from "../text.js";
import { runSiteCompose, runSiteComposeQuiet, type ComposeResult } from "../docker/compose.js";
import { isServiceRunning, upSite } from "../site/artifacts.js";
import { patchWpConfigSafe, syncWpConfigTablePrefix, wpConfigPathFor } from "./wpconfig.js";
import { parseOptionRows, rankWordPressTablePrefixes, scorePrefixBySiteUrl } from "./prefix.js";
import type { GatewaySettings, SiteConfig, SiteContext } from "../types.js";

export async function hasDbFiles(ctx: SiteContext): Promise<boolean> {
  return (await pathExists(ctx.files.dumpGz)) || (await pathExists(ctx.files.dumpSql));
}

/** Options for {@link importDb}. */
export interface ImportDbOptions {
  /**
   * Drop every existing table and view before streaming the dump in. Used by
   * `rebuild` so the import starts from a clean slate instead of merging into
   * leftover schema (tables from uninstalled plugins, stale rows, …).
   */
  wipe?: boolean;
}

async function mysqlExec(
  ctx: SiteContext,
  user: string,
  password: string,
  dbName: string,
  extraArgs: string[],
): Promise<ComposeResult> {
  return runSiteComposeQuiet(
    ctx,
    [
      "exec",
      "-T",
      "-e",
      `MYSQL_PWD=${password}`,
      "db",
      "mysql",
      "-h127.0.0.1",
      "-u",
      user,
      ...extraArgs,
      dbName,
    ],
    { stdio: ["ignore", "pipe", "pipe"] as ExecaOptions["stdio"] },
  );
}

export async function waitForDb(site: SiteConfig, ctx: SiteContext, maxAttempts = 30): Promise<void> {
  const secrets = await resolveSiteSecrets(site.key);

  for (let index = 0; index < maxAttempts; index += 1) {
    const check = await mysqlExec(ctx, site.localDbUser, secrets.localDbPass, site.localDbName, [
      "-e",
      "SELECT 1",
    ]);
    if (check.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new CliError("Database container is not responding.", {
    hint: `Inspect it with \`wp-localify logs db --site ${site.key}\`.`,
  });
}

async function dumpInputStream(ctx: SiteContext): Promise<{
  stream: NodeJS.ReadableStream;
  cleanup(): Promise<void>;
}> {
  if (await pathExists(ctx.files.dumpGz)) {
    return {
      stream: createReadStream(ctx.files.dumpGz).pipe(createGunzip()),
      cleanup: async () => {
        await rm(ctx.files.dumpGz, { force: true });
        await rm(ctx.files.dumpSql, { force: true });
      },
    };
  }

  if (await pathExists(ctx.files.dumpSql)) {
    return {
      stream: createReadStream(ctx.files.dumpSql),
      cleanup: async () => {
        await rm(ctx.files.dumpSql, { force: true });
      },
    };
  }

  throw new CliError(`Missing SQL dump at ${ctx.files.dumpGz}.`, {
    hint: "Run `wp-localify pull-db` first.",
  });
}

/**
 * Import a dump into the local DB by streaming it straight into
 * `docker compose exec -T db mysql` — no intermediate uncompressed copy.
 */
export async function importDb(
  site: SiteConfig,
  ctx: SiteContext,
  settings: GatewaySettings,
  skipUp = false,
  options: ImportDbOptions = {},
): Promise<void> {
  const input = await dumpInputStream(ctx);

  if (!skipUp || !(await isServiceRunning(ctx, "db"))) {
    await upSite(site, ctx, settings);
  }

  await waitForDb(site, ctx);

  // Runs after the dump is validated above, so a rebuild never wipes the local
  // DB when there is nothing to import in its place.
  if (options.wipe === true) {
    await dropAllTables(site, ctx);
  }

  const secrets = await resolveSiteSecrets(site.key);
  const child: ResultPromise = runSiteCompose(
    ctx,
    [
      "exec",
      "-T",
      "-e",
      `MYSQL_PWD=${secrets.localDbPass}`,
      "db",
      "mysql",
      "-h127.0.0.1",
      "-u",
      site.localDbUser,
      site.localDbName,
    ],
    { stdio: ["pipe", "inherit", "inherit"] as ExecaOptions["stdio"] },
  );

  if (!child.stdin) {
    throw new CliError("Could not open a stdin pipe to the mysql import process.");
  }

  try {
    await pipeline(input.stream, child.stdin);
    const result = await child;
    if (result.failed || result.exitCode !== 0) {
      throw new CliError(`Database import failed (exit ${result.exitCode}).`);
    }
  } catch (error) {
    child.kill("SIGKILL");
    // Keep the dump when the import fails so users can retry without re-pulling.
    throw error instanceof CliError ? error : new CliError(`Database import failed: ${String(error)}`);
  }

  // Only reached on success: failures above keep the dump for a retry.
  await input.cleanup();
}

/** Query SHOW TABLES through the db container. */
async function listTables(site: SiteConfig, ctx: SiteContext): Promise<string[] | null> {
  const secrets = await resolveSiteSecrets(site.key);
  const result = await mysqlExec(ctx, site.localDbUser, secrets.localDbPass, site.localDbName, [
    "-N",
    "-B",
    "-e",
    "SHOW TABLES",
  ]);
  if (!result.ok) return null;

  const tables = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return tables.length > 0 ? tables : null;
}

interface FullTable {
  name: string;
  isView: boolean;
}

/** Query SHOW FULL TABLES through the db container (name + BASE TABLE/VIEW type). */
async function listFullTables(site: SiteConfig, ctx: SiteContext): Promise<FullTable[]> {
  const secrets = await resolveSiteSecrets(site.key);
  const result = await mysqlExec(ctx, site.localDbUser, secrets.localDbPass, site.localDbName, [
    "-N",
    "-B",
    "-e",
    "SHOW FULL TABLES",
  ]);
  if (!result.ok) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, type] = line.split("\t");
      return { name: name ?? "", isView: type === "VIEW" };
    })
    .filter((entry) => entry.name.length > 0);
}

/**
 * Drop every table and view in the local database so a rebuild starts from a
 * clean slate.
 *
 * Runs as the site's own DB user: the compose template grants it ALL
 * PRIVILEGES on the database only, so `DROP DATABASE` + `CREATE DATABASE`
 * (which need global grants) are not available — tables are dropped
 * individually with foreign-key checks disabled for the batch. Views are
 * dropped with `DROP VIEW`; `DROP TABLE` against a view errors out.
 *
 * The script is piped over stdin: no argv size limits on pathological table
 * counts, no temp files, no credentials on the command line.
 */
export async function dropAllTables(site: SiteConfig, ctx: SiteContext): Promise<void> {
  const tables = await listFullTables(site, ctx);
  if (tables.length === 0) return;

  const script = [
    "SET FOREIGN_KEY_CHECKS=0;",
    ...tables.map(({ name, isView }) =>
      isView ? `DROP VIEW IF EXISTS \`${name}\`;` : `DROP TABLE IF EXISTS \`${name}\`;`,
    ),
    "SET FOREIGN_KEY_CHECKS=1;",
    "",
  ].join("\n");

  const secrets = await resolveSiteSecrets(site.key);
  const child: ResultPromise = runSiteCompose(
    ctx,
    [
      "exec",
      "-T",
      "-e",
      `MYSQL_PWD=${secrets.localDbPass}`,
      "db",
      "mysql",
      "-h127.0.0.1",
      "-u",
      site.localDbUser,
      site.localDbName,
    ],
    { stdio: ["pipe", "ignore", "pipe"] as ExecaOptions["stdio"] },
  );

  if (!child.stdin) {
    throw new CliError("Could not open a stdin pipe to the mysql drop-tables process.");
  }

  try {
    await pipeline(Readable.from([script]), child.stdin);
    const result = await child;
    if (result.failed || result.exitCode !== 0) {
      throw new CliError(`Dropping existing tables failed (exit ${result.exitCode}).`);
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error instanceof CliError
      ? error
      : new CliError(`Dropping existing tables failed: ${String(error)}`);
  }
}

async function getPrefixOptionRows(
  site: SiteConfig,
  ctx: SiteContext,
  prefix: string,
): Promise<Array<{ optionValue?: string }>> {
  const secrets = await resolveSiteSecrets(site.key);
  const result = await mysqlExec(ctx, site.localDbUser, secrets.localDbPass, site.localDbName, [
    "-N",
    "-B",
    "-e",
    `SELECT option_name, option_value FROM \`${prefix}options\` WHERE option_name IN ('siteurl', 'home')`,
  ]);
  if (!result.ok) return [];
  return parseOptionRows(result.stdout);
}

/**
 * Detect the imported table prefix and mirror it into wp-config.php.
 * Uses table-shape ranking first; ties are broken by which prefix's options
 * table mentions this site's local/remote URLs.
 */
export async function syncWpConfigPrefixFromDb(site: SiteConfig, ctx: SiteContext): Promise<string | null> {
  const tables = await listTables(site, ctx);
  if (!tables) return null;

  // Fast path: unambiguous winner without extra queries.
  const ranked = rankWordPressTablePrefixes(tables);
  if (ranked.length === 0) return null;

  let bestPrefix: string | null = ranked[0]?.prefix ?? null;
  if (ranked.length > 1) {
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of ranked) {
      const rows = await getPrefixOptionRows(site, ctx, candidate.prefix);
      const totalScore = candidate.score + scorePrefixBySiteUrl(candidate.prefix, rows, site);
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestPrefix = candidate.prefix;
      }
    }
  }

  if (!bestPrefix) return null;
  await syncWpConfigTablePrefix(ctx, bestPrefix);
  return bestPrefix;
}

export async function runWpCli(ctx: SiteContext, command: string): Promise<void> {
  await runSiteCompose(ctx, ["run", "--rm", "wpcli", command]);
}

/**
 * Replace remote URLs with the local URL across all tables, then pin home and
 * siteurl and flush cache.
 *
 * The primary replacement uses the BARE HOST (no scheme): page builders like
 * Elementor store URLs with escaped slashes (`https:\/\/example.com`) inside
 * serialized JSON, where a scheme-bearing needle can never match. The bare
 * host matches those, plain URLs, and every scheme variant in one pass.
 * Scheme pairs run afterwards as a cheap safety net.
 */
export async function replaceUrls(
  site: SiteConfig,
  ctx: SiteContext,
  settings: GatewaySettings,
): Promise<void> {
  const localUrl = `https://${site.localDomain}`;
  const remoteHttps = site.remoteDomain.replace(/\/+$/, "");
  const remoteHost = remoteHttps.replace(/^https?:\/\//, "");
  const altHost = remoteHost.startsWith("www.") ? remoteHost.slice(4) : `www.${remoteHost}`;

  await upSite(site, ctx, settings);
  await waitForDb(site, ctx);

  if (!(await pathExists(wpConfigPathFor(ctx)))) {
    throw new CliError(`wp-config.php not found at ${wpConfigPathFor(ctx)}.`, {
      hint: "Run `wp-localify pull-files` first.",
    });
  }

  await syncWpConfigPrefixFromDb(site, ctx);

  const replacePairs: Array<[string, string]> = [
    [remoteHost, site.localDomain],
    [altHost, site.localDomain],
    [remoteHttps, localUrl],
    [remoteHttps.replace(/^https:/, "http://"), localUrl],
  ];

  for (const [from, to] of replacePairs) {
    const command = `wp search-replace ${posixDoubleQuote(from)} ${posixDoubleQuote(to)} --all-tables --precise`;
    try {
      await runWpCli(ctx, command);
    } catch {
      // Host variants may not exist in DB; keep going.
    }
  }

  await runWpCli(ctx, `wp option update home ${posixDoubleQuote(localUrl)}`);
  await runWpCli(ctx, `wp option update siteurl ${posixDoubleQuote(localUrl)}`);
  await runWpCli(ctx, "wp cache flush");

  await patchWpConfigSafe(ctx);

  // Surface silent partial replacements instead of hiding them.
  const remaining = await countRemainingRemoteReferences(site, ctx);
  if (remaining.total > 0) {
    console.error(
      `\n⚠️  ${remaining.total} DB row(s) still reference ${remoteHost} after replacement ` +
        `(options: ${remaining.options}, posts: ${remaining.posts}, postmeta: ${remaining.postmeta}).\n` +
        `Re-run 'wp-localify replace-urls --site ${site.key}', and check theme files — ` +
        `hardcoded URLs in PHP/JSON templates can only be fixed in the theme itself.`,
    );
  }
}

/** Post-replacement audit: remaining live-domain hits in the big three tables. */
async function countRemainingRemoteReferences(
  site: SiteConfig,
  ctx: SiteContext,
): Promise<{ total: number; options: number; posts: number; postmeta: number }> {
  const remoteHost = site.remoteDomain.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const secrets = await resolveSiteSecrets(site.key);

  const probe = async (table: string, column: string): Promise<number> => {
    const result = await runSiteComposeQuiet(
      ctx,
      [
        "exec",
        "-T",
        "-e",
        `MYSQL_PWD=${secrets.localDbPass}`,
        "db",
        "mysql",
        "-h127.0.0.1",
        "-u",
        site.localDbUser,
        site.localDbName,
        "-N",
        "-B",
        "-e",
        `SELECT COUNT(*) FROM \`${table}\` WHERE ${column} LIKE '%${remoteHost}%'`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!result.ok) return 0;
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const prefix = (await detectPrefixForAudit(site, ctx)) ?? "";
  const [options, posts, postmeta] = await Promise.all([
    probe(`${prefix}options`, "option_value"),
    probe(`${prefix}posts`, "post_content"),
    probe(`${prefix}postmeta`, "meta_value"),
  ]);

  return { total: options + posts + postmeta, options, posts, postmeta };
}

async function detectPrefixForAudit(site: SiteConfig, ctx: SiteContext): Promise<string | null> {
  const secrets = await resolveSiteSecrets(site.key);
  const result = await runSiteComposeQuiet(
    ctx,
    [
      "exec",
      "-T",
      "-e",
      `MYSQL_PWD=${secrets.localDbPass}`,
      "db",
      "mysql",
      "-h127.0.0.1",
      "-u",
      site.localDbUser,
      site.localDbName,
      "-N",
      "-B",
      "-e",
      "SHOW TABLES",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!result.ok) return null;
  const tables = result.stdout.split("\n").filter(Boolean);
  return prefixFromTables(tables);
}

/** Pure: best-effort prefix from table names. */
function prefixFromTables(tables: string[]): string | null {
  for (const table of tables) {
    if (table.endsWith("_options")) {
      return table.slice(0, -"options".length);
    }
  }
  return null;
}

export async function importAndReplace(
  site: SiteConfig,
  ctx: SiteContext,
  settings: GatewaySettings,
  skipUp = false,
  options: ImportDbOptions = {},
): Promise<void> {
  await importDb(site, ctx, settings, skipUp, options);
  await replaceUrls(site, ctx, settings);
}

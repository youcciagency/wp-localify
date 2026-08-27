import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createGunzip } from "node:zlib";
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
): Promise<void> {
  const input = await dumpInputStream(ctx);

  if (!skipUp || !(await isServiceRunning(ctx, "db"))) {
    await upSite(site, ctx, settings);
  }

  await waitForDb(site, ctx);

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
 */
export async function replaceUrls(
  site: SiteConfig,
  ctx: SiteContext,
  settings: GatewaySettings,
): Promise<void> {
  const localUrl = `https://${site.localDomain}`;
  const remoteHttps = site.remoteDomain.replace(/\/+$/, "");
  const remoteHttp = remoteHttps.replace(/^https:\/\//, "http://");

  const remoteHost = remoteHttps.replace(/^https?:\/\//, "");
  const altHost = remoteHost.startsWith("www.") ? remoteHost.slice(4) : `www.${remoteHost}`;
  const remoteHttpsAlt = `https://${altHost}`;
  const remoteHttpAlt = `http://${altHost}`;

  await upSite(site, ctx, settings);
  await waitForDb(site, ctx);

  if (!(await pathExists(wpConfigPathFor(ctx)))) {
    throw new CliError(`wp-config.php not found at ${wpConfigPathFor(ctx)}.`, {
      hint: "Run `wp-localify pull-files` first.",
    });
  }

  await syncWpConfigPrefixFromDb(site, ctx);

  const replacePairs: Array<[string, string]> = [
    [remoteHttps, localUrl],
    [remoteHttp, localUrl],
    [remoteHttpsAlt, localUrl],
    [remoteHttpAlt, localUrl],
  ];

  for (const [from, to] of replacePairs) {
    const command = `wp search-replace ${posixDoubleQuote(from)} ${posixDoubleQuote(to)} --all-tables --precise`;
    try {
      await runWpCli(ctx, command);
    } catch {
      // Some host variants may not exist in DB; keep going.
    }
  }

  await runWpCli(ctx, `wp option update home ${posixDoubleQuote(localUrl)}`);
  await runWpCli(ctx, `wp option update siteurl ${posixDoubleQuote(localUrl)}`);
  await runWpCli(ctx, "wp cache flush");

  await patchWpConfigSafe(ctx);
}

export async function importAndReplace(
  site: SiteConfig,
  ctx: SiteContext,
  settings: GatewaySettings,
  skipUp = false,
): Promise<void> {
  await importDb(site, ctx, settings, skipUp);
  await replaceUrls(site, ctx, settings);
}

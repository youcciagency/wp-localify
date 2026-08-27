import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { execa } from "execa";
import { CliError } from "../errors.js";
import { buildSiteContext } from "../site/context.js";
import { resolveSiteSecrets } from "../secrets/keychain.js";
import type { SiteConfig } from "../types.js";

function timestamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[:.]/g, "-");
}

/**
 * Snapshot the LOCAL database to <storage>/snapshots/<timestamp>.sql.gz by
 * streaming mysqldump from inside the db container.
 */
export async function exportLocalDbSnapshot(site: SiteConfig): Promise<string> {
  const ctx = buildSiteContext(site);
  await mkdir(ctx.files.snapshotsDir, { recursive: true });

  const secrets = await resolveSiteSecrets(site.key);
  const outPath = `${ctx.files.snapshotsDir}/${timestamp()}.sql.gz`;

  const dump = execa(
    "docker",
    [
      "compose",
      "-p",
      ctx.projectName,
      "-f",
      ctx.files.compose,
      "exec",
      "-T",
      "-e",
      `MYSQL_PWD=${secrets.localDbRootPass}`,
      "db",
      "mysqldump",
      "-h127.0.0.1",
      "-uroot",
      "--single-transaction",
      "--quick",
      "--routines",
      "--triggers",
      site.localDbName,
    ],
    { stdio: ["ignore", "pipe", "inherit"], cwd: ctx.dirs.docker },
  );

  try {
    await pipeline(dump.stdout, createGzip(), createWriteStream(outPath));
  } catch (error) {
    dump.kill("SIGKILL");
    throw new CliError(`Local DB export failed: ${String(error)}`);
  }

  return outPath;
}

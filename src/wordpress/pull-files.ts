import { run } from "../exec.js";
import { ensureDir } from "../fsutils.js";
import { checkDependencies } from "../system/deps.js";
import { patchWpConfigSafe } from "./wpconfig.js";
import type { SiteConfig, SiteContext } from "../types.js";

const RSYNC_EXCLUDES = [".git", "node_modules", "wp-content/cache", "wp-content/uploads/cache"] as const;

/**
 * Pull remote WordPress files into the local wp directory.
 *
 * The transfer tools are exec'd as argv arrays (no shell). For FTP the full
 * command script — including the password — is piped to lftp over stdin, so
 * credentials exist only in memory: never in argv (`ps`) and never on disk.
 */
export async function pullFiles(
  site: SiteConfig,
  ctx: SiteContext,
  options: { ftpPassword?: string } = {},
): Promise<void> {
  await checkDependencies(site, {
    needsMkcert: false,
    needsMysqldump: false,
    needsRsync: site.downloadProtocol === "ssh",
    needsLftp: site.downloadProtocol === "ftp",
  });

  await ensureDir(ctx.dirs.wp);

  if (site.downloadProtocol === "ssh") {
    const remotePath = site.remoteWpPath.replace(/\/+$/, "");
    const source = `${site.remoteSsh}:${remotePath}/`;
    await run("rsync", [
      "-avz",
      "--delete",
      "--partial",
      "--inplace",
      ...RSYNC_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      "--compress-level=1",
      "--info=progress2",
      source,
      `${ctx.dirs.wp}/`,
    ]);
  } else {
    const remotePath = site.remoteWpPath.replace(/\/+$/, "");
    const lftpScript = buildLftpScript(
      site.remoteFtpUser,
      site.remoteFtpHost,
      remotePath,
      ctx,
      site.parallelThreads,
      options.ftpPassword ?? "",
    );

    // Piped stdin instead of `-f scriptfile`: no temp credential files, and
    // nothing is removed in a finally block because nothing was ever written.
    await run("lftp", [], {
      stdio: ["pipe", "inherit", "inherit"] as const,
      input: lftpScript,
    });
  }

  await patchWpConfigSafe(ctx);
}

function buildLftpScript(
  user: string,
  host: string,
  remotePath: string,
  ctx: SiteContext,
  parallelThreads: number,
  password: string,
): string {
  const excludes = RSYNC_EXCLUDES.map((glob) => `--exclude-glob=${glob}`).join(" ");
  const login = password.length > 0 ? `${user},${password}` : user;
  return [
    "set ftp:list-options -a",
    "set cmd:fail-exit yes",
    "set net:max-retries 3",
    "set net:timeout 30",
    `open -u ${login} ${host}`,
    `lcd ${ctx.dirs.wp}`,
    `cd ${remotePath}`,
    `mirror --delete --parallel=${parallelThreads} ${excludes} --verbose`,
    "bye",
    "",
  ].join("\n");
}

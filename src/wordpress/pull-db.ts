import { createConnection, createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { execa, type ResultPromise } from "execa";
import { CliError } from "../errors.js";
import { ensureDir, pathExists } from "../fsutils.js";
import { checkDependencies } from "../system/deps.js";
import { createCollationSanitizer } from "../streams.js";
import { resolveSiteSecrets } from "../secrets/keychain.js";
import type { SiteConfig, SiteContext } from "../types.js";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close(() => {
        if (port > 0) resolve(port);
        else reject(new CliError("Could not allocate a local port for the SSH tunnel."));
      });
    });
    listener.on("error", reject);
  });
}

function waitUntilConnectable(port: number, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new CliError("SSH tunnel did not become reachable in time."));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

export interface TunnelHandle {
  localPort: number;
  close(): Promise<void>;
}

/**
 * Open an SSH port-forward so the remote DB is reachable at
 * 127.0.0.1:<localPort>. Handles hosts that only expose MySQL over SSH
 * (including remotes where the DB host is "localhost" relative to the server).
 */
export async function openDbTunnel(site: SiteConfig): Promise<TunnelHandle> {
  if (!site.remoteSsh) {
    throw new CliError("SSH tunnel mode needs 'remoteSsh' (user@host) configured for this site.", {
      hint: "Run `wp-localify site edit` and set the SSH target.",
    });
  }

  const localPort = await findFreePort();
  const remoteTarget = `${site.remoteDbHost}:${site.remoteDbPort}`;

  let sshProcess: ResultPromise;
  try {
    sshProcess = execa(
      "ssh",
      [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-L",
        `127.0.0.1:${localPort}:${remoteTarget}`,
        site.remoteSsh,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new CliError(
      `Could not start SSH tunnel: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Surface early failures (auth refused, forward denied) while waiting.
  const failure = new Promise<never>((_resolve, reject) => {
    sshProcess.once("error", (error: Error) => reject(error));
    void sshProcess.then(
      (result) => {
        const stderrText = typeof result.stderr === "string" ? result.stderr : "";
        reject(
          new CliError(`SSH tunnel exited early (code ${result.exitCode}).`, {
            hint: stderrText.trim().length > 0 ? stderrText.trim() : "Check SSH access to the remote host.",
          }),
        );
      },
      () => {},
    );
  });

  try {
    await Promise.race([waitUntilConnectable(localPort), failure]);
  } catch (error) {
    sshProcess.kill("SIGKILL");
    throw error;
  }

  return {
    localPort,
    close: async () => {
      sshProcess.kill("SIGTERM");
      await Promise.race([sshProcess, new Promise((resolve) => setTimeout(resolve, 2000))]);
      sshProcess.kill("SIGKILL");
    },
  };
}

export interface PullDbOptions {
  via?: "direct" | "ssh-tunnel";
}

/**
 * Export the remote database to <storage>/db/dump.sql.gz.
 *
 * - Password travels via the MYSQL_PWD env var (never argv, never `ps`).
 * - MySQL 8 collations (utf8mb4_0900_*) are rewritten to utf8mb4_unicode_ci
 *   during the stream so the dump imports cleanly into MariaDB.
 * - `via: "ssh-tunnel"` reaches DBs that are firewalled from direct access.
 */
export async function pullDb(
  site: SiteConfig,
  ctx: SiteContext,
  options: PullDbOptions = {},
): Promise<string> {
  const via = options.via ?? site.dbAccess ?? "direct";
  await checkDependencies(
    site,
    {
      needsMkcert: false,
      needsMysqldump: true,
      needsSsh: via === "ssh-tunnel",
    },
    true,
  );

  await ensureDir(ctx.dirs.db);

  const secrets = await resolveSiteSecrets(site.key);
  const tunnel = via === "ssh-tunnel" ? await openDbTunnel(site) : null;

  try {
    const host = tunnel ? "127.0.0.1" : site.remoteDbHost;
    const port = tunnel ? String(tunnel.localPort) : site.remoteDbPort;

    const mysqldump = execa(
      "mysqldump",
      [
        "-h",
        host,
        "-P",
        port,
        "-u",
        site.remoteDbUser,
        "--single-transaction",
        "--quick",
        "--routines",
        "--triggers",
        site.remoteDbName,
      ],
      {
        env: { MYSQL_PWD: secrets.remoteDbPass },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    await pipeline(
      mysqldump.stdout,
      createCollationSanitizer(),
      createGzip(),
      createWriteStream(ctx.files.dumpGz),
    );

    const result = await mysqldump;
    if (result.failed || result.exitCode !== 0) {
      throw new CliError(`mysqldump failed (exit ${result.exitCode}).`, {
        hint: "Verify remote DB host/port/user in `wp-localify site edit` and that remote access is permitted.",
      });
    }

    // Remove any legacy uncompressed dump from older versions.
    if (await pathExists(ctx.files.dumpSql)) {
      await rm(ctx.files.dumpSql, { force: true });
    }

    return ctx.files.dumpGz;
  } catch (error) {
    // Don't leave a truncated dump behind on failure.
    await rm(ctx.files.dumpGz, { force: true }).catch(() => {});
    throw error;
  } finally {
    await tunnel?.close();
  }
}

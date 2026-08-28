import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteConfig, SiteContext } from "../../src/types.js";

/* ---- module mocks -------------------------------------------------- */

const state = vi.hoisted(() => ({
  /** Every `runSiteCompose` call, in order, with the stdin payload it received. */
  calls: [] as Array<{ args: string[]; stdin: string }>,
  /** Rows returned by the mocked `SHOW FULL TABLES` query. */
  fullTables: "wp_options\tBASE TABLE\nwp_posts\tBASE TABLE\nwp_legacy\tVIEW",
  /** Rows returned by the mocked `SHOW TABLES` query. */
  showTables: "wp_options\nwp_posts",
}));

vi.mock("../../src/docker/compose.js", async () => {
  const { vi } = await import("vitest");
  const { Readable: ReadableStream, Writable: WritableStream } = await import("node:stream");
  return {
    runSiteCompose: vi.fn((_ctx: unknown, args: string[]) => {
      const entry = { args, stdin: "" };
      state.calls.push(entry);
      const stdin = new WritableStream({
        write(chunk: Buffer, _enc, callback) {
          entry.stdin += Buffer.from(chunk).toString("utf8");
          callback();
        },
      });
      return Object.assign(Promise.resolve({ failed: false, exitCode: 0, stderr: "" }), {
        stdin,
        stdout: ReadableStream.from([]),
        stderr: ReadableStream.from([]),
        kill: vi.fn(),
        once: vi.fn(),
        pid: 1,
      });
    }),
    runSiteComposeQuiet: vi.fn(async (_ctx: unknown, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("SHOW FULL TABLES")) {
        return { ok: true, stdout: state.fullTables, stderr: "" };
      }
      if (joined.includes("SHOW TABLES")) {
        return { ok: true, stdout: state.showTables, stderr: "" };
      }
      if (joined.includes("COUNT(*)")) {
        return { ok: true, stdout: "0", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }),
  };
});

vi.mock("../../src/site/artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/site/artifacts.js")>();
  return {
    ...actual,
    upSite: vi.fn(async () => {}),
    isServiceRunning: vi.fn(async () => true),
    writeSiteArtifacts: vi.fn(async () => {}),
    createSudoSpinnerHooks: vi.fn(() => ({
      before: async () => {},
      after: async () => {},
    })),
  };
});

vi.mock("../../src/wordpress/pull-files.js", () => ({
  pullFiles: vi.fn(async () => {}),
}));

vi.mock("../../src/wordpress/pull-db.js", () => ({
  pullDb: vi.fn(async () => "/does-not-matter/dump.sql.gz"),
}));

vi.mock("../../src/secrets/keychain.js", () => ({
  resolveSiteSecrets: vi.fn(async () => ({
    remoteDbPass: "remote-db-secret",
    remoteFtpPass: "ftp-secret",
    localDbPass: "local-wp-pass",
    localDbRootPass: "local-root-pass",
  })),
  setSecret: vi.fn(async () => {}),
  deleteSiteSecrets: vi.fn(async () => {}),
  renameSiteSecrets: vi.fn(async () => {}),
}));

/* ---- imports under test (after mocks) ------------------------------ */

import { buildProgram } from "../../src/cli.js";
import { BASE_HOME, REGISTRY_PATH } from "../../src/paths.js";
import { ensureDir } from "../../src/fsutils.js";
import { buildSiteConfig } from "../../src/registry/schema.js";
import { buildSiteContext } from "../../src/site/context.js";
import { dropAllTables } from "../../src/wordpress/import.js";
import { pullFiles } from "../../src/wordpress/pull-files.js";
import { pullDb } from "../../src/wordpress/pull-db.js";
import { writeSiteArtifacts } from "../../src/site/artifacts.js";

const SQL = "INSERT INTO t VALUES ('row1');\n".repeat(20);

let site: SiteConfig;
let ctx: SiteContext;

async function writeAcmeRegistry(): Promise<void> {
  await ensureDir(BASE_HOME);
  await writeFile(
    REGISTRY_PATH,
    JSON.stringify({
      version: 2,
      activeSite: site.key,
      settings: { httpPort: 80, httpsPort: 443 },
      sites: { [site.key]: site },
    }),
  );
}

/** Seed data that `all`/`pull` would skip on — rebuild must not. */
async function seedExistingData(): Promise<void> {
  await ensureDir(ctx.dirs.wp);
  await writeFile(path.join(ctx.dirs.wp, "wp-config.php"), "<?php\n// wp\n");
  await ensureDir(ctx.dirs.db);
  const { gzipSync } = await import("node:zlib");
  await writeFile(ctx.files.dumpGz, gzipSync(SQL));
}

function freshProgram() {
  const program = buildProgram();
  program.exitOverride();
  return program;
}

function run(args: string[]): Promise<unknown> {
  return freshProgram().parseAsync(args, { from: "user" });
}

beforeEach(async () => {
  state.calls = [];
  state.fullTables = "wp_options\tBASE TABLE\nwp_posts\tBASE TABLE\nwp_legacy\tVIEW";
  state.showTables = "wp_options\nwp_posts";
  vi.clearAllMocks();

  await rm(BASE_HOME, { recursive: true, force: true });

  site = buildSiteConfig({
    siteName: "acme",
    remoteDomain: "https://acme.dev",
    remoteSsh: "deploy@acme.dev",
    downloadProtocol: "ftp",
    remoteFtpHost: "ftp.acme.dev",
    remoteFtpUser: "ftpuser",
  });
  ctx = buildSiteContext(site);
  await writeAcmeRegistry();
});

describe("wp-localify rebuild", () => {
  it("re-pulls files + DB even when both already exist, wipes, then imports", async () => {
    await seedExistingData();

    await expect(run(["rebuild", "--yes"])).resolves.toBeTruthy();

    // The core regression guard: no skip-if-exists logic.
    expect(pullFiles).toHaveBeenCalledTimes(1);
    expect(pullDb).toHaveBeenCalledTimes(1);
    // FTP sites resolve their keychain password for the fresh pull.
    // (The site object is re-normalized on registry load — updatedAt differs —
    // so assert structurally rather than by identity.)
    const [pulledSite, pulledCtx, pullOpts] = vi.mocked(pullFiles).mock.calls[0] ?? [];
    expect(pulledSite).toMatchObject({ key: site.key, downloadProtocol: "ftp" });
    expect(pulledCtx).toMatchObject({ dirs: { wp: ctx.dirs.wp } });
    expect(pullOpts).toEqual({ ftpPassword: "ftp-secret" });
    // Init artifacts regenerated like `all`.
    expect(writeSiteArtifacts).toHaveBeenCalledTimes(1);

    // First stdin pipe: the drop script. Second: the fresh dump.
    expect(state.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.calls[0]?.stdin).toContain("SET FOREIGN_KEY_CHECKS=0;");
    expect(state.calls[0]?.stdin).toContain("DROP TABLE IF EXISTS `wp_options`;");
    expect(state.calls[0]?.stdin).toContain("DROP TABLE IF EXISTS `wp_posts`;");
    expect(state.calls[0]?.stdin).toContain("DROP VIEW IF EXISTS `wp_legacy`;");
    expect(state.calls[0]?.stdin).toContain("SET FOREIGN_KEY_CHECKS=1;");
    expect(state.calls[1]?.stdin).toBe(SQL);
  });

  it("honors --skip-files, --skip-db, and --no-init", async () => {
    await seedExistingData();

    await expect(run(["rebuild", "--yes", "--skip-files", "--skip-db", "--no-init"])).resolves.toBeTruthy();

    expect(pullFiles).not.toHaveBeenCalled();
    expect(pullDb).not.toHaveBeenCalled();
    expect(writeSiteArtifacts).not.toHaveBeenCalled();

    // Still wipes and imports the existing dump.
    expect(state.calls[0]?.stdin).toContain("DROP TABLE IF EXISTS `wp_options`;");
    expect(state.calls[1]?.stdin).toBe(SQL);
  });

  it("refuses to prompt in a non-interactive session without --yes and does nothing", async () => {
    await seedExistingData();

    await expect(run(["rebuild"])).rejects.toThrow(/Refusing to prompt/);

    expect(pullFiles).not.toHaveBeenCalled();
    expect(pullDb).not.toHaveBeenCalled();
    expect(writeSiteArtifacts).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });

  it("rejects an invalid --via mode before touching anything", async () => {
    await expect(run(["rebuild", "--yes", "--via", "carrier-pigeon"])).rejects.toThrow(
      /--via must be 'direct' or 'ssh-tunnel'/,
    );
    expect(pullFiles).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });
});

describe("dropAllTables", () => {
  it("drops tables with DROP TABLE and views with DROP VIEW", async () => {
    await dropAllTables(site, ctx);

    expect(state.calls).toHaveLength(1);
    const script = state.calls[0]?.stdin ?? "";
    expect(script).toContain("SET FOREIGN_KEY_CHECKS=0;");
    expect(script).toContain("DROP TABLE IF EXISTS `wp_options`;");
    expect(script).toContain("DROP TABLE IF EXISTS `wp_posts`;");
    expect(script).toContain("DROP VIEW IF EXISTS `wp_legacy`;");
    expect(script).toContain("SET FOREIGN_KEY_CHECKS=1;");
    // Runs inside the site's own database as its own user.
    expect(state.calls[0]?.args).toContain("mysql");
  });

  it("is a no-op (no mysql child spawned) on an empty database", async () => {
    state.fullTables = "";

    await dropAllTables(site, ctx);

    expect(state.calls).toHaveLength(0);
  });
});

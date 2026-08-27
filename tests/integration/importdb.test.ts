import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---- module mocks -------------------------------------------------- */

const composeState = vi.hoisted(() => {
  return {
    /** Chunks piped into the most recent fake mysql child's stdin. */
    chunks: [] as Buffer[],
    childResult: { failed: false, exitCode: 0, stderr: "" } as {
      failed: boolean;
      exitCode: number;
      stderr: string;
    },
  };
});

vi.mock("../../src/docker/compose.js", async () => {
  const { vi } = await import("vitest");
  const runSiteCompose = vi.fn((_ctx: unknown, _args: string[]) => {
    const callChunks: Buffer[] = [];
    composeState.chunks = callChunks;
    const stdin = new Writable({
      write(chunk: Buffer, _enc, callback) {
        callChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    return Object.assign(Promise.resolve(composeState.childResult), {
      stdin,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      kill: vi.fn(),
      once: vi.fn(),
      pid: 1,
    });
  });

  return {
    runSiteCompose,
    runSiteComposeQuiet: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
  };
});

vi.mock("../../src/site/artifacts.js", () => ({
  upSite: vi.fn(async () => {}),
  isServiceRunning: vi.fn(async () => true),
}));

vi.mock("../../src/secrets/keychain.js", () => ({
  resolveSiteSecrets: vi.fn(async () => ({
    remoteDbPass: "remote-secret",
    remoteFtpPass: "",
    localDbPass: "local-wp-pass",
    localDbRootPass: "local-root-pass",
  })),
  setSecret: vi.fn(async () => {}),
  deleteSiteSecrets: vi.fn(async () => {}),
  renameSiteSecrets: vi.fn(async () => {}),
}));

/* ---- imports under test (after mocks) ------------------------------ */

import { importDb } from "../../src/wordpress/import.js";
import { buildSiteContext } from "../../src/site/context.js";
import { buildSiteConfig } from "../../src/registry/schema.js";
import { ensureDir } from "../../src/fsutils.js";

const settings = { httpPort: 80, httpsPort: 443 };

function makeCtx() {
  const site = buildSiteConfig({ siteName: "acme" });
  return buildSiteContext(site);
}

async function seedDump(dbDir: string, sql: string): Promise<void> {
  const { gzipSync } = await import("node:zlib");
  await ensureDir(dbDir);
  await writeFile(path.join(dbDir, "dump.sql.gz"), gzipSync(sql));
}

async function getLastComposeArgs(): Promise<string[]> {
  const mod = (await import("../../src/docker/compose.js")) as unknown as {
    runSiteCompose: { mock: { calls: Array<[unknown, string[]]> } };
  };
  return mod.runSiteCompose.mock.calls.at(-1)?.[1] ?? [];
}

function capturedStdin(): string {
  return Buffer.concat(composeState.chunks).toString("utf8");
}

beforeEach(() => {
  composeState.chunks = [];
  composeState.childResult = { failed: false, exitCode: 0, stderr: "" };
});

describe("importDb — streamed into docker compose exec mysql", () => {
  it("streams a gzipped dump through gunzip and cleans up on success", async () => {
    const ctx = makeCtx();
    // Padding makes the dump large enough to cross stream chunk boundaries.
    const filler = "-- padding\n".repeat(400);
    const sql = `${filler}INSERT INTO t VALUES ('row1');\nINSERT INTO t VALUES ('row2');\n`;
    await seedDump(ctx.dirs.db, sql);

    await importDb(ctx.site, ctx, settings);

    expect(capturedStdin()).toBe(sql);
    await expect(stat(ctx.files.dumpGz)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(ctx.files.dumpSql)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports legacy uncompressed .sql dumps", async () => {
    const ctx = makeCtx();
    await ensureDir(ctx.dirs.db);
    const sql = "SELECT 1;\n".repeat(2000);
    await writeFile(ctx.files.dumpSql, sql);

    await importDb(ctx.site, ctx, settings);

    expect(capturedStdin()).toBe(sql);
    await expect(stat(ctx.files.dumpSql)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails with an actionable error when no dump exists", async () => {
    const ctx = makeCtx();
    await ensureDir(ctx.dirs.db);
    await expect(importDb(ctx.site, ctx, settings)).rejects.toThrow(/Missing SQL dump/);
  });

  it("keeps the dump for retry when the mysql side exits non-zero", async () => {
    const ctx = makeCtx();
    const sql = "SELECT 1;\n";
    await seedDump(ctx.dirs.db, sql);
    composeState.childResult = { failed: true, exitCode: 1, stderr: "boom" };

    await expect(importDb(ctx.site, ctx, settings)).rejects.toThrow(/Database import failed \(exit 1\)/);

    const onDisk = await readFile(ctx.files.dumpGz);
    const { gunzipSync } = await import("node:zlib");
    expect(gunzipSync(onDisk).toString("utf8")).toBe(sql);
  });

  it("passes the local DB password via MYSQL_PWD exec injection", async () => {
    const ctx = makeCtx();
    await seedDump(ctx.dirs.db, "SELECT 1;");
    await importDb(ctx.site, ctx, settings);

    const args = await getLastComposeArgs();
    expect(args.slice(0, 5)).toEqual(["exec", "-T", "-e", "MYSQL_PWD=local-wp-pass", "db"]);
    expect(args).toContain("mysql");
  });

  it("leaves no stray temp files in the db dir after success", async () => {
    const ctx = makeCtx();
    await seedDump(ctx.dirs.db, "SELECT 1;");
    await importDb(ctx.site, ctx, settings);
    for (const entry of await readdir(ctx.dirs.db)) {
      expect(entry).toMatch(/^dump\.sql(\.gz)?$/);
    }
  });
});

import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---- execa mock ----------------------------------------------------- */

const execaState = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; opts?: Record<string, unknown> }>,
  mysqldumpBehavior: {
    chunks: [] as string[],
    result: { failed: false, exitCode: 0, stderr: "" },
  },
}));

vi.mock("execa", async () => {
  const { vi } = await import("vitest");
  return {
    execa: vi.fn((file: string, args: string[], opts?: Record<string, unknown>) => {
      execaState.calls.push({ file, args, opts });
      if (file === "mysqldump") {
        const behavior = execaState.mysqldumpBehavior;
        return Object.assign(Promise.resolve(behavior.result), {
          stdout: Readable.from(behavior.chunks.map((chunk) => Buffer.from(chunk))),
          stderr: Readable.from([]),
          kill: vi.fn(),
          once: vi.fn(),
          pid: 2,
        });
      }
      throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
    }),
    sync: vi.fn(),
    commandSync: "",
    command: "",
  };
});

vi.mock("../../src/system/deps.js", () => ({
  checkDependencies: vi.fn(async () => {}),
}));

vi.mock("../../src/secrets/keychain.js", () => ({
  resolveSiteSecrets: vi.fn(async () => ({
    remoteDbPass: "s3cr3t-pass",
    remoteFtpPass: "ftp-plain",
    localDbPass: "wp",
    localDbRootPass: "root",
  })),
}));

/* ---- imports under test --------------------------------------------- */

import { pullDb } from "../../src/wordpress/pull-db.js";
import { buildSiteContext } from "../../src/site/context.js";
import { buildSiteConfig } from "../../src/registry/schema.js";
import { ensureDir } from "../../src/fsutils.js";

function makeCtx() {
  const site = buildSiteConfig({ siteName: "acme" });
  return buildSiteContext(site);
}

beforeEach(() => {
  execaState.calls.length = 0;
  execaState.mysqldumpBehavior = {
    chunks: [],
    result: { failed: false, exitCode: 0, stderr: "" },
  };
});

describe("pullDb — remote dump streaming", () => {
  it("sanitizes MySQL8 collations across chunk boundaries while gzipping", async () => {
    const ctx = makeCtx();
    // Split mid-token to exercise the boundary-safe replacer.
    execaState.mysqldumpBehavior.chunks = [
      "CREATE TABLE `wp_posts` (`a` varchar(10)) ENGINE=InnoDB DEFAULT COLLATE=",
      "utf8mb4_0900_ai",
      "_ci;\nINSERT INTO t VALUES ('utf8mb4_general_ci');\n",
    ];

    const outPath = await pullDb(ctx.site, ctx);

    expect(outPath).toBe(ctx.files.dumpGz);
    const gunzipped = (await import("node:zlib"))
      .gunzipSync(await readFile(ctx.files.dumpGz))
      .toString("utf8");

    expect(gunzipped).toContain("utf8mb4_unicode_ci");
    expect(gunzipped).not.toContain("0900");
    expect(gunzipped).toContain("utf8mb4_general_ci"); // unrelated collations kept
    expect(gunzipped).toContain("CREATE TABLE");
  });

  it("authenticates via MYSQL_PWD env only — the secret never appears in argv", async () => {
    const ctx = makeCtx();
    execaState.mysqldumpBehavior.chunks = ["-- nothing"];

    await pullDb(ctx.site, ctx);

    const call = execaState.calls.find((c) => c.file === "mysqldump");
    expect(call).toBeDefined();

    const env = (call?.opts as { env?: Record<string, string> }).env ?? {};
    expect(env.MYSQL_PWD).toBe("s3cr3t-pass");

    const argvJson = JSON.stringify(call?.args);
    expect(argvJson).not.toContain("s3cr3t-pass");
    expect(argvJson).not.toContain("ftp-plain");

    // Standard flags preserved.
    expect(call?.args).toEqual(
      expect.arrayContaining(["--single-transaction", "--quick", "--routines", "--triggers", "wordpress"]),
    );
    expect(call?.args).toEqual(expect.arrayContaining(["-h", "localhost"]));
  });

  it("removes a truncated dump when mysqldump fails", async () => {
    const ctx = makeCtx();
    execaState.mysqldumpBehavior.chunks = ["partial data"];
    execaState.mysqldumpBehavior.result = { failed: true, exitCode: 2, stderr: "denied" };

    await expect(pullDb(ctx.site, ctx)).rejects.toThrow(/mysqldump failed \(exit 2\)/);
    await expect(readFile(ctx.files.dumpGz)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("strips a legacy uncompressed dump after a successful fresh export", async () => {
    const ctx = makeCtx();
    execaState.mysqldumpBehavior.chunks = ["SELECT 1;"];
    await ensureDir(ctx.dirs.db);
    await writeFile(ctx.files.dumpSql, "stale");

    await pullDb(ctx.site, ctx);

    await expect(readFile(ctx.files.dumpSql)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

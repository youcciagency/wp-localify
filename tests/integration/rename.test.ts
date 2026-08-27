import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---- execa mock (block docker contact; record invocations) ---------- */

const execState = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock("execa", async () => {
  const { vi } = await import("vitest");
  const { Readable } = await import("node:stream");
  return {
    execa: vi.fn((file: string, args: string[]) => {
      execState.calls.push({ file, args });
      return Object.assign(Promise.resolve({ failed: false, exitCode: 0, stderr: "" }), {
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        kill: vi.fn(),
        once: vi.fn(),
        pid: 9,
      });
    }),
  };
});

vi.mock("../../src/secrets/keychain.js", () => ({
  setSecret: vi.fn(async () => {}),
  getSecret: vi.fn(async () => null),
  resolveSiteSecrets: vi.fn(async () => ({
    remoteDbPass: "",
    remoteFtpPass: "",
    localDbPass: "wp",
    localDbRootPass: "root",
  })),
  deleteSiteSecrets: vi.fn(async () => {}),
  renameSiteSecrets: vi.fn(async () => {}),
}));

/* ---- imports under test ---------------------------------------------- */

import { persistEditedSite } from "../../src/site/rename.js";
import { loadRegistry } from "../../src/registry/store.js";
import { BASE_HOME, GATEWAY_CONF_DIR, MANAGED_SITES_ROOT } from "../../src/paths.js";
import { ensureDir } from "../../src/fsutils.js";

function baseSite(key: string) {
  return {
    key,
    siteName: key,
    localTld: "test",
    localDomain: `${key}.test`,
    downloadProtocol: "ssh" as const,
    remoteSsh: "u@h",
    remoteFtpHost: "",
    remoteFtpUser: "",
    remoteFtpPass: "",
    remoteWpPath: "/var/www/x",
    remoteDomain: `https://${key}.dev`,
    remoteDbHost: "localhost",
    remoteDbPort: "3306",
    remoteDbName: "db",
    remoteDbUser: "u",
    remoteDbPass: "",
    localDbName: "wordpress",
    localDbUser: "wp",
    localDbPass: "",
    localDbRootPass: "",
    dbEngine: "mariadb" as const,
    dbAccess: "direct" as const,
    parallelThreads: 4,
    localWpPath: path.join(MANAGED_SITES_ROOT, key, "wp"),
    usingManagedWpPath: true,
    dockerProject: `wp_localify_${key}`,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

async function seedManagedLayout(key: string): Promise<void> {
  const root = path.join(MANAGED_SITES_ROOT, key);
  await ensureDir(root);
  for (const sub of ["wp", "db", "certs", "docker"]) {
    await mkdir(path.join(root, sub), { recursive: true });
  }
  await Promise.all([
    writeFile(path.join(root, "wp", "wp-config.php"), "<?php // seeded"),
    writeFile(path.join(root, "db", "dump.sql.gz"), "gz-bytes"),
    writeFile(path.join(root, "certs", "cert.pem"), "cert"),
    writeFile(path.join(root, "docker", "docker-compose.yml"), "services: {}"),
  ]);
  await ensureDir(GATEWAY_CONF_DIR);
  await writeFile(path.join(GATEWAY_CONF_DIR, `${key}.conf`), "server{}");
}

beforeEach(async () => {
  await rm(BASE_HOME, { recursive: true, force: true });
  await ensureDir(BASE_HOME);
  execState.calls.length = 0;
});

describe("persistEditedSite — key rename relocates the managed layout", () => {
  it("moves wp/db/certs/docker, rewrites paths, stops the old stack, cleans up", async () => {
    await seedManagedLayout("alpha");
    const registry = await loadRegistry();
    registry.sites.alpha = baseSite("alpha") as never;
    registry.activeSite = "alpha";

    const incoming = baseSite("beta"); // built with beta's managed default path? No—see fix below
    // The wizard carries over the OLD path when renaming; reproduce that shape.
    incoming.localWpPath = path.join(MANAGED_SITES_ROOT, "alpha", "wp");

    const outcome = await persistEditedSite(registry, registry.sites.alpha as never, incoming);

    expect(outcome.site.key).toBe("beta");
    expect(outcome.site.localWpPath).toBe(path.join(MANAGED_SITES_ROOT, "beta", "wp"));
    expect(outcome.site.usingManagedWpPath).toBe(true);
    expect(outcome.notes.some((n) => n.includes("'alpha' → 'beta'"))).toBe(true);

    // Files physically relocated.
    await expect(stat(path.join(MANAGED_SITES_ROOT, "beta", "wp", "wp-config.php"))).resolves.toBeTruthy();
    await expect(stat(path.join(MANAGED_SITES_ROOT, "beta", "db", "dump.sql.gz"))).resolves.toBeTruthy();
    await expect(stat(path.join(MANAGED_SITES_ROOT, "beta", "certs", "cert.pem"))).resolves.toBeTruthy();
    await expect(
      stat(path.join(MANAGED_SITES_ROOT, "beta", "docker", "docker-compose.yml")),
    ).resolves.toBeTruthy();

    // Old layout is gone: no alpha root, no alpha nginx conf.
    const sitesRootEntries = await readdir(MANAGED_SITES_ROOT).catch(() => []);
    expect(sitesRootEntries).toEqual(["beta"]);
    await expect(stat(path.join(GATEWAY_CONF_DIR, "alpha.conf"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Docker teardown attempted for the OLD project name only.
    const down = execState.calls.find((c) => c.args.includes("-f"));
    expect(down?.args).toContain("--remove-orphans");
    expect(execState.calls.some((c) => c.args.includes("wp_localify_alpha_db_data"))).toBe(true);

    // Registry re-pointed atomically.
    const persisted = JSON.parse(await readFile(`${BASE_HOME}/sites.json`, "utf8"));
    expect(Object.keys(persisted.sites)).toEqual(["beta"]);
    expect(persisted.activeSite).toBe("beta");
  });

  it("keeps custom WordPress paths untouched when the key changes", async () => {
    const registry = await loadRegistry();
    const oldSite = baseSite("src-site");
    oldSite.usingManagedWpPath = false;
    const customPath = `/tmp/wp-localify-rename-test-${Date.now()}/custom-wp`;
    await mkdir(customPath, { recursive: true });
    await writeFile(path.join(customPath, "wp-config.php"), "<?php custom");
    oldSite.localWpPath = customPath;

    registry.sites[oldSite.key] = oldSite as never;
    registry.activeSite = oldSite.key;

    const incoming = { ...baseSite("dst-key"), localWpPath: customPath, usingManagedWpPath: false };

    const outcome = await persistEditedSite(registry, oldSite as never, incoming as never);

    expect(outcome.site.localWpPath).toBe(customPath);
    expect(outcome.notes.some((n) => n.includes("Custom WordPress path kept in place"))).toBe(true);

    // Custom files untouched; no stray wp dir inside dst storage.
    await expect(stat(path.join(customPath, "wp-config.php"))).resolves.toBeTruthy();
    await expect(stat(path.join(MANAGED_SITES_ROOT, "dst-key", "wp"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(path.dirname(customPath), { recursive: true, force: true });
  });

  it("no-ops (plain save) when the key did not change", async () => {
    await seedManagedLayout("same");
    const registry = await loadRegistry();
    const site = baseSite("same") as never;
    registry.sites.same = site;
    registry.activeSite = "same";

    const outcome = await persistEditedSite(registry, registry.sites.same as never, site);
    expect(outcome.notes).toEqual([]);
    expect(execState.calls).toHaveLength(0); // nothing to stop or move

    const entries = await readdir(path.join(MANAGED_SITES_ROOT, "same"));
    expect(entries.sort()).toEqual(["certs", "db", "docker", "wp"]);
  });
});

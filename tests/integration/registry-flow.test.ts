import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---- keychain mock --------------------------------------------------- */

const keychainState = vi.hoisted(() => ({
  setCalls: [] as Array<{ siteKey: string; field: string; value: string }>,
}));

vi.mock("../../src/secrets/keychain.js", async () => {
  const { vi } = await import("vitest");
  return {
    setSecret: vi.fn(async (siteKey: string, field: string, value: string) => {
      keychainState.setCalls.push({ siteKey, field, value });
    }),
    getSecret: vi.fn(async (siteKey: string, field: string) => {
      const hit = [...keychainState.setCalls]
        .reverse()
        .find((c) => c.siteKey === siteKey && c.field === field);
      return hit ? hit.value : null;
    }),
    deleteSiteSecrets: vi.fn(async () => {}),
    renameSiteSecrets: vi.fn(async () => {}),
  };
});

/* ---- imports under test ---------------------------------------------- */

import { loadRegistry, saveRegistry } from "../../src/registry/store.js";
import { BASE_HOME, REGISTRY_PATH, LEGACY_CONFIG_PATH } from "../../src/paths.js";
import { ensureDir } from "../../src/fsutils.js";

async function resetHome(): Promise<void> {
  await rm(BASE_HOME, { recursive: true, force: true });
  await ensureDir(BASE_HOME);
  keychainState.setCalls.length = 0;
}

beforeEach(resetHome);

describe("registry flow — load → migrate → save round-trip", () => {
  it("upgrades a v1 registry and moves plaintext secrets into the keychain backend", async () => {
    const v1 = {
      version: 1,
      activeSite: "ghost",
      sites: {
        alpha: {
          key: "alpha",
          siteName: "alpha",
          localTld: "test",
          localDomain: "alpha.test",
          downloadProtocol: "ftp",
          remoteFtpHost: "ftp.real.com",
          remoteFtpUser: "u1",
          remoteFtpPass: "FTP-SECRET",
          remoteWpPath: "/var/www/alpha",
          remoteDomain: "https://alpha.com",
          remoteDbHost: "localhost",
          remoteDbPort: "3306",
          remoteDbName: "db_a",
          remoteDbUser: "user_a",
          remoteDbPass: "DB-SECRET",
          localDbPass: "LOCAL-SECRET",
          parallelThreads: 4,
          createdAt: "2025-01-01T00:00:00.000Z",
        },
        beta: { key: "beta", siteName: "beta" },
      },
    };
    await writeFile(REGISTRY_PATH, JSON.stringify(v1));

    const registry = await loadRegistry();

    expect(registry.version).toBe(2);
    expect(Object.keys(registry.sites).sort()).toEqual(["alpha", "beta"]);

    // Unknown activeSite falls back to the first known site.
    expect(registry.activeSite).toBe("alpha");

    // All four secret fields went to the backend in SECRET_FIELDS order;
    // nothing stays in JSON.
    expect(keychainState.setCalls.map((c) => `${c.siteKey}.${c.field}`)).toEqual([
      "alpha.remoteDbPass",
      "alpha.remoteFtpPass",
      "alpha.localDbPass",
    ]);

    const persisted = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
    for (const field of ["remoteDbPass", "remoteFtpPass", "localDbPass"]) {
      expect(persisted.sites.alpha[field]).toBe("");
    }
    expect(JSON.stringify(persisted)).not.toContain("SECRET");
  });

  it("is idempotent — second load performs no further keychain writes", async () => {
    await writeFile(
      REGISTRY_PATH,
      JSON.stringify({
        version: 1,
        sites: {
          k: {
            key: "k",
            siteName: "k",
            downloadProtocol: "ssh",
            remoteSsh: "a@b.c",
            remoteWpPath: "/x",
            remoteDomain: "https://k.dev",
            remoteDbPass: "ONCE-ONLY",
          },
        },
      }),
    );

    await loadRegistry();
    const afterFirstLoad = keychainState.setCalls.length;
    expect(afterFirstLoad).toBeGreaterThan(0);

    await loadRegistry();
    expect(keychainState.setCalls.length).toBe(afterFirstLoad);
  });

  it("migrates the legacy single-site .wp-localize.json when registry is empty", async () => {
    await writeFile(
      LEGACY_CONFIG_PATH,
      JSON.stringify({
        siteName: "oldblog",
        localTld: "test",
        downloadProtocol: "ssh",
        remoteSsh: "dep@legacy.io",
        remoteWpPath: "/srv/wp",
        remoteDomain: "https://oldblog.dev/",
        remoteDbHost: "127.0.0.1",
        remoteDbPort: "3306",
        remoteDbName: "wpdb",
        remoteDbUser: "wpuser",
        remoteDbPass: "LEGACY-DB-SECRET",
      }),
    );

    const registry = await loadRegistry();

    expect(Object.keys(registry.sites)).toContain("oldblog");
    expect(registry.activeSite).toBe("oldblog");

    // Remote URL was normalized (no trailing slash) during migration.
    expect(registry.sites.oldblog?.remoteDomain).toBe("https://oldblog.dev");

    const secretCalls = keychainState.setCalls.filter((c) => c.siteKey === "oldblog");
    expect(secretCalls.some((c) => c.value === "LEGACY-DB-SECRET")).toBe(true);

    // And it was persisted as v2.
    const persisted = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
    expect(persisted.version).toBe(2);
    expect(JSON.stringify(persisted)).not.toContain("LEGACY-DB-SECRET");
  });

  it("recovers gracefully from a corrupt sites.json with a timestamped backup", async () => {
    await writeFile(REGISTRY_PATH, "{ this is not json ][");

    const registry = await loadRegistry();
    expect(registry.sites).toEqual({});
    expect(registry.activeSite).toBeNull();

    const files = await readdir(BASE_HOME);
    const backups = files.filter((f) => f.startsWith("sites.json.corrupt-"));
    expect(backups).toHaveLength(1);

    const backupContent = await readFile(path.join(BASE_HOME, backups[0] ?? ""), "utf8");
    expect(backupContent).toContain("this is not json");
  });

  it("saveRegistry writes atomically-formatted v2 output including settings defaults", async () => {
    const registry = await loadRegistry();
    await saveRegistry(registry);

    const raw = await readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.settings).toEqual({ httpPort: 80, httpsPort: 443 });
    expect(raw.endsWith("\n")).toBe(true);
  });
});

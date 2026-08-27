import { describe, expect, it, vi } from "vitest";
import { isSiteConfigComplete, buildSiteConfig, migrateRawRegistry } from "../src/registry/schema.js";

const storedSecrets: Record<string, string> = {};

vi.mock("../src/secrets/keychain.js", () => ({
  setSecret: vi.fn(async (_siteKey: string, field: string, value: string) => {
    storedSecrets[`${_siteKey}.${field}`] = value;
  }),
  getSecret: vi.fn(async () => null),
  resolveSiteSecrets: vi.fn(async () => ({
    remoteDbPass: "",
    remoteFtpPass: "",
    localDbPass: "wp",
    localDbRootPass: "root",
  })),
}));

describe("buildSiteConfig", () => {
  it("derives canonical fields", () => {
    const site = buildSiteConfig({ siteName: "My Blog", localTld: "test" });
    expect(site.key).toBe("my-blog");
    expect(site.localDomain).toBe("My Blog.test");
    expect(site.dockerProject).toBe("wp_localify_my_blog");
    expect(site.dbEngine).toBe("mariadb");
    expect(site.dbAccess).toBe("direct");
    expect(site.parallelThreads).toBe(4);
  });

  it("clamps parallel threads and normalizes protocol/engine", () => {
    const site = buildSiteConfig({
      siteName: "x",
      parallelThreads: 99,
      downloadProtocol: "carrier-pigeon",
      dbEngine: "oracle",
      dbAccess: "telepathy",
    });
    expect(site.parallelThreads).toBe(4);
    expect(site.downloadProtocol).toBe("ssh");
    expect(site.dbEngine).toBe("mariadb");
    expect(site.dbAccess).toBe("direct");
  });

  it("strips secret fields to empty strings", () => {
    const site = buildSiteConfig({ siteName: "x", remoteDbPass: "leak" } as Record<string, unknown>);
    expect(site.remoteDbPass).toBe("");
  });
});

describe("isSiteConfigComplete", () => {
  const base = {
    key: "s",
    siteName: "s",
    localTld: "test",
    localDomain: "s.test",
    downloadProtocol: "ssh",
    remoteSsh: "u@h",
    remoteWpPath: "/var/www",
    remoteDomain: "https://h.com",
    remoteDbHost: "localhost",
    remoteDbPort: "3306",
    remoteDbName: "wp",
    remoteDbUser: "u",
    localWpPath: "/tmp/wp",
  };

  it("accepts a complete config without any passwords", () => {
    expect(isSiteConfigComplete(base)).toBe(true);
  });

  it("rejects placeholder SSH targets", () => {
    expect(isSiteConfigComplete({ ...base, remoteSsh: "user@example.com" })).toBe(false);
  });

  it("rejects placeholder FTP host/user", () => {
    const ftp = { ...base, downloadProtocol: "ftp", remoteFtpHost: "", remoteFtpUser: "" };
    expect(isSiteConfigComplete(ftp)).toBe(false);
    expect(isSiteConfigComplete({ ...ftp, remoteFtpHost: "ftp.example.com", remoteFtpUser: "real" })).toBe(
      false,
    );
    expect(isSiteConfigComplete({ ...ftp, remoteFtpHost: "ftp.real.com", remoteFtpUser: "real" })).toBe(true);
  });
});

describe("migrateRawRegistry", () => {
  it("upgrades v1 registries, moving secrets to the keychain backend", async () => {
    const raw = {
      version: 1,
      activeSite: "old",
      sites: {
        old: {
          key: "old",
          siteName: "old",
          localTld: "test",
          localDomain: "old.test",
          downloadProtocol: "ssh",
          remoteSsh: "deploy@h",
          remoteWpPath: "/srv",
          remoteDomain: "https://old.com",
          remoteDbHost: "localhost",
          remoteDbPort: "3306",
          remoteDbName: "db",
          remoteDbUser: "u",
          remoteDbPass: "PLAINTEXT",
          localDbPass: "localpass",
        },
      },
    };

    const result = await migrateRawRegistry(raw);
    expect(result.changed).toBe(true);
    expect(storedSecrets["old.remoteDbPass"]).toBe("PLAINTEXT");
    expect(storedSecrets["old.localDbPass"]).toBe("localpass");
    expect(result.registry.version).toBe(2);
    expect(result.registry.sites.old?.remoteDbPass).toBe("");
    expect(result.registry.sites.old?.dbEngine).toBe("mariadb");
    expect(result.registry.activeSite).toBe("old");
    expect(result.notes.join(" ")).toContain("OS keychain");
  });

  it("falls back to the first site when activeSite is missing", async () => {
    const result = await migrateRawRegistry({
      version: 1,
      sites: { b: { key: "b", siteName: "b" }, a: { key: "a", siteName: "a" } },
    });
    expect(result.changed).toBe(false);
    expect(["b", "a"]).toContain(result.registry.activeSite);
  });

  it("handles empty/garbage input", async () => {
    for (const raw of [null, undefined, {}, { sites: "nope" }, { sites: { x: "nope" } }]) {
      const result = await migrateRawRegistry(raw);
      expect(result.registry.sites).toEqual({});
      expect(result.registry.activeSite).toBeNull();
    }
  });
});

import { rm, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep every command's network/docker surface inert.
vi.mock("execa", async () => {
  const { vi } = await import("vitest");
  return {
    execa: vi.fn((file: string) => {
      throw new Error(`execa blocked in wiring test: ${file}`);
    }),
    execaCommand: vi.fn(() => {
      throw new Error("execaCommand blocked");
    }),
  };
});

import { buildProgram } from "../../src/cli.js";
import { REGISTRY_PATH, BASE_HOME } from "../../src/paths.js";
import { ensureDir } from "../../src/fsutils.js";

async function writeRegistry(sites: Record<string, unknown>, activeSite: string | null): Promise<void> {
  await ensureDir(BASE_HOME);
  await writeFile(
    REGISTRY_PATH,
    JSON.stringify({
      version: 2,
      activeSite,
      settings: { httpPort: 80, httpsPort: 443 },
      sites,
    }),
  );
}

function freshProgram() {
  const program = buildProgram();
  // Surface commander failures as thrown errors instead of process.exit().
  program.exitOverride();
  return program;
}

function run(program: ReturnType<typeof freshProgram>, args: string[]): Promise<unknown> {
  return program.parseAsync(args, { from: "user" });
}

beforeEach(async () => {
  await rm(BASE_HOME, { recursive: true, force: true });
});

describe("CLI wiring — commander registration and offline flows", () => {
  it("prints the package version (commander exits with the value under exitOverride)", async () => {
    const { default: pkg } = await import("../../package.json", { with: { type: "json" } });
    await expect(run(freshProgram(), ["--version"])).rejects.toMatchObject({
      message: pkg.version,
    });
  });

  it("`site list` handles an empty registry without touching docker", async () => {
    await writeRegistry({}, null);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run(freshProgram(), ["site", "list"])).resolves.toBeTruthy();
    } finally {
      error.mockRestore();
    }
  });

  it("`site status --json` emits machine-readable output fully offline", async () => {
    await writeRegistry(
      [
        {
          key: "k",
          siteName: "k",
          localTld: "test",
          localDomain: "k.test",
          downloadProtocol: "ssh",
          remoteSsh: "u@h",
          remoteFtpHost: "",
          remoteFtpUser: "",
          remoteWpPath: "/var/www/k",
          remoteDomain: "https://k.dev",
          remoteDbHost: "localhost",
          remoteDbPort: "3306",
          remoteDbName: "db",
          remoteDbUser: "u",
          localWpPath: "/tmp/wp",
          usingManagedWpPath: false,
          dockerProject: "wp_localify_k",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ].reduce<Record<string, unknown>>((acc, site) => {
        acc[(site as { key: string }).key] = site;
        return acc;
      }, {}),
      "k",
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(freshProgram(), ["site", "status", "--json"]);
      expect(log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
      expect(payload.activeSite).toBe("k");
      expect(payload.gatewayRunning).toBe(false);
      expect(payload.sites).toHaveLength(1);
      expect(payload.sites[0]).toMatchObject({ key: "k", running: false, protocol: "ssh" });
    } finally {
      log.mockRestore();
    }
  });

  it("rejects unknown commands with commander's help hint", async () => {
    await writeRegistry({}, null);
    const errOut = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run(freshProgram(), ["frobnicate"])).rejects.toThrow(/unknown command/i);
    } finally {
      errOut.mockRestore();
    }
  });

  it("`wp` with no arguments fails with guidance instead of contacting docker", async () => {
    await writeRegistry({}, null);
    await expect(run(freshProgram(), ["wp"])).rejects.toThrow(/No WP-CLI arguments given/);
  });

  it("site-scoped actions refuse unknown keys with a next-step hint", async () => {
    await writeRegistry({}, null);
    await expect(run(freshProgram(), ["site", "stop", "--site", "nope"])).rejects.toThrow(
      /Unknown site 'nope'/,
    );
  });

  it("pull refuses to run when nothing is configured (non-interactive fail-fast)", async () => {
    await writeRegistry({}, null);
    await expect(run(freshProgram(), ["pull"])).rejects.toThrow(/No sites configured/);
  });
});

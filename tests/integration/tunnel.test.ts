import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---- execa ("ssh") mock --------------------------------------------- */

interface FakeSshChild {
  args: string[];
  /** Invoke registered "error" listeners (simulates early ssh death). */
  emitError(err: Error): void;
  killCalls(): string[];
}

const GLOBAL_KEY = "__wp_localify_ssh_fakes__" as const;

declare global {
  // eslint-disable-next-line no-var
  var __wp_localify_ssh_fakes__: FakeSshChild[] | undefined;
}

vi.mock("execa", async () => {
  const { vi } = await import("vitest");
  const { Readable } = await import("node:stream");

  type EeListener = (payload?: unknown) => void;

  return {
    execa: vi.fn((file: string, args: string[]) => {
      if (file !== "ssh") {
        throw new Error(`unexpected exec in tunnel test: ${file} ${args.join(" ")}`);
      }

      const listeners = new Map<string, Set<EeListener>>();
      const killLog: string[] = [];

      const fake: FakeSshChild = {
        args,
        emitError(err: Error): void {
          for (const fn of listeners.get("error") ?? []) fn(err);
        },
        killCalls: (): string[] => [...killLog],
      };
      const registryKey = GLOBAL_KEY as unknown as string;
      const registry = ((globalThis as Record<string, unknown>)[registryKey] as FakeSshChild[]) ?? [];
      registry.push(fake);
      (globalThis as Record<string, unknown>)[registryKey] = registry;

      return Object.assign(
        new Promise<{ failed: boolean; exitCode: number; stderr: string }>(() => {
          /* stays pending until killed in real life; tests drive errors explicitly */
        }),
        {
          stdout: Readable.from([]),
          stderr: Readable.from([Buffer.from("")]),
          kill: (signal: NodeJS.Signals = "SIGTERM") => {
            killLog.push(signal);
            return true;
          },
          once(event: string, listener: EeListener): void {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)?.add(listener);
          },
          pid: 3,
        },
      );
    }),
  };
});

/* ---- test subject ---------------------------------------------------- */

import { openDbTunnel } from "../../src/wordpress/pull-db.js";
import { buildSiteConfig } from "../../src/registry/schema.js";

const site = buildSiteConfig({
  siteName: "tunnelsite",
  remoteSsh: "deploy@host.example",
  remoteDbHost: "localhost",
  remoteDbPort: "3307",
  dbAccess: "ssh-tunnel",
});

const openServers: Server[] = [];

beforeEach(() => {
  const key = GLOBAL_KEY as unknown as string;
  (globalThis as Record<string, unknown>)[key] = [];
});

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function awaitFake(): Promise<FakeSshChild> {
  const key = GLOBAL_KEY as unknown as string;
  await vi.waitFor(() => {
    expect(((globalThis as Record<string, unknown>)[key] as FakeSshChild[])?.length).toBe(1);
  });
  const fake = ((globalThis as Record<string, unknown>)[key] as FakeSshChild[])[0];
  if (!fake) throw new Error("mocked ssh child never registered");
  return fake;
}

describe("openDbTunnel — SSH tunnel lifecycle", () => {
  it("forwards 127.0.0.1:<ephemeral> -> remote target and reports readiness", async () => {
    const handlePromise = openDbTunnel(site);

    const fake = await awaitFake();

    const flagIndex = fake.args.indexOf("-L");
    expect(flagIndex).toBeGreaterThan(-1);
    const rule = fake.args[flagIndex + 1] ?? "";
    const match = /^127\.0\.0\.1:(\d+):localhost:3307$/.exec(rule);
    expect(match).not.toBeNull();
    const localPort = Number(match?.[1]);
    expect(localPort).toBeGreaterThan(1024);

    // Standard hardening flags present.
    expect(fake.args).toEqual(
      expect.arrayContaining([
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "deploy@host.example",
      ]),
    );

    // Satisfy the readiness probe with a real listener on the reserved port.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(localPort, "127.0.0.1", resolve));
    openServers.push(server);

    const handle = await handlePromise;
    expect(handle.localPort).toBe(localPort);

    await handle.close();

    await vi.waitFor(() => {
      expect(fake.killCalls().length).toBeGreaterThanOrEqual(1);
    });
  }, 30000);

  it("fails fast when ssh dies before the forward becomes reachable", async () => {
    const failurePromise = openDbTunnel(site);
    const fake = await awaitFake();

    fake.emitError(new Error("Permission denied (publickey)."));

    await expect(failurePromise).rejects.toThrow(/Permission denied/);
  }, 20000);

  it("carries no credentials inside argv", async () => {
    void openDbTunnel(site).catch(() => {});
    const fake = await awaitFake();
    const json = JSON.stringify(fake.args);
    expect(json).not.toMatch(/password/i);
    expect(json).not.toContain(":@");
  }, 20000);
});

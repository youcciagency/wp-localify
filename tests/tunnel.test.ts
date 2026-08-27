import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findFreePortName } from "./helpers/ports.js";

describe("port allocation", () => {
  it("allocates ports that are actually bindable after release", async () => {
    const port = await findFreePortName();
    expect(port).toBeGreaterThan(0);

    const canBind = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    expect(canBind).toBe(true);
  });

  it("allocates distinct ports on consecutive calls", async () => {
    const first = await findFreePortName();
    const second = await findFreePortName();
    expect(first).not.toBe(second);
  });
});

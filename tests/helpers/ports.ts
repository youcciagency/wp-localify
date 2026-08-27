import { createServer } from "node:net";

/**
 * Test-only mirror of the ephemeral-port allocation used by the SSH tunnel.
 * The real implementation lives inline in pull-db.ts; keeping the logic
 * identical here pins its contract (listen on 0, close before use).
 */
export function findFreePortName(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("no port"));
      });
    });
    listener.on("error", reject);
  });
}

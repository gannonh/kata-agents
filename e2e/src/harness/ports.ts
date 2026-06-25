import { createServer } from "node:net";

/**
 * Allocate a free TCP port by binding to port 0 on the loopback interface and
 * reading the OS-assigned port. Kata Agents uses a single Vite port per run
 * (no server/web offset pair), so this is intentionally minimal.
 *
 * Note: there is an inherent race between releasing the probe socket and the
 * caller binding the port. V1 runs `workers: 1`, so concurrent allocation is
 * not a concern; a follow-up issue tracks subprocess server-port isolation for
 * `workers > 1`.
 */
export async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port (no address from net server)."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

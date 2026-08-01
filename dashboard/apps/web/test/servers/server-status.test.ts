/**
 * The reachability probe is what the Servers table calls a server up or down on,
 * so both answers are pinned against a real socket: one that is listening, and a
 * port nothing is on. A probe that reported "up" for a refused connection would
 * leave an operator debugging Polaris instead of their machine.
 */

import { createServer, type Server } from "node:net";
import { probeTcp } from "../../src/lib/server-status";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let port = 0;

beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("probeTcp", () => {
    it("reports no complaint and a measurement when something answers", async () => {
        const result = await probeTcp("127.0.0.1", port);
        expect(result.detail).toBeNull();
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("says what went wrong when nothing is listening", async () => {
        // Port 1 on loopback: privileged, and nothing binds it.
        const result = await probeTcp("127.0.0.1", 1);
        expect(result.detail).not.toBeNull();
    });
});

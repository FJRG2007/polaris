/**
 * A UNAS console that accepts the connection and then says nothing must not hold
 * the Drive overview open: the sign-in gives up within its own bound.
 */

import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOGIN_TIMEOUT_MS, signIn } from "../../src/lib/unifi-unas";

let server: Server;
let port = 0;
const sockets: Socket[] = [];

beforeAll(async () => {
    // Accepts and never answers: what a half-present device looks like.
    server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("UNAS sign-in", () => {
    it("gives up on a console that never answers", async () => {
        const started = Date.now();
        await expect(
            signIn({
                host: "127.0.0.1",
                port,
                username: "fixture",
                password: "fixture",
                secure: false
            })
        ).rejects.toThrow();
        const took = Date.now() - started;
        expect(took).toBeGreaterThanOrEqual(LOGIN_TIMEOUT_MS - 200);
        expect(took).toBeLessThan(LOGIN_TIMEOUT_MS + 3000);
    }, 15_000);
});

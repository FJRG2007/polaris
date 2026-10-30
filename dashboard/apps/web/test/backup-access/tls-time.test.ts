/**
 * The relay's way home is judged by a handshake, because the server's edge takes
 * a TCP connection whether or not the tunnel behind it is up.
 */

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { tlsTime } from "@/lib/backup-access/tls-time";

let server: Server | null = null;
const silent = (): Promise<number> =>
    new Promise((resolve) => {
        server = createServer(() => undefined);
        server.listen(0, "127.0.0.1", () => {
            const address = server!.address();
            resolve(typeof address === "object" && address ? address.port : 0);
        });
    });

afterEach(() => {
    server?.close();
    server = null;
});

describe("tlsTime", () => {
    it("gets no time from a port that accepts and never shakes hands", async () => {
        const port = await silent();
        expect(await tlsTime("127.0.0.1", port, "example.test", 300)).toBeNull();
    });
});

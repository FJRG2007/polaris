/**
 * A stop during an update must not cost a request: the guard keeps answering while the
 * edge moves to its replacement, tells the edge to let go of its connections, and
 * finishes what is in flight before it exits.
 */

import { request } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { drainServers } from "../src/shutdown.js";
import { createServer, type Server } from "node:http";

/** A server that answers after `delayMs`, or never when `delayMs` is null. */
async function serve(delayMs: number | null): Promise<{ server: Server; url: string }> {
    const server = createServer((_req, res) => {
        if (delayMs === null) return;
        setTimeout(() => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        }, delayMs);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** One request on a fresh connection; resolves with its status and connection header,
 *  or with the error code when it could not be made. */
function get(url: string): Promise<{ status?: number; connection?: string; error?: string }> {
    return new Promise((resolve) => {
        const req = request(url, { agent: false }, (res) => {
            res.resume();
            res.on("end", () =>
                resolve({ status: res.statusCode, connection: res.headers.connection })
            );
        });
        req.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code }));
        req.end();
    });
}

describe("draining the guard", () => {
    it("keeps answering while it lingers, and asks the caller to let go", async () => {
        const { server, url } = await serve(0);
        const drained = drainServers([server], { lingerMs: 300, deadlineMs: 2_000 });
        const answer = await get(url);
        expect(answer.status).toBe(200);
        expect(answer.connection).toBe("close");
        await drained;
    });

    it("finishes a request in flight when the listener closes, then refuses new ones", async () => {
        const { server, url } = await serve(400);
        const inFlight = get(url);
        await new Promise((r) => setTimeout(r, 50));
        const drained = drainServers([server], { lingerMs: 100, deadlineMs: 3_000 });
        await new Promise((r) => setTimeout(r, 200));
        const late = await get(url);
        expect(late.error).toBe("ECONNREFUSED");
        expect((await inFlight).status).toBe(200);
        await drained;
    });

    it("does not wait past the deadline for a request that never ends", async () => {
        const { server, url } = await serve(null);
        const hung = get(url);
        await new Promise((r) => setTimeout(r, 50));
        const started = Date.now();
        await drainServers([server], { lingerMs: 50, deadlineMs: 400 });
        expect(Date.now() - started).toBeLessThan(1_500);
        expect((await hung).error).toBeDefined();
    });
});

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendWebhook, type WebhookPayload } from "@/lib/notifications/webhook-sender";

const PAYLOAD: WebhookPayload = {
    event: "deploy.failed",
    level: "danger",
    title: "Deploy failed",
    body: null,
    url: null,
    at: "2026-07-31T12:00:00.000Z"
};

/** A service on loopback that would answer, standing in for anything on the
 *  LAN: before delivery went through safe-fetch, any account could post to it. */
let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
    server = createServer((_req, res) => {
        hits += 1;
        res.writeHead(204);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
});

afterAll(() => {
    server.close();
});

describe("a webhook pointed inside the network", () => {
    it("never reaches a service on this machine", async () => {
        for (const host of ["127.0.0.1", "localhost"]) {
            expect(await sendWebhook(`http://${host}:${port}/hook`, "generic", PAYLOAD)).toEqual({
                error: "The endpoint could not be reached."
            });
        }
        expect(hits).toBe(0);
    });

    it.each([
        "https://10.0.0.5/hook",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/hook"
    ])("refuses %s without telling its status", async (address) => {
        expect(await sendWebhook(address, "generic", PAYLOAD)).toEqual({
            error: "The endpoint could not be reached."
        });
    });

    it("refuses an address carrying credentials", async () => {
        expect(await sendWebhook("https://user:pass@example.com/hook", "generic", PAYLOAD)).toEqual(
            {
                error: "The endpoint could not be reached."
            }
        );
    });
});

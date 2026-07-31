import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendWebhook, type WebhookPayload } from "@/lib/notifications/webhook-sender";

/** What each request arrived as, so the body shape can be asserted for real
 *  rather than by re-deriving it from the sender. */
interface Received {
    path: string;
    contentType: string | undefined;
    body: Record<string, unknown>;
}

let server: Server;
let base: string;
const received: Received[] = [];

const PAYLOAD: WebhookPayload = {
    event: "deploy.failed",
    level: "danger",
    title: "Deploy failed: polaris / api",
    body: "npm ERR! build exited 1",
    url: "https://polaris.example.com/apps/deploy/p1",
    at: "2026-07-31T12:00:00.000Z"
};

beforeAll(async () => {
    server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
        });
        req.on("end", () => {
            received.push({
                path: req.url ?? "",
                contentType: req.headers["content-type"],
                body: JSON.parse(raw) as Record<string, unknown>
            });
            if (req.url === "/gone") {
                res.writeHead(404);
                res.end();
                return;
            }
            if (req.url === "/refused") {
                res.writeHead(403);
                res.end();
                return;
            }
            res.writeHead(204);
            res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
    server.close();
});

function bodyAt(path: string): Record<string, unknown> {
    const hit = received.find((entry) => entry.path === path);
    if (!hit) throw new Error(`no request recorded for ${path}`);
    return hit.body;
}

describe("delivering to a webhook", () => {
    it("posts a Discord embed carrying the title, body, link and severity colour", async () => {
        expect(await sendWebhook(`${base}/discord`, "discord", PAYLOAD)).toEqual({});
        const embed = (bodyAt("/discord").embeds as Array<Record<string, unknown>>)[0];
        expect(embed.title).toBe(PAYLOAD.title);
        expect(embed.description).toBe(PAYLOAD.body);
        expect(embed.url).toBe(PAYLOAD.url);
        expect(embed.color).toBe(0xdc2626);
        expect(embed.timestamp).toBe(PAYLOAD.at);
    });

    it("posts Slack blocks with a fallback text so a notification preview still reads", async () => {
        expect(await sendWebhook(`${base}/slack`, "slack", PAYLOAD)).toEqual({});
        const body = bodyAt("/slack");
        expect(body.text).toBe(PAYLOAD.title);
        const attachment = (body.attachments as Array<Record<string, unknown>>)[0];
        expect(attachment.color).toBe("#dc2626");
        const blocks = attachment.blocks as Array<Record<string, unknown>>;
        expect(JSON.stringify(blocks)).toContain(PAYLOAD.body);
        expect(JSON.stringify(blocks)).toContain(PAYLOAD.url);
    });

    it("posts the event unchanged to an endpoint of your own", async () => {
        expect(await sendWebhook(`${base}/generic`, "generic", PAYLOAD)).toEqual({});
        expect(bodyAt("/generic")).toEqual({ ...PAYLOAD });
    });

    it("sends JSON", async () => {
        expect(received.every((entry) => entry.contentType === "application/json")).toBe(true);
    });
});

describe("when the endpoint does not take it", () => {
    it("explains a deleted webhook rather than throwing", async () => {
        const result = await sendWebhook(`${base}/gone`, "generic", PAYLOAD);
        expect(result.error).toContain("404");
    });

    it("explains a refusal", async () => {
        const result = await sendWebhook(`${base}/refused`, "generic", PAYLOAD);
        expect(result.error).toContain("unauthorized");
    });

    it("explains an unreachable host rather than throwing", async () => {
        const result = await sendWebhook("http://127.0.0.1:1/nowhere", "generic", PAYLOAD);
        expect(result.error).toBe("The endpoint could not be reached.");
    });
});

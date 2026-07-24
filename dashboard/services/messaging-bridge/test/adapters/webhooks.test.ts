import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordWebhookAdapter } from "../../src/adapters/discord-webhook.js";
import { SlackWebhookAdapter } from "../../src/adapters/slack-webhook.js";
import type { AdapterContext } from "@polaris/messaging";

/**
 * The send-only incoming-webhook adapters (one-way alerts from Watch, no bot).
 * connect() validates the URL shape; send() posts the alert to the webhook. We
 * capture the outbound fetch so the assertions check the exact request that would
 * hit Discord/Slack.
 */

const ctx: AdapterContext = { channelId: "c", onInbound: vi.fn(), log: vi.fn() };

function mockFetch(responseBody: unknown = {}, ok = true, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const spy = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
            ok,
            status,
            json: async () => responseBody
        } as Response;
    });
    vi.stubGlobal("fetch", spy);
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("DiscordWebhookAdapter", () => {
    const url = "https://discord.com/api/webhooks/123456789012345678/abcdefTOKEN";

    it("rejects a URL that is not a Discord webhook", async () => {
        const adapter = new DiscordWebhookAdapter("https://example.com/not-a-hook", ctx);
        await expect(adapter.connect()).rejects.toThrow(/Discord webhook URL/);
    });

    it("accepts a valid Discord webhook URL", async () => {
        const adapter = new DiscordWebhookAdapter(url, ctx);
        await expect(adapter.connect()).resolves.toEqual({ externalId: "webhook" });
    });

    it("posts plain text with wait=true and returns the created message id", async () => {
        const calls = mockFetch({ id: "999888777" });
        const adapter = new DiscordWebhookAdapter(url, ctx);

        const result = await adapter.send({ peerId: "channel", text: "Deploy finished" });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(`${url}?wait=true`);
        expect(calls[0]!.init.method).toBe("POST");
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "Deploy finished" });
        expect(result.externalId).toBe("999888777");
    });

    it("degrades an interactive prompt to numbered text (no bot -> no buttons)", async () => {
        const calls = mockFetch({ id: "1" });
        const adapter = new DiscordWebhookAdapter(url, ctx);

        await adapter.send({
            peerId: "channel",
            interactive: {
                text: "Approve the deploy?",
                options: [
                    { id: "yes", label: "Approve" },
                    { id: "no", label: "Reject" }
                ]
            }
        });

        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
            content: "Approve the deploy?\n1. Approve\n2. Reject"
        });
    });

    it("throws with the HTTP status when Discord rejects the post", async () => {
        mockFetch({}, false, 404);
        const adapter = new DiscordWebhookAdapter(url, ctx);
        await expect(adapter.send({ peerId: "channel", text: "x" })).rejects.toThrow(
            /Discord webhook failed \(404\)/
        );
    });
});

describe("SlackWebhookAdapter", () => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXXXXXX";

    it("rejects a URL that is not a Slack incoming webhook", async () => {
        const adapter = new SlackWebhookAdapter("https://discord.com/api/webhooks/1/x", ctx);
        await expect(adapter.connect()).rejects.toThrow(/Slack incoming webhook URL/);
    });

    it("accepts a valid Slack webhook URL", async () => {
        const adapter = new SlackWebhookAdapter(url, ctx);
        await expect(adapter.connect()).resolves.toEqual({ externalId: "webhook" });
    });

    it("posts text to the webhook (Slack returns no message id)", async () => {
        const calls = mockFetch("ok");
        const adapter = new SlackWebhookAdapter(url, ctx);

        const result = await adapter.send({ peerId: "channel", text: "Deploy finished" });

        expect(calls[0]!.url).toBe(url);
        expect(calls[0]!.init.method).toBe("POST");
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Deploy finished" });
        expect(result).toEqual({});
    });

    it("degrades an interactive prompt to numbered text", async () => {
        const calls = mockFetch("ok");
        const adapter = new SlackWebhookAdapter(url, ctx);

        await adapter.send({
            peerId: "channel",
            interactive: {
                text: "Approve the deploy?",
                options: [
                    { id: "yes", label: "Approve" },
                    { id: "no", label: "Reject" }
                ]
            }
        });

        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
            text: "Approve the deploy?\n1. Approve\n2. Reject"
        });
    });

    it("throws with the HTTP status when Slack rejects the post", async () => {
        mockFetch("no", false, 403);
        const adapter = new SlackWebhookAdapter(url, ctx);
        await expect(adapter.send({ peerId: "channel", text: "x" })).rejects.toThrow(
            /Slack webhook failed \(403\)/
        );
    });
});

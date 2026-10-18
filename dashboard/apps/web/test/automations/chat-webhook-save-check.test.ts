/**
 * Saving or publishing an automation that posts to a chat channel: the webhook
 * each step names must be one the person saving may post through. A save only
 * asks about the webhooks it adds, so somebody else editing the automation
 * keeps the step its owner set up; publishing asks about every one, because
 * the publisher is who the automation runs as from then on.
 */

import type * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OURS = "00000000-0000-4000-8000-0000000000a1";
const THEIRS = "00000000-0000-4000-8000-0000000000a2";
const STAMP = "0123456789abcdef";

const state = vi.hoisted(() => ({
    asked: [] as string[],
    allowed: new Set<string>()
}));

vi.mock("@/lib/chat/webhooks", () => ({
    webhookToPostThrough: async (_actor: unknown, webhookId: string, stamp: string) => {
        state.asked.push(`${webhookId}:${stamp}`);
        return state.allowed.has(webhookId)
            ? { ok: true, webhook: { id: webhookId, channelId: "c1", name: "Bot" } }
            : { ok: false, reason: "forbidden" };
    }
}));

const { checkChatWebhooks } = await import("@/lib/automations/chat-webhooks");
const { AutomationAccessError } = await import("@/lib/automations/access-error");

const ME = { id: "user-fixture", isAdmin: false };

function graph(...webhooks: string[]): core.AutomationGraph {
    return {
        schema: 1,
        timeZone: "UTC",
        nodes: [
            { id: "start", type: "core.manual", typeVersion: 1, config: {} },
            ...webhooks.map((webhookId, index) => ({
                id: `post${index}`,
                type: "core.message",
                typeVersion: 1,
                config: { webhookId, stamp: STAMP, body: "Hello" }
            }))
        ],
        edges: []
    } as unknown as core.AutomationGraph;
}

beforeEach(() => {
    state.asked.length = 0;
    state.allowed = new Set([OURS]);
});

describe("chat webhooks on save and publish", () => {
    it("lets a webhook the saver runs through", async () => {
        await expect(checkChatWebhooks(ME, graph(OURS))).resolves.toBeUndefined();
        expect(state.asked).toEqual([`${OURS}:${STAMP}`]);
    });

    it("refuses a webhook the saver may not post through", async () => {
        const attempt = checkChatWebhooks(ME, graph(THEIRS));
        await expect(attempt).rejects.toBeInstanceOf(AutomationAccessError);
        await expect(attempt).rejects.toMatchObject({ code: "webhookUnavailable" });
    });

    it("on a save, asks only about webhooks the draft did not already name", async () => {
        await expect(
            checkChatWebhooks(ME, graph(THEIRS, OURS), graph(THEIRS))
        ).resolves.toBeUndefined();
        expect(state.asked).toEqual([`${OURS}:${STAMP}`]);
    });

    it("asks nothing of a graph with no chat step", async () => {
        await checkChatWebhooks(ME, graph());
        expect(state.asked).toEqual([]);
    });
});

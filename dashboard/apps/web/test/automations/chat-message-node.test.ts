/**
 * "Post to a chat channel": the body is filled in from the run and posted
 * through the channel webhook the step chose - never as a person - and the run
 * stops with the reason, posting nothing, once that webhook is deleted, given a
 * new secret, over its limit, or on a channel the run's account no longer runs.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEBHOOK = "00000000-0000-4000-8000-000000000001";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const STAMP = "0123456789abcdef";

const state = vi.hoisted(() => ({
    posted: [] as Array<{ webhook: unknown; input: { content: string } }>,
    asked: [] as Array<{ actor: unknown; webhookId: string; stamp: string }>,
    unavailable: null as null | "gone" | "reset" | "forbidden",
    limited: false,
    refuse: false
}));

vi.mock("@/lib/chat/webhooks", () => ({
    webhookToPostThrough: async (actor: unknown, webhookId: string, stamp: string) => {
        state.asked.push({ actor, webhookId, stamp });
        if (state.unavailable) return { ok: false, reason: state.unavailable };
        return { ok: true, webhook: { id: webhookId, channelId: CHANNEL, name: "Door bot" } };
    },
    webhookPostAllowed: async () =>
        state.limited ? { ok: false, retryAfterMs: 5_000 } : { ok: true, retryAfterMs: 0 },
    postThroughWebhook: async (webhook: unknown, input: { content: string }) => {
        if (state.refuse) {
            const { ChatAccessError } = await import("@/lib/chat/access");
            throw new ChatAccessError({ key: "errors.conversationArchived" });
        }
        state.posted.push({ webhook, input });
        return "message-1";
    }
}));

vi.mock("@/lib/chat/messages", () => {
    throw new Error("an automation must never post through a person's send path");
});

const { CORE_SERVER_NODES } = await import("@/lib/automations/nodes/core-nodes");
const { StepError, StepRefusal } = await import("@/lib/automations/types");

const node = CORE_SERVER_NODES.find((entry) => entry.type === "core.message")!;
const recorded: unknown[] = [];
const io = {
    actor: { id: "user-fixture", isAdmin: false },
    recordInput: (value: unknown) => recorded.push(value)
} as never;

function run(body: string, context: Record<string, unknown> = {}) {
    const config = core.CORE_NODE_CONFIGS["core.message"].parse({
        webhookId: WEBHOOK,
        stamp: STAMP,
        body
    });
    return node.run(config, context as never, io);
}

beforeEach(() => {
    state.posted.length = 0;
    state.asked.length = 0;
    state.unavailable = null;
    state.limited = false;
    state.refuse = false;
    recorded.length = 0;
});

describe("Post to a chat channel", () => {
    it("fills the body in and posts it through the chosen webhook, checked as the run's account", async () => {
        const result = await run("Door {{trigger.name}} opened at {{trigger.at}}", {
            trigger: { name: "Front", at: "08:00" }
        });
        expect(result).toEqual({ output: { messageId: "message-1", channelId: CHANNEL } });
        expect(state.asked).toEqual([
            { actor: { id: "user-fixture", isAdmin: false }, webhookId: WEBHOOK, stamp: STAMP }
        ]);
        expect(state.posted).toEqual([
            {
                webhook: { id: WEBHOOK, channelId: CHANNEL, name: "Door bot" },
                input: { content: "Door Front opened at 08:00" }
            }
        ]);
        expect(recorded).toEqual([{ webhookId: WEBHOOK, body: "Door Front opened at 08:00" }]);
    });

    it.each([
        ["gone", "webhookGone"],
        ["reset", "webhookReset"]
    ] as const)(
        "fails with a reason, posting nothing, when the webhook is %s",
        async (why, code) => {
            state.unavailable = why;
            const attempt = run("Hello");
            await expect(attempt).rejects.toBeInstanceOf(StepError);
            await expect(attempt).rejects.not.toBeInstanceOf(StepRefusal);
            await expect(attempt).rejects.toMatchObject({ code });
            expect(state.posted).toEqual([]);
        }
    );

    it("is refused once the run's account no longer runs the channel", async () => {
        state.unavailable = "forbidden";
        const attempt = run("Hello");
        await expect(attempt).rejects.toBeInstanceOf(StepRefusal);
        await expect(attempt).rejects.toMatchObject({ code: "webhookForbidden" });
        expect(state.posted).toEqual([]);
    });

    it("holds to the webhook's own per-minute limit", async () => {
        state.limited = true;
        await expect(run("Hello")).rejects.toMatchObject({ code: "webhookLimited" });
        expect(state.posted).toEqual([]);
    });

    it("fails, rather than throwing chat's error, when the channel takes nothing", async () => {
        state.refuse = true;
        await expect(run("Hello")).rejects.toMatchObject({ code: "messageRefused" });
    });

    it("sends nothing, and asks nothing, when the filled-in body is blank", async () => {
        await expect(run("{{trigger.missing}}", { trigger: {} })).rejects.toMatchObject({
            code: "messageEmpty"
        });
        expect(state.asked).toEqual([]);
        expect(state.posted).toEqual([]);
    });

    it("is an action whose config needs a webhook, its stamp and a body - and no conversation", () => {
        const config = core.CORE_NODE_CONFIGS["core.message"];
        expect(config.safeParse({ webhookId: WEBHOOK, stamp: STAMP, body: "x" }).success).toBe(
            true
        );
        expect(config.safeParse({ webhookId: "", stamp: STAMP, body: "x" }).success).toBe(false);
        expect(config.safeParse({ webhookId: WEBHOOK, stamp: "", body: "x" }).success).toBe(false);
        expect(config.safeParse({ webhookId: WEBHOOK, stamp: STAMP, body: "" }).success).toBe(
            false
        );
        const parsed = config.parse({
            webhookId: WEBHOOK,
            stamp: STAMP,
            body: "x",
            channelId: CHANNEL
        });
        expect(parsed).not.toHaveProperty("channelId");
        expect(core.nodeRole("core.message")).toBe("action");
        expect(core.CORE_NODE_META["core.message"].idempotent).toBe(false);
    });
});

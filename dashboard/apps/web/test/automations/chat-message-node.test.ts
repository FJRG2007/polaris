/**
 * "Send a chat message": the body is filled in from the run, posted through
 * chat's own send as the account the automation runs as, and refused - not
 * posted - once that account may no longer write in the conversation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@polaris/core";

const sent: Array<{ actor: { id: string }; input: { channelId: string; body: string } }> = [];
let refusal: Error | null = null;

vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string }) => {
        if (refusal) throw refusal;
        sent.push({ actor, input });
        return "message-1";
    }
}));

const { ChatAccessError, ChatRuleError } = await import("@/lib/chat/access");
const { CORE_SERVER_NODES } = await import("@/lib/automations/nodes/core-nodes");
const { StepError, StepRefusal } = await import("@/lib/automations/types");

const node = CORE_SERVER_NODES.find((entry) => entry.type === "core.message")!;
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const recorded: unknown[] = [];
const io = {
    actor: { id: "user-fixture", isAdmin: false },
    recordInput: (value: unknown) => recorded.push(value)
} as never;

function run(body: string, context: Record<string, unknown> = {}) {
    const config = core.CORE_NODE_CONFIGS["core.message"].parse({ channelId: CHANNEL, body });
    return node.run(config, context as never, io);
}

beforeEach(() => {
    sent.length = 0;
    recorded.length = 0;
    refusal = null;
});

describe("Send a chat message", () => {
    it("fills the body in from the run and posts it as the run's account", async () => {
        const result = await run("Door {{trigger.name}} opened at {{trigger.at}}", {
            trigger: { name: "Front", at: "08:00" }
        });
        expect(result).toEqual({ output: { messageId: "message-1" } });
        expect(sent).toEqual([
            {
                actor: { id: "user-fixture" },
                input: { channelId: CHANNEL, body: "Door Front opened at 08:00" }
            }
        ]);
        expect(recorded).toEqual([{ channelId: CHANNEL, body: "Door Front opened at 08:00" }]);
    });

    it("is refused, and posts nothing, once the account lost the conversation", async () => {
        refusal = new ChatAccessError({ key: "errors.channelNotFound" } as never);
        const attempt = run("Hello");
        await expect(attempt).rejects.toBeInstanceOf(StepRefusal);
        await expect(attempt).rejects.toMatchObject({ code: "messageForbidden" });
        expect(sent).toEqual([]);
    });

    it("fails, rather than refuses, on a chat rule such as slow mode", async () => {
        refusal = new ChatRuleError({ key: "errors.bodyRequired" } as never);
        const attempt = run("Hello");
        await expect(attempt).rejects.toMatchObject({ code: "messageRefused" });
        await expect(attempt).rejects.not.toBeInstanceOf(StepRefusal);
        await expect(attempt).rejects.toBeInstanceOf(StepError);
    });

    it.each([
        [{ key: "errors.slowMode", params: { wait: "1 minute" } }, "messageTooOften"],
        [{ key: "errors.messageTooLong", params: { count: 10 } }, "messageTooLong"],
        [{ key: "errors.tooManyMentions", params: { count: 5 } }, "messageMentions"],
        [{ key: "errors.blockedRecipientUnnamed" }, "messageBlocked"]
    ])("says what to change when chat refuses with %o", async (text, code) => {
        refusal = new ChatRuleError(text as never);
        await expect(run("Hello")).rejects.toMatchObject({ code });
    });

    it("sends nothing when the filled-in body is blank", async () => {
        await expect(run("{{trigger.missing}}", { trigger: {} })).rejects.toMatchObject({
            code: "messageEmpty"
        });
        expect(sent).toEqual([]);
    });

    it("is an action whose config needs a conversation and a body", () => {
        const config = core.CORE_NODE_CONFIGS["core.message"];
        expect(config.safeParse({ channelId: CHANNEL, body: "x" }).success).toBe(true);
        expect(config.safeParse({ channelId: "", body: "x" }).success).toBe(false);
        expect(config.safeParse({ channelId: CHANNEL, body: "" }).success).toBe(false);
        expect(core.nodeRole("core.message")).toBe("action");
    });
});

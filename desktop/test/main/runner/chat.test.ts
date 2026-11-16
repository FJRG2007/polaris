import { describe, expect, it } from "vitest";
import type { RunnerFrame } from "@/main/runner/connection";
import { ChatHost, chatPrompt, type ClaudeSdk } from "@/main/runner/chat";

const TURN_ID = "7d4f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c";

const turn = {
    v: 1,
    type: "chat.turn" as const,
    turnId: TURN_ID,
    model: "sonnet",
    system: "You are Polar.",
    messages: [{ role: "user" as const, text: "hi" }],
    effort: null,
    mcp: null
};

function fakeSdk(script: (options: Record<string, unknown>) => AsyncGenerator<unknown>): ClaudeSdk & { seen: { prompt: string; options: Record<string, unknown>; }[]; } {
    const seen: { prompt: string; options: Record<string, unknown>; }[] = [];
    return {
        seen,
        query: (input) => {
            seen.push(input);
            return script(input.options);
        }
    };
}

function harness(sdk: ClaudeSdk | null) {
    const sent: RunnerFrame[] = [];
    const host = new ChatHost({
        send: (frame) => {
            sent.push(frame);
            return true;
        },
        prepare: async () => (sdk ? { env: { PATH: "/tc" }, claudePath: "/tc/claude", sdk } : null),
        cwd: "/fixture/chat"
    });
    return { host, sent };
}

const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("runner chat turns", () => {
    it("streams mapped events with increasing seq and finishes", async () => {
        const sdk = fakeSdk(async function* () {
            yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } };
            yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } };
            yield { type: "result", subtype: "success", usage: { input_tokens: 3, output_tokens: 2 } };
        });
        const { host, sent } = harness(sdk);
        host.handle(turn);
        await until(() => sent.length === 3);
        expect(sent).toEqual([
            { type: "chat.event", turnId: TURN_ID, seq: 0, event: { kind: "text", text: "Hel" } },
            { type: "chat.event", turnId: TURN_ID, seq: 1, event: { kind: "text", text: "lo" } },
            { type: "chat.event", turnId: TURN_ID, seq: 2, event: { kind: "finish", reason: "stop", usage: { input: 3, output: 2 } } }
        ]);
        expect(sdk.seen[0]!.options).toMatchObject({ pathToClaudeCodeExecutable: "/tc/claude", cwd: "/fixture/chat", model: "sonnet", tools: [] });
    });

    it("waits on the person for a tool call and passes the answer", async () => {
        let answer: unknown = null;
        const sdk = fakeSdk(async function* (options) {
            const canUseTool = options.canUseTool as (name: string, input: Record<string, unknown>, context: { toolUseID: string; }) => Promise<unknown>;
            answer = await canUseTool("mcp__polaris__tasks_list", { q: 1 }, { toolUseID: "toolu_1" });
            yield { type: "result", subtype: "success" };
        });
        const { host, sent } = harness(sdk);
        host.handle(turn);
        await until(() => sent.length === 1);
        const approval = sent[0] as { event: { kind: string; approvalId: string; callId: string; name: string; }; };
        expect(approval.event).toMatchObject({ kind: "approval", callId: "toolu_1", name: "mcp__polaris__tasks_list" });
        host.handle({ v: 1, type: "chat.approval", turnId: TURN_ID, approvalId: approval.event.approvalId, allow: true });
        await until(() => sent.length === 2);
        expect(answer).toEqual({ behavior: "allow", updatedInput: { q: 1 } });
    });

    it("cancels: a waiting approval is declined and the turn finishes cancelled", async () => {
        const sdk = fakeSdk(async function* (options) {
            const canUseTool = options.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; }>;
            const result = await canUseTool("x", {});
            if (result.behavior === "deny") throw new Error("aborted");
            yield { type: "result", subtype: "success" };
        });
        const { host, sent } = harness(sdk);
        host.handle(turn);
        await until(() => sent.length === 1);
        host.handle({ v: 1, type: "chat.cancel", turnId: TURN_ID });
        await until(() => sent.length === 2);
        expect(sent[1]).toMatchObject({ seq: 1, event: { kind: "finish", reason: "cancelled" } });
    });

    it("says not-installed when Claude Code could not be prepared, and maps a failure to its word", async () => {
        const missing = harness(null);
        missing.host.handle(turn);
        await until(() => missing.sent.length === 1);
        expect(missing.sent[0]).toMatchObject({ event: { kind: "error", code: "not-installed" } });

        const failing = harness(
            fakeSdk(async function* () {
                throw new Error("Invalid API key. Please run /login");
            })
        );
        failing.host.handle(turn);
        await until(() => failing.sent.length === 1);
        expect(failing.sent[0]).toMatchObject({ event: { kind: "error", code: "signed-out" } });
    });

    it("quotes earlier turns before the newest message", () => {
        expect(chatPrompt([{ role: "user", text: "one" }])).toBe("one");
        expect(chatPrompt([{ role: "user", text: "one" }, { role: "assistant", text: "two" }, { role: "user", text: "three" }])).toBe("<conversation>\nUser: one\n\nAssistant: two\n</conversation>\n\nthree");
    });
});

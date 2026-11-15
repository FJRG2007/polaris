import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { RECORDED } from "./fake-pipe";
import { AcpNormalizer } from "@/lib/agents/acp/normalize";
import { optionFor, promptFor } from "@/lib/agents/acp/approvals";
import { MAX_TEXT_CHARS } from "@/lib/agents/transcript-decoders";
import type { PermissionOption, RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";

const updates = RECORDED.filter((frame) => frame.method === "session/update").map(
    (frame) => (frame.params as SessionNotification).update
);

describe("AcpNormalizer", () => {
    it("turns the recorded turn into the rows a transcript gives", () => {
        const normalizer = new AcpNormalizer("sess_abc123def456", () => 1_000);
        const rows = [...updates.flatMap((update) => normalizer.push(update)), ...normalizer.finish("end_turn")];
        expect(rows).toEqual([
            {
                vendorId: "msg_agent_c42b9:0",
                role: "agent",
                kind: "text",
                subject: "",
                ref: "",
                body: "I'll analyze your code for potential issues. Let me examine it...",
                at: 1_000
            },
            {
                vendorId: "call_001:call",
                role: "agent",
                kind: "tool",
                subject: "Analyzing Python code",
                ref: "call_001",
                body: "",
                at: 1_000
            },
            {
                vendorId: "call_001:result",
                role: "agent",
                kind: "result",
                subject: "",
                ref: "call_001",
                body: expect.stringMatching(/^Analysis complete:\n- No syntax errors found/),
                at: 1_000
            }
        ]);
    });

    it("gathers chunks into one message and keeps no thinking", () => {
        const normalizer = new AcpNormalizer("s", () => 1);
        const chunk = (text: string) => ({
            sessionUpdate: "agent_message_chunk" as const,
            content: { type: "text" as const, text }
        });
        expect(normalizer.push(chunk("Hel"))).toEqual([]);
        expect(normalizer.push(chunk("lo"))).toEqual([]);
        expect(
            normalizer.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })
        ).toEqual([]);
        const rows = normalizer.push({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "next" }
        });
        expect(rows).toMatchObject([{ vendorId: "s:1:0", role: "agent", body: "Hello" }]);
        expect(normalizer.finish("cancelled")).toMatchObject([
            { vendorId: "s:2:0", role: "user", body: "next" },
            { role: "system", kind: "marker", subject: "interrupted" }
        ]);
    });

    it("bounds a message and marks a failed tool once", () => {
        const normalizer = new AcpNormalizer("s", () => 1);
        normalizer.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(MAX_TEXT_CHARS + 50) }
        });
        normalizer.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "more" }
        });
        const [message] = normalizer.finish();
        expect(message!.body.length).toBe(MAX_TEXT_CHARS);
        const failed = {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "t1",
            title: "Run tests",
            status: "failed" as const,
            rawOutput: "exit 1"
        };
        expect(normalizer.push(failed)).toMatchObject([
            { kind: "tool", subject: "Run tests" },
            { kind: "result", subject: "error", body: "exit 1" }
        ]);
        expect(normalizer.push(failed)).toEqual([]);
    });
});

describe("ACP approvals", () => {
    const options = (RECORDED[5]!.params as RequestPermissionRequest).options;
    const withAlways: PermissionOption[] = [...options, { optionId: "always", name: "Always", kind: "allow_always" }];

    it("maps the person's answer to the offered option of that kind", () => {
        expect(optionFor("allow", options)).toBe("allow-once");
        expect(optionFor("deny", options)).toBe("reject-once");
        expect(optionFor("always", withAlways)).toBe("always");
        // Always falls back to once; once never becomes always.
        expect(optionFor("always", options)).toBe("allow-once");
        expect(optionFor("allow", [withAlways[2]!])).toBeNull();
    });

    it("gives no decision when nobody answered", () => {
        expect(optionFor("expired", options)).toBeNull();
        expect(optionFor("pending", options)).toBeNull();
    });

    it("names the prompt by the tool call", () => {
        expect(
            promptFor({
                sessionId: "s",
                options,
                toolCall: { toolCallId: "c", title: "Run npm test", kind: "execute", rawInput: { command: "npm test" } }
            })
        ).toEqual({ tool: "Run npm test", detail: "npm test" });
        expect(promptFor({ sessionId: "s", options, toolCall: { toolCallId: "c" } }).tool).toBe("tool");
    });
});

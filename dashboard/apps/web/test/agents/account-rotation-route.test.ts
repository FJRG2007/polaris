/**
 * The events route hands a failed turn to the account rotation with the whole
 * payload and the hook's sequence, names the account on a turn's prompt, and
 * leaves a refused sign-in to its own handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "00000000-0000-4000-8000-000000000001";

const seen = vi.hoisted(() => ({
    failures: [] as { id: string; payload: unknown; seq: bigint | null }[],
    finished: [] as string[],
    refused: [] as string[],
    recorded: [] as { kind: string; detail: string; subject: string }[]
}));

vi.mock("next/server", () => ({ after: (task: () => unknown) => void task() }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/agents/session-history", () => ({
    syncFinalSessionHistory: async () => undefined,
    syncSessionHistorySoon: async () => undefined
}));
vi.mock("@/lib/agents/session-service", () => ({
    sessionForToken: async (token: string) => (token === "good" ? { id: SESSION } : null),
    recordSessionConversation: async () => undefined,
    recordSessionTodos: async () => undefined,
    recordTaskTool: async () => undefined,
    recordReportedMode: async () => undefined,
    recordSessionEvents: async (_id: string, events: { kind: string; detail: string; subject: string }[]) => {
        seen.recorded.push(...events);
        return "idle";
    }
}));
vi.mock("@/lib/agents/signin-refusal", async (original) => ({
    ...(await original<object>()),
    noteRefusedSignIn: async (id: string) => {
        seen.refused.push(id);
    }
}));
vi.mock("@/lib/agents/account-rotation", () => ({
    handleTurnFailure: async (id: string, payload: unknown, seq: bigint | null) => {
        seen.failures.push({ id, payload, seq });
        return "rotated";
    },
    noteTurnFinished: async (id: string) => {
        seen.finished.push(id);
    },
    turnAccountName: async () => "second@example.test"
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/agents/session-prompt-queue", () => ({ deliverNextQueued: async () => false }));

const { POST } = await import("@/app/api/agents/sessions/[id]/events/route");

function post(body: unknown, seq = "1700000000000000005") {
    return POST(
        new Request(`http://polaris.test/api/agents/sessions/${SESSION}/events`, {
            method: "POST",
            headers: { authorization: "Bearer good", "x-polaris-seq": seq },
            body: JSON.stringify(body)
        }),
        { params: Promise.resolve({ id: SESSION }) }
    );
}

describe("POST /api/agents/sessions/:id/events", () => {
    beforeEach(() => {
        seen.failures.length = 0;
        seen.finished.length = 0;
        seen.refused.length = 0;
        seen.recorded.length = 0;
    });

    it("hands a usage limit to the rotation with the whole payload and the sequence", async () => {
        const payload = {
            hook_event_name: "StopFailure",
            error: "rate_limit",
            error_details: "429 Too Many Requests",
            last_assistant_message: "You've hit your session limit · resets 2:40pm (Europe/Istanbul)"
        };
        expect((await post(payload)).status).toBe(200);
        await vi.waitFor(() => expect(seen.failures).toHaveLength(1));
        expect(seen.failures[0]).toEqual({ id: SESSION, payload, seq: 1700000000000000005n });
        expect(seen.refused).toEqual([]);
        expect(seen.recorded[0]?.kind).toBe("turn.failed");
    });

    it("leaves a refused sign-in to its own handler", async () => {
        await post({ hook_event_name: "StopFailure", error: "authentication_failed", error_details: "Invalid bearer token" });
        await vi.waitFor(() => expect(seen.refused).toEqual([SESSION]));
        expect(seen.failures).toEqual([]);
    });

    it("names the account a turn runs on and starts the counts over when one finishes", async () => {
        await post({ hook_event_name: "UserPromptSubmit", prompt: "Fix the flaky test" });
        expect(seen.recorded[0]).toEqual({
            kind: "prompt",
            detail: "Fix the flaky test",
            subject: "second@example.test",
            agentId: null,
            agentType: null,
            ref: null
        });
        await post({ hook_event_name: "Stop" });
        await vi.waitFor(() => expect(seen.finished).toEqual([SESSION]));
    });
});

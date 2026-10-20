/**
 * POST /api/polar/threads/:id/compact: only the owner's thread and a message in
 * it are compacted, the marker is saved under that message, its spend is
 * recorded, and the shared key's ceiling holds whichever key the model
 * resolves to - not whichever payer the request names.
 */

import { NextResponse } from "next/server";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = { id: "u1", name: "Ada", isAdmin: false, viewingAs: null as null | string };
const THREAD = "22222222-2222-4222-8222-222222222222";

const text = (value: string) => [{ type: "text", text: value }];

const state = {
    viewingAs: null as null | string,
    limited: false,
    owned: true,
    source: "own" as "own" | "instance",
    hit: null as null | { used: number; amount: number; period: string },
    summary: "The summary." as string | Error,
    prompts: [] as unknown[],
    created: [] as { data: Record<string, unknown> }[],
    recorded: [] as Record<string, unknown>[],
    limitChecks: 0,
    messages: [
        { id: "q1", parentId: null, role: "user", parts: text("First question"), metadata: null },
        {
            id: "a1",
            parentId: "q1",
            role: "assistant",
            parts: text("First answer"),
            metadata: null
        },
        { id: "q2", parentId: "a1", role: "user", parts: text("Second question"), metadata: null },
        {
            id: "a2",
            parentId: "q2",
            role: "assistant",
            parts: text("Second answer"),
            metadata: null
        }
    ]
};

vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/api-session", () => ({
    apiUser: async () => ({ ...USER, viewingAs: state.viewingAs })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/polar/usage", () => ({
    answerUsage: (usage?: { inputTokens?: number; outputTokens?: number }) => ({
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: null
    }),
    polarLimitReached: async () => {
        state.limitChecks++;
        return state.hit;
    },
    recordPolarUsage: async (entry: Record<string, unknown>) => void state.recorded.push(entry)
}));
vi.mock("@/lib/polar/threads", () => ({
    getPolarThread: async (userId: string, id: string) =>
        state.owned && userId === USER.id && id === THREAD ? { id, messages: state.messages } : null
}));
vi.mock("@/lib/polar/models", () => ({
    reasoningFor: () => undefined,
    resolvePolarModel: async () => ({
        model: new MockLanguageModelV4({
            doGenerate: async (options) => {
                state.prompts.push(options.prompt);
                if (state.summary instanceof Error) throw state.summary;
                return {
                    content: [{ type: "text" as const, text: state.summary }],
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: {
                        inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 30, text: 30, reasoning: 0 }
                    },
                    warnings: []
                };
            }
        }),
        option: { provider: "anthropic", providerName: "Anthropic", model: "m-1", name: "M 1" },
        credential: { source: state.source }
    })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarMessage: {
            create: (args: { data: Record<string, unknown> }) => {
                state.created.push(args);
                return args;
            }
        },
        polarThread: { update: (args: unknown) => args },
        $transaction: async (operations: unknown[]) => operations
    }
}));

const route = await import("@/app/api/polar/threads/[id]/compact/route");

function post(body: Record<string, unknown>, id = THREAD) {
    return route.POST(
        new Request(`http://localhost/api/polar/threads/${id}/compact`, {
            method: "POST",
            body: JSON.stringify({
                messageId: "a2",
                choice: { provider: "auto", model: "auto", payer: "own" },
                ...body
            })
        }),
        { params: Promise.resolve({ id }) }
    );
}

beforeEach(() => {
    state.viewingAs = null;
    state.limited = false;
    state.owned = true;
    state.source = "own";
    state.hit = null;
    state.summary = "The summary.";
    state.prompts = [];
    state.created = [];
    state.recorded = [];
    state.limitChecks = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("compacting a thread", () => {
    it("saves the summary as a marker under the message and records its spend", async () => {
        const response = await post({});
        expect(response.status).toBe(200);
        const { message } = (await response.json()) as {
            message: {
                id: string;
                role: string;
                parts: unknown;
                metadata: Record<string, unknown>;
            };
        };
        expect(message.role).toBe("assistant");
        expect(message.parts).toEqual(text("The summary."));
        expect(message.metadata.compaction).toMatchObject({ auto: false, keep: 0 });
        expect(state.created).toHaveLength(1);
        expect(state.created[0]?.data).toMatchObject({
            id: message.id,
            threadId: THREAD,
            parentId: "a2"
        });
        expect(JSON.stringify(state.prompts)).toContain("Second answer");
        expect(state.recorded).toEqual([
            expect.objectContaining({
                userId: USER.id,
                threadId: THREAD,
                messageId: message.id,
                payer: "own",
                usage: expect.objectContaining({ inputTokens: 120, outputTokens: 30 })
            })
        ]);
    });

    it("is a thread that does not exist for someone else, or a message not in it", async () => {
        state.owned = false;
        expect((await post({})).status).toBe(404);
        state.owned = true;
        expect((await post({ messageId: "elsewhere" })).status).toBe(404);
        expect((await post({}, "not-a-uuid")).status).toBe(404);
        expect(state.created).toHaveLength(0);
    });

    it("holds the shared key's ceiling for the key that resolved, whatever the payer says", async () => {
        state.source = "instance";
        state.hit = { used: 10, amount: 5, period: "day" };
        const response = await post({ choice: { provider: "auto", model: "auto", payer: "own" } });
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({ error: "usage_limit", amount: 5 });
        expect(state.prompts).toHaveLength(0);
        expect(state.created).toHaveLength(0);
    });

    it("does not count a person's own key against the shared ceiling", async () => {
        state.hit = { used: 10, amount: 5, period: "day" };
        expect(
            (await post({ choice: { provider: "auto", model: "auto", payer: "instance" } })).status
        ).toBe(200);
        expect(state.limitChecks).toBe(0);
    });

    it("saves nothing when the model fails", async () => {
        state.summary = new Error("down");
        expect((await post({})).status).toBe(502);
        expect(state.created).toHaveLength(0);
        expect(state.recorded).toHaveLength(0);
    });

    it("refuses someone viewing as another person, and a caller over the rate", async () => {
        state.viewingAs = "u2";
        expect((await post({})).status).toBe(403);
        state.viewingAs = null;
        state.limited = true;
        expect((await post({})).status).toBe(429);
        expect(state.created).toHaveLength(0);
    });

    it("answers there is nothing to compact right after a marker", async () => {
        state.messages = [
            ...state.messages,
            {
                id: "c1",
                parentId: "a2",
                role: "assistant",
                parts: text("Earlier summary"),
                metadata: { compaction: { auto: false, keep: 0, at: "2026-01-01T00:00:00.000Z" } }
            } as never
        ];
        expect((await post({ messageId: "c1" })).status).toBe(409);
        state.messages = state.messages.slice(0, 4);
    });
});

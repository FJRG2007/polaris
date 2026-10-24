/**
 * POST /api/polar/chat: who may talk to Polar, what a request has to look like,
 * and what happens when the model reaches for a tool that changes something.
 *
 * The model is the AI SDK's own mock, streaming real parts through the real
 * `streamText`, so the approval a write tool waits for is the SDK's, not a
 * stand-in for it.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { MockLanguageModelV4 } from "ai/test";
import { tool, type LanguageModelV4StreamPart, type UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolarRuns } from "@/lib/polar/runs";

const USER = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Ada",
    isAdmin: false,
    viewingAs: null
};
const THREAD = "22222222-2222-4222-8222-222222222222";

const state = {
    user: USER as typeof USER | { viewingAs: string } | "anonymous",
    limited: false,
    resolved: "ok" as "ok" | "no_key" | "unknown_model" | "retired-then-ok",
    owned: true,
    parts: [] as LanguageModelV4StreamPart[],
    executed: [] as string[],
    saved: [] as unknown[],
    asked: [] as unknown[],
    titled: [] as unknown[][],
    suggested: [] as unknown[][],
    suggestions: true,
    resolveCalls: 0,
    ensured: [] as unknown[][],
    signals: [] as unknown[],
    source: "own" as "own" | "instance",
    helperSource: null as null | "own" | "instance",
    hit: null as null | { used: number; amount: number; period: string },
    recorded: [] as unknown[],
    web: true,
    models: [] as MockLanguageModelV4[],
    unreadable: null as string | null,
    failWith: null as null | { statusCode: number; message: string },
    prompts: [] as unknown[],
    goalsSet: [] as unknown[][]
};

vi.mock("@/lib/polar/access", async () => ({
    ...(await (await import("./fixtures/open-polar-access")).openPolarAccess()),
    polarAccessFor: async () => ({ use: true, spend: true, web: state.web })
}));
vi.mock("@/lib/polar/usage", () => ({
    answerUsage: (usage?: { inputTokens?: number; outputTokens?: number }) => ({
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: null
    }),
    stepContext: () => ({}),
    polarLimitReached: async () => state.hit,
    recordPolarUsage: async (entry: unknown) => void state.recorded.push(entry)
}));

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user === "anonymous"
            ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
            : { ...USER, ...(state.user as object) }
}));
// The repository tools ask for a linked GitHub account; nobody here has one.
vi.mock("@/lib/github-access", () => ({ githubTokenForUser: async () => null }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/polar/attachments", () => ({
    inlinePolarFiles: async (_user: string, messages: unknown, _option: unknown, out: string[]) => {
        if (state.unreadable) out.push(state.unreadable);
        return messages;
    }
}));
vi.mock("@/lib/polar/memory", () => ({
    MEMORY_APPROVAL: { polar_remember: "user-approval" },
    polarMemoryEnabled: async () => true,
    polarMemoryPrompt: async () => "",
    polarMemoryTools: () => ({})
}));
vi.mock("@/lib/polar/threads", () => ({
    ensurePolarThread: async (...args: unknown[]) => {
        state.ensured.push(args);
        return state.owned ? { temporary: false } : null;
    },
    polarThreadInstructions: async () => null,
    // A question is kept as it is asked (`saved` holds only finished turns).
    savePolarMessages: async (...args: unknown[]) => {
        const list = args[2] as UIMessage[];
        (list.at(-1)?.role === "user" ? state.asked : state.saved).push(args);
    }
}));
vi.mock("@/lib/polar/run-notices", () => ({ noticePolarRunEnd: async () => undefined }));
// No chat here has a /goal (`goal-route.test.ts` covers the ones that do).
vi.mock("@/lib/polar/goal-store", () => ({
    polarGoal: async () => null,
    setPolarGoal: async (...args: unknown[]) => {
        state.goalsSet.push(args);
        return null;
    },
    savePolarGoal: async () => false
}));
vi.mock("@/lib/polar/titles", () => ({
    startPolarTitle: (...args: unknown[]) => void state.titled.push(args)
}));
vi.mock("@/lib/polar/preferences", () => ({
    polarPreferences: async () => ({ suggestions: state.suggestions, helperModel: null })
}));
vi.mock("@/lib/polar/suggestions", () => ({
    startPolarSuggestion: (...args: unknown[]) => void state.suggested.push(args)
}));

/** The first step streams `state.parts`; any step after a tool ran just answers. */
function model() {
    let step = 0;
    const mock = new MockLanguageModelV4({
        doStream: async (options: { prompt: unknown }) => {
            state.prompts.push(options.prompt);
            if (state.failWith)
                throw Object.assign(new Error(state.failWith.message), state.failWith);
            return {
                stream: new ReadableStream({
                    start(controller) {
                        for (const part of step++ === 0 ? state.parts : says("Here you go."))
                            controller.enqueue(part);
                        controller.close();
                    }
                })
            };
        }
    });
    state.models.push(mock);
    return mock;
}

const OPTION = {
    provider: "anthropic",
    providerName: "Anthropic",
    model: "m-1",
    name: "M 1",
    reasoning: false
};

vi.mock("@/lib/polar/models", () => ({
    polarModelOptions: async () => [
        { provider: "anthropic", models: [{ provider: "anthropic", model: "m-1" }] }
    ],
    reasoningFor: () => undefined,
    resolvePolarModel: async (
        _user: string,
        choice: { model: string; intelligence?: string },
        signals?: unknown
    ) => {
        state.resolveCalls++;
        state.signals.push(signals);
        if (state.resolved === "no_key") return "no_key";
        if (state.resolved === "unknown_model") return "unknown_model";
        if (state.resolved === "retired-then-ok" && choice.model === "retired")
            return "unknown_model";
        return {
            model: model(),
            option: OPTION,
            credential: {
                source:
                    choice.intelligence === "fast"
                        ? (state.helperSource ?? state.source)
                        : state.source,
                provider: OPTION.provider
            }
        };
    }
}));

vi.mock("@/lib/polar/tools", () => ({
    polarTools: async () => ({
        tools: {
            read_tasks: tool({
                description: "Lists tasks",
                inputSchema: z.object({}),
                execute: async () => {
                    state.executed.push("read_tasks");
                    return { ok: true, text: "none" };
                }
            }),
            delete_task: tool({
                description: "Deletes a task",
                inputSchema: z.object({ id: z.string() }),
                execute: async () => {
                    state.executed.push("delete_task");
                    return { ok: true, text: "deleted" };
                }
            })
        },
        approval: { delete_task: "user-approval" },
        described: {},
        // Core tools, so every turn sends them whatever the screen.
        catalog: [
            { name: "read_tasks", description: "Lists tasks", category: "polaris" },
            { name: "delete_task", description: "Deletes a task", category: "polaris" }
        ],
        call: async (name: string) => {
            state.executed.push(name);
            return { ok: true, text: "Task T-1: write the report" };
        }
    })
}));

const route = await import("../../src/app/api/polar/chat/route");

const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function says(text: string): LanguageModelV4StreamPart[] {
    return [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } }
    ];
}

function calls(toolName: string, input: object): LanguageModelV4StreamPart[] {
    return [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
        { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } }
    ];
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        threadId: THREAD,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Tidy my tasks" }] }],
        choice: {
            kind: "language",
            provider: "anthropic",
            model: "m-1",
            intelligence: "balanced",
            payer: null
        },
        context: { route: "/tasks", title: "Tasks" },
        ...overrides
    };
}

function post(payload: unknown): Promise<Response> {
    return route.POST(
        new Request("https://polaris.test/api/polar/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof payload === "string" ? payload : JSON.stringify(payload)
        })
    );
}

beforeEach(() => {
    state.user = USER;
    state.limited = false;
    state.resolved = "ok";
    state.source = "own";
    state.helperSource = null;
    state.hit = null;
    state.recorded = [];
    state.owned = true;
    state.parts = says("Done.");
    state.executed = [];
    state.saved = [];
    state.asked = [];
    resetPolarRuns();
    state.titled = [];
    state.suggested = [];
    state.suggestions = true;
    state.resolveCalls = 0;
    state.ensured = [];
    state.signals = [];
    state.web = true;
    state.models = [];
    state.unreadable = null;
    state.failWith = null;
    state.prompts = [];
    state.goalsSet = [];
});

/** The messages a turn saved, from its savePolarMessages call. */
function savedTurn(at = 0): UIMessage[] {
    return (state.saved[at] as [string, string, UIMessage[]])[2];
}

describe("who may talk to Polar", () => {
    it("turns away a request with no session", async () => {
        state.user = "anonymous";
        expect((await post(body())).status).toBe(401);
    });

    it("refuses an administrator viewing as somebody else", async () => {
        state.user = { viewingAs: "someone-else" };
        const answer = await post(body());
        expect(answer.status).toBe(403);
        expect(await answer.json()).toEqual({ error: "view_as" });
    });

    it("slows down a person sending too fast", async () => {
        state.limited = true;
        expect((await post(body())).status).toBe(429);
    });

    it("answers a thread that belongs to somebody else as not found", async () => {
        state.owned = false;
        expect((await post(body())).status).toBe(404);
    });
});

describe("what a request has to look like", () => {
    it.each([
        ["not JSON", "{"],
        ["a thread id that is not a uuid", body({ threadId: "abc" })],
        ["no messages", body({ messages: [] })],
        ["a message that is not a UI message", body({ messages: [{ hello: "world" }] })],
        ["a page route with a query string", body({ context: { route: "/tasks?token=x" } })],
        [
            "an unknown intelligence",
            body({ choice: { provider: "anthropic", model: "m-1", intelligence: "huge" } })
        ],
        ["an unknown way to answer again", body({ refine: "funnier" })]
    ])("refuses %s", async (_name, payload) => {
        const answer = await post(payload);
        expect(answer.status).toBe(400);
        expect(state.resolveCalls).toBe(0);
    });

    it("says so when there is no key to spend", async () => {
        state.resolved = "no_key";
        const answer = await post(body());
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({ error: "no_key" });
    });

    it("answers with the first available model when the chosen one was retired", async () => {
        state.resolved = "retired-then-ok";
        const answer = await post(
            body({
                choice: {
                    provider: "anthropic",
                    model: "retired",
                    intelligence: "balanced",
                    payer: null
                }
            })
        );
        expect(answer.status).toBe(200);
        const text = await answer.text();
        expect(text).toContain('"fellBackFrom":"retired"');
    });

    it("keeps the thread's model for a command's turn, and stores it otherwise", async () => {
        await (await post(body({ remember: false }))).text();
        expect(state.ensured[0]?.[3]).toBeNull();
        await (await post(body())).text();
        expect(state.ensured[1]?.[3]).toMatchObject({ provider: "anthropic", model: "m-1" });
    });

    it("hands the model resolver what the turn carries, for Automatic", async () => {
        await (await post(body())).text();
        expect(state.signals[0]).toEqual({
            files: 0,
            tools: false,
            contextChars: "Tidy my tasks".length,
            lastChars: "Tidy my tasks".length
        });
    });

    it("answers a turn on the shared key past an administrator's ceiling with why, and keeps it", async () => {
        state.source = "instance";
        state.hit = { used: 120, amount: 100, period: "day" };
        const answer = await post(body());
        const text = await answer.text();
        expect(text).toContain('"type":"data-polar-failure"');
        expect(state.prompts).toEqual([]);
        expect(state.ensured).toHaveLength(1);
        const [question, reply] = savedTurn();
        expect(question?.id).toBe("u1");
        expect(reply?.role).toBe("assistant");
        expect(reply?.id).toBeTruthy();
        expect(text).toContain(`"messageId":"${reply?.id}"`);
        expect(reply?.parts).toContainEqual({
            type: "data-polar-failure",
            data: { code: "usage_limit", used: 120, amount: 100, period: "day" }
        });
    });

    it("keeps the chat's goal when the turn setting a new one is refused", async () => {
        state.source = "instance";
        state.hit = { used: 120, amount: 100, period: "day" };
        const goal = {
            messages: [
                {
                    id: "u1",
                    role: "user",
                    parts: [{ type: "text", text: "all tests pass" }],
                    metadata: { goal: "set" }
                }
            ]
        };
        await (await post(body(goal))).text();
        expect(state.goalsSet).toEqual([]);
        state.hit = null;
        await (await post(body(goal))).text();
        expect(state.goalsSet).toEqual([[USER.id, THREAD, "all tests pass"]]);
    });

    it("keeps a turn whose file the model could not read, with the file's name", async () => {
        state.unreadable = "scan.tiff";
        const text = await (await post(body())).text();
        expect(text).toContain("scan.tiff");
        expect(state.prompts).toEqual([]);
        expect(savedTurn()[1]?.parts).toContainEqual({
            type: "data-polar-failure",
            data: { code: "file_unreadable", name: "scan.tiff" }
        });
    });

    it("keeps a provider's refusal in the answer it cut short", async () => {
        state.failWith = { statusCode: 402, message: "payment required" };
        const text = await (await post(body())).text();
        expect(text).toContain('"type":"error"');
        const reply = savedTurn().at(-1);
        expect(reply?.role).toBe("assistant");
        expect(reply?.id).toBeTruthy();
        expect(reply?.parts).toContainEqual({
            type: "data-polar-failure",
            data: {
                code: "provider",
                kind: "credit",
                provider: "Anthropic",
                slug: "anthropic",
                payer: "own"
            }
        });
    });

    it("never hands the model a stored failure, nor an answer that was only one", async () => {
        const failure = {
            type: "data-polar-failure",
            data: { code: "file_unreadable", name: "a" }
        };
        await (
            await post(
                body({
                    messages: [
                        { id: "u0", role: "user", parts: [{ type: "text", text: "Read this" }] },
                        { id: "a0", role: "assistant", parts: [{ type: "step-start" }, failure] },
                        { id: "u1", role: "user", parts: [{ type: "text", text: "Tidy my tasks" }] }
                    ]
                })
            )
        ).text();
        const prompt = JSON.stringify(state.prompts[0]);
        expect(prompt).not.toContain("data-polar-failure");
        expect((state.prompts[0] as { role: string }[]).map((entry) => entry.role)).toEqual([
            "system",
            "user",
            "user"
        ]);
    });

    it("never caps a person's own key", async () => {
        state.hit = { used: 120, amount: 100, period: "day" };
        const answer = await post(body());
        expect(answer.status).toBe(200);
    });

    it("puts what the answer spent on it and in the ledger", async () => {
        const answer = await post(body());
        const text = await answer.text();
        expect(text).toMatch(/"usage":\{"inputTokens":\d+,"outputTokens":\d+/);
        // An earlier test's answer, never read, still finishes on its own and
        // records too: this one is found by its id.
        const id = /"type":"start"[^\n]*?"messageId":"([^"]+)"/.exec(text)?.[1];
        const mine = () =>
            state.recorded.filter((entry) => (entry as { messageId?: string }).messageId === id);
        await vi.waitFor(() => expect(mine()).toHaveLength(1));
        expect(mine()[0]).toMatchObject({ payer: "own", threadId: THREAD });
    });

    it("streams an answer and saves the turn", async () => {
        const answer = await post(body());
        expect(answer.status).toBe(200);
        const text = await answer.text();
        expect(text).toContain("Done.");
        // How long the turn worked, for the line its steps fold into.
        expect(text).toMatch(/"workedMs":\d+/);
        expect(state.saved).toHaveLength(1);
    });

    it("saves the answer under the id the screen is told, so a reload finds it", async () => {
        const text = await (await post(body())).text();
        const start = /"type":"start"[^\n]*?"messageId":"([^"]+)"/.exec(text);
        expect(start?.[1]).toBeTruthy();
        const [, , finished] = state.saved[0] as [string, string, UIMessage[]];
        const answer = finished.at(-1);
        expect(answer?.role).toBe("assistant");
        expect(answer?.id).toBe(start?.[1]);
    });

    it("gives every answer an id of its own", async () => {
        await (await post(body())).text();
        await (await post(body())).text();
        const ids = state.saved.map(
            (entry) => (entry as [string, string, UIMessage[]])[2].at(-1)?.id
        );
        expect(ids[0]).not.toBe(ids[1]);
    });

    it("keeps the answer's id when a turn continues it", async () => {
        const text = await (
            await post(
                body({
                    messages: [
                        {
                            id: "u1",
                            role: "user",
                            parts: [{ type: "text", text: "Tidy my tasks" }]
                        },
                        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Sure." }] }
                    ]
                })
            )
        ).text();
        expect(text).toContain('"messageId":"a1"');
        const [, , finished] = state.saved[0] as [string, string, UIMessage[]];
        expect(finished.map((message) => message.id)).toEqual(["u1", "a1"]);
    });

    it("asks for the thread's title once the reply has finished, not before", async () => {
        const answer = await post(body());
        expect(state.titled).toHaveLength(0);
        expect(await answer.text()).toContain("Done.");
        expect(state.titled).toHaveLength(1);
        const [userId, threadId, , finished] = state.titled[0] as [
            string,
            string,
            unknown,
            UIMessage[]
        ];
        expect([userId, threadId]).toEqual([USER.id, THREAD]);
        expect(finished.map((message) => message.role)).toEqual(["user", "assistant"]);
        const chosen = (await (state.titled[0]![2] as Promise<{ model: unknown }>)) ?? null;
        expect(chosen?.model).toBeTruthy();
    });

    it("names the thread on the chat's own model once the shared key's ceiling is reached", async () => {
        state.helperSource = "instance";
        state.hit = { used: 10, amount: 10, period: "month" };
        await (await post(body())).text();
        const chosen = await (state.titled[0]![2] as Promise<{ model: unknown }>);
        expect(chosen.model).toBe(state.models[0]);
    });

    it("names the thread on the helper model while the shared key has room", async () => {
        state.helperSource = "instance";
        await (await post(body())).text();
        const chosen = await (state.titled[0]![2] as Promise<{ model: unknown }>);
        expect(state.models.length).toBeGreaterThan(1);
        expect(chosen.model).not.toBe(state.models[0]);
    });

    it("starts a suggested next message on the helper model after the reply", async () => {
        await (await post(body())).text();
        expect(state.suggested).toHaveLength(1);
        const [userId, threadId, finished, helper] = state.suggested[0] as [
            string,
            string,
            UIMessage[],
            Promise<{ source: string } | null>
        ];
        expect([userId, threadId]).toEqual([USER.id, THREAD]);
        expect(finished.at(-1)?.role).toBe("assistant");
        expect((await helper)?.source).toBe("automatic");
    });

    it("gives the suggestion no model when the person switched suggestions off", async () => {
        state.suggestions = false;
        await (await post(body())).text();
        const helper = state.suggested[0]![3] as Promise<unknown>;
        expect(await helper).toBeNull();
    });
});

describe("tools", () => {
    it("runs a read tool without asking", async () => {
        state.parts = calls("read_tasks", {});
        const text = await (await post(body())).text();
        expect(state.executed).toEqual(["read_tasks"]);
        expect(text).not.toContain("tool-approval-request");
        expect(text).toContain("Here you go.");
    });

    it("stops a write tool at an approval and does not run it", async () => {
        state.parts = calls("delete_task", { id: "ENG-1" });
        const text = await (await post(body())).text();
        expect(text).toContain("tool-approval-request");
        expect(state.executed).toEqual([]);
    });
});

describe("Polar on the web", () => {
    /** The tool names the model was offered on the first step of the turn. */
    async function offered(payload: Record<string, unknown>): Promise<string[]> {
        await (await post(payload)).text();
        const call = state.models[0]?.doStreamCalls[0];
        return (call?.tools ?? []).map((entry) => entry.name).sort();
    }

    it("offers the provider's own search and the page reader when the web is allowed", async () => {
        const names = await offered(body());
        expect(names).toContain("web_search");
        expect(names).toContain("read_page");
        const search = state.models[0]!.doStreamCalls[0]!.tools!.find(
            (entry) => entry.name === "web_search"
        );
        expect(search?.type).toBe("provider");
    });

    it("offers the provider's own search on a turn Automatic routed to that provider", async () => {
        const names = await offered(
            body({
                choice: {
                    kind: "language",
                    provider: "auto",
                    model: "auto",
                    intelligence: "balanced",
                    payer: null
                }
            })
        );
        expect(names).toContain("web_search");
        expect(names).not.toContain("search_web");
    });

    it("offers no web tool once an administrator turns the web off", async () => {
        state.web = false;
        const names = await offered(body());
        expect(names).not.toContain("web_search");
        expect(names).not.toContain("read_page");
        expect(names).not.toContain("search_web");
        expect(names).toContain("read_tasks");
    });

    it("offers no web tool for a turn the person switched it off for", async () => {
        const names = await offered(body({ web: false }));
        expect(names.filter((name) => /web|page/.test(name))).toEqual([]);
    });

    const REPO_TOOLS = [
        "repo_commits",
        "repo_list_files",
        "repo_overview",
        "repo_read_file",
        "repo_search"
    ];

    it("offers the repository tools when the page shared is a repository", async () => {
        const names = await offered(
            body({
                context: {
                    route: "/",
                    site: { url: "https://github.com/acme/backend/tree/master", title: "backend" }
                }
            })
        );
        expect(names).toEqual(expect.arrayContaining(REPO_TOOLS));
    });

    it("offers the repository tools when the person wrote a repository's address", async () => {
        const names = await offered(
            body({
                messages: [
                    {
                        id: "u1",
                        role: "user",
                        parts: [
                            { type: "text", text: "Which PHP does https://gitlab.com/g/s/p use?" }
                        ]
                    }
                ]
            })
        );
        expect(names).toEqual(expect.arrayContaining(REPO_TOOLS));
    });

    it("does not send the repository tools on a turn about no repository", async () => {
        const names = await offered(
            body({
                context: { route: "/", site: { url: "https://example.com/post", title: "Post" } }
            })
        );
        expect(names.filter((name) => name.startsWith("repo_"))).toEqual([]);
    });

    it("does not offer the repository tools with the web switched off", async () => {
        const names = await offered(
            body({
                web: false,
                context: { route: "/", site: { url: "https://github.com/a/b", title: "b" } }
            })
        );
        expect(names.filter((name) => name.startsWith("repo_"))).toEqual([]);
    });

    it("does not offer a tool the person switched off in Polar's settings", async () => {
        const names = await offered(body({ off: ["read_tasks"] }));
        expect(names).not.toContain("read_tasks");
        expect(names).toContain("delete_task");
    });

    it("offers none of Polaris's tools while its server is switched off, whatever each one says", async () => {
        const names = await offered(body({ serversOff: ["polaris"] }));
        expect(names).not.toContain("read_tasks");
        expect(names).not.toContain("delete_task");
        // Web search is its own switch, not one of Polaris's tools.
        expect(names.some((name) => /web/.test(name))).toBe(true);
    });

    it("reads the record on screen through its reader", async () => {
        state.parts = calls("read_current_view", {});
        const text = await (
            await post(
                body({ context: { route: "/tasks/T-1", record: { kind: "task", id: "T-1" } } })
            )
        ).text();
        expect(state.executed).toEqual(["tasks_get"]);
        expect(text).toContain("write the report");
    });

    it("does not read the record on screen through a tool switched off", async () => {
        state.parts = calls("read_current_view", {});
        const text = await (
            await post(
                body({
                    context: { route: "/tasks/T-1", record: { kind: "task", id: "T-1" } },
                    off: ["tasks_get"]
                })
            )
        ).text();
        expect(state.executed).toEqual([]);
        expect(text).not.toContain("write the report");
    });

    it("still reads an older turn that searched, whatever this turn may use", async () => {
        state.web = false;
        const response = await post(
            body({
                messages: [
                    { id: "u0", role: "user", parts: [{ type: "text", text: "Look it up" }] },
                    {
                        id: "a0",
                        role: "assistant",
                        parts: [
                            {
                                type: "tool-web_search",
                                toolCallId: "s1",
                                state: "output-available",
                                providerExecuted: true,
                                input: { query: "polaris" },
                                output: []
                            },
                            {
                                type: "tool-read_page",
                                toolCallId: "r1",
                                state: "output-available",
                                input: { url: "https://example.com/" },
                                output: { ok: true, url: "https://example.com/", title: "E" }
                            },
                            { type: "text", text: "Found it." }
                        ]
                    },
                    { id: "u1", role: "user", parts: [{ type: "text", text: "Thanks" }] }
                ]
            })
        );
        expect(response.status).toBe(200);
        await response.text();
    });
});

describe("answers that outlive their screen", () => {
    it("finishes and saves an answer nobody read, and keeps the question first", async () => {
        const answer = await post(body());
        expect(answer.status).toBe(200);
        // The screen went elsewhere: the body is never read.
        expect(state.asked).toHaveLength(1);
        await vi.waitFor(() => expect(state.saved).toHaveLength(1));
        expect(savedTurn().at(-1)?.role).toBe("assistant");
    });

    it("refuses a second answer on a thread that is still answering", async () => {
        const first = await post(body());
        const second = await post(body());
        expect(second.status).toBe(409);
        await first.text();
    });

    it("replays the running answer to a chat opened again, and 204 once it is done", async () => {
        const stream = await import("@/app/api/polar/chat/[id]/stream/route");
        const params = { params: Promise.resolve({ id: THREAD }) };
        const first = await post(body());
        const replay = await stream.GET(new Request("https://polaris.test/x"), params);
        expect(replay.status).toBe(200);
        const [live, replayed] = await Promise.all([first.text(), replay.text()]);
        expect(replayed).toContain("Done.");
        expect(replayed).toContain(/"messageId":"([^"]+)"/.exec(live)?.[1]);
        await vi.waitFor(async () =>
            expect((await stream.GET(new Request("https://polaris.test/x"), params)).status).toBe(
                204
            )
        );
    });
});

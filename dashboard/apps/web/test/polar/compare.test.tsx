// @vitest-environment jsdom
/**
 * "Ask several": the models a comparison starts with, the room it checks for
 * before sending, the column edges, and the columns themselves - each one its
 * own chat, so one failing leaves the others answering.
 *
 * `useChat` is replaced by a store keyed by id; everything else is real.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Message = { id: string; role: string; parts: Array<{ type: string; text?: string; data?: unknown }> };
type Chat = { messages: Message[]; error?: Error; status?: string };

const chats = new Map<string, Chat>();
const sent: Array<{ id: string; text: string }> = [];
const transports = new Map<string, ChatTransport<UIMessage>>();

vi.mock("@ai-sdk/react", () => ({
    useChat: (options: { id: string; messages?: Message[]; transport: ChatTransport<UIMessage> }) => {
        transports.set(options.id, options.transport);
        const chat = chats.get(options.id) ?? { messages: options.messages ?? [] };
        return {
            id: options.id,
            status: chat.status ?? "ready",
            messages: chat.messages,
            error: chat.error,
            sendMessage: async (message: { text: string }) => {
                sent.push({ id: options.id, text: message.text });
            },
            stop: async () => undefined,
            regenerate: async () => undefined
        };
    }
}));

import type { ChatTransport, UIMessage } from "ai";
import type { ModelChoice } from "@/lib/polar/shared";
import * as compare from "@/components/polar/polar-compare";

const PROVIDERS = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: [],
        models: [
            { provider: "anthropic", model: "m-1", name: "Model One", reasoning: false },
            { provider: "anthropic", model: "m-2", name: "Model Two", reasoning: false }
        ]
    },
    {
        provider: "openai",
        name: "OpenAI",
        payers: [],
        models: [{ provider: "openai", model: "m-3", name: "Model Three", reasoning: false }]
    }
];

function choice(provider: string, model: string): ModelChoice {
    return { kind: "language", provider, model, intelligence: "balanced", payer: null };
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
    chats.clear();
    transports.clear();
    sent.length = 0;
    window.sessionStorage.clear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("choosing the models", () => {
    it("starts from the chosen model and adds the next ones not picked", () => {
        const seeded = compare.seedChoices(choice("anthropic", "m-2"), PROVIDERS);
        expect(seeded.map((one) => one.model)).toEqual(["m-2", "m-1"]);
        expect(compare.nextChoice(seeded, PROVIDERS)?.model).toBe("m-3");
        expect(compare.nextChoice([...seeded, choice("openai", "m-3")], PROVIDERS)).toBeNull();
    });

    it("seeds fewer when fewer models exist, and none without a choice or models", () => {
        expect(compare.seedChoices(null, [])).toEqual([]);
        expect(compare.seedChoices(null, PROVIDERS, 4)).toHaveLength(3);
    });

    it("notices a model picked twice", () => {
        expect(compare.hasRepeats([choice("a", "x"), choice("a", "y")])).toBe(false);
        expect(compare.hasRepeats([choice("a", "x"), choice("b", "y"), choice("a", "x")])).toBe(
            true
        );
    });
});

describe("room for the answers", () => {
    it("counts only the answers running against the cap", () => {
        const runs = [
            { threadId: "a", state: "running", unread: false, startedAt: 1 },
            { threadId: "b", state: "running", unread: false, startedAt: 2 },
            { threadId: "c", state: "approval", unread: false, startedAt: 3 },
            { threadId: "d", state: "done", unread: true, startedAt: 4 }
        ];
        expect(compare.roomFrom({ runs, max: 6 })).toEqual({ room: 4, max: 6 });
        expect(compare.roomFrom({ runs: [...runs, ...runs.map((run) => ({ ...run, threadId: `${run.threadId}2` }))], max: 3 })).toEqual({ room: 0, max: 3 });
    });

    it("says nothing when the server did not say its cap", () => {
        expect(compare.roomFrom(null)).toBeNull();
        expect(compare.roomFrom({ runs: [] })).toBeNull();
    });
});

describe("column edges", () => {
    it("moves the edge between two columns and keeps both above the minimum", () => {
        expect(compare.resized([50, 50], 0, 10)).toEqual([60, 40]);
        expect(compare.resized([50, 50], 0, 80)).toEqual([85, 15]);
        expect(compare.resized([25, 25, 25, 25], 2, -20)).toEqual([25, 25, 15, 35]);
        expect(compare.resized([50, 50], 1, 10)).toEqual([50, 50]);
    });
});

describe("the dialog", () => {
    it("refuses cleanly when not enough answers may start", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    runs: [1, 2, 3, 4, 5].map((n) => ({
                        threadId: `t${n}`,
                        state: "running",
                        unread: false,
                        startedAt: n
                    })),
                    max: 6
                })
            )
        );
        const onStart = vi.fn();
        render(
            <compare.AskSeveral
                providers={PROVIDERS}
                choice={choice("anthropic", "m-1")}
                question="Which is faster?"
                hasFiles={false}
                onStart={onStart}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Ask several models" }));
        fireEvent.click(await screen.findByRole("button", { name: "Send to all" }));
        expect(await screen.findByText(/Only 1 more chats can answer right now/)).toBeTruthy();
        expect(onStart).not.toHaveBeenCalled();
    });

    it("starts with the picked models when there is room", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ runs: [], max: 6 })));
        const onStart = vi.fn();
        render(
            <compare.AskSeveral
                providers={PROVIDERS}
                choice={choice("anthropic", "m-1")}
                question="Which is faster?"
                hasFiles={false}
                onStart={onStart}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Ask several models" }));
        fireEvent.click(await screen.findByRole("button", { name: "Add a model" }));
        fireEvent.click(screen.getByRole("button", { name: "Send to all" }));
        await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
        expect(onStart.mock.calls[0]![0].map((one: ModelChoice) => one.model)).toEqual([
            "m-1",
            "m-2",
            "m-3"
        ]);
    });

    it("cannot send without a question, or with files", async () => {
        const { rerender } = render(
            <compare.AskSeveral
                providers={PROVIDERS}
                choice={choice("anthropic", "m-1")}
                question="  "
                hasFiles={false}
                onStart={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Ask several models" }));
        const send = await screen.findByRole("button", { name: "Send to all" });
        expect((send as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText("Write the question first.")).toBeTruthy();
        rerender(
            <compare.AskSeveral
                providers={PROVIDERS}
                choice={choice("anthropic", "m-1")}
                question="Hi"
                hasFiles
                onStart={() => undefined}
            />
        );
        expect(screen.getByText(/Files go to one model at a time/)).toBeTruthy();
    });

    it("is not offered with fewer than two models", () => {
        render(
            <compare.AskSeveral
                providers={[{ ...PROVIDERS[1]! }]}
                choice={choice("openai", "m-3")}
                question="Hi"
                hasFiles={false}
                onStart={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("button", { name: "Ask several models" })).toBeNull();
    });
});

describe("the columns", () => {
    it("asks each model once, and a failed column leaves the other answering", async () => {
        chats.set(T1, {
            messages: [
                { id: "u", role: "user", parts: [{ type: "text", text: "Which is faster?" }] },
                { id: "a", role: "assistant", parts: [{ type: "text", text: "The first one." }] }
            ]
        });
        chats.set(T2, {
            messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "Which is faster?" }] }],
            error: new Error("network")
        });
        let comparison: compare.PolarComparison | null = {
            question: "Which is faster?",
            columns: [
                { threadId: T1, choice: choice("anthropic", "m-1"), sent: false },
                { threadId: T2, choice: choice("openai", "m-3"), sent: false }
            ]
        };
        const onChange = (next: compare.ComparisonUpdate) => {
            comparison = typeof next === "function" ? next(comparison) : next;
        };
        const onContinue = vi.fn();
        render(
            <compare.PolarCompare
                comparison={comparison!}
                onChange={onChange}
                providers={PROVIDERS}
                isAdmin={false}
                settings={{ web: false, toolNames: [] }}
                onContinue={onContinue}
                onClose={() => undefined}
                onSettled={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(sent.map((one) => one.id).sort()).toEqual([T1, T2]);
        expect(sent.every((one) => one.text === "Which is faster?")).toBe(true);
        // Only the column the server answered is marked sent; the failed one
        // is asked again after a reload.
        expect(comparison!.columns.map((column) => column.sent)).toEqual([true, false]);

        expect(screen.getByText("The first one.")).toBeTruthy();
        expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
        const continues = screen.getAllByRole("button", { name: "Continue with this one" });
        expect(continues).toHaveLength(2);
        fireEvent.click(continues[0]!);
        expect(onContinue).toHaveBeenCalledWith(T1);
        // Model names label the tabs a phone switches between.
        expect(screen.getByRole("tab", { name: "Model Three" })).toBeTruthy();
    });

    it("reopens a column already sent from its stored thread, without asking again", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    thread: {
                        messages: [
                            { id: "u", parentId: null, role: "user", parts: [{ type: "text", text: "Q" }] },
                            { id: "a", parentId: "u", role: "assistant", parts: [{ type: "text", text: "Stored answer." }] }
                        ]
                    }
                })
            )
        );
        render(
            <compare.PolarCompare
                comparison={{
                    question: "Q",
                    columns: [
                        { threadId: T1, choice: choice("anthropic", "m-1"), sent: true },
                        { threadId: T2, choice: choice("anthropic", "m-2"), sent: true }
                    ]
                }}
                onChange={() => undefined}
                providers={PROVIDERS}
                isAdmin={false}
                settings={{ web: false, toolNames: [] }}
                onContinue={() => undefined}
                onClose={() => undefined}
                onSettled={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(await screen.findAllByText("Stored answer.")).toHaveLength(2);
        expect(sent).toHaveLength(0);
    });

    it("asks again a column marked sent whose thread the server never stored", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "not_found" }, { status: 404 })));
        render(
            <compare.PolarCompare
                comparison={{
                    question: "Q",
                    columns: [{ threadId: T1, choice: choice("anthropic", "m-1"), sent: true }]
                }}
                onChange={() => undefined}
                providers={PROVIDERS}
                isAdmin={false}
                settings={{ web: false, toolNames: [] }}
                onContinue={() => undefined}
                onClose={() => undefined}
                onSettled={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        await waitFor(() => expect(sent).toEqual([{ id: T1, text: "Q" }]));
    });

    it("posts each turn with every Polaris tool and the connectors off", async () => {
        render(
            <compare.PolarCompare
                comparison={{
                    question: "Q",
                    columns: [{ threadId: T1, choice: choice("anthropic", "m-1"), sent: false }]
                }}
                onChange={() => undefined}
                providers={PROVIDERS}
                isAdmin={false}
                settings={{ web: true, toolNames: ["tasks_create", "connector_github_issue"] }}
                onContinue={() => undefined}
                onClose={() => undefined}
                onSettled={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        await waitFor(() => expect(transports.has(T1)).toBe(true));
        const posted = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 500 }));
        vi.stubGlobal("fetch", posted);
        await transports
            .get(T1)!
            .sendMessages({
                chatId: T1,
                trigger: "submit-message",
                messageId: undefined,
                abortSignal: undefined,
                messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "Q" }] }]
            })
            .catch(() => undefined);
        expect(posted).toHaveBeenCalledTimes(1);
        const [url, init] = posted.mock.calls[0]!;
        expect(url).toBe("/api/polar/chat");
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
            threadId: T1,
            choice: choice("anthropic", "m-1"),
            web: true,
            off: ["tasks_create", "connector_github_issue"],
            connectors: false,
            temporary: false,
            projectId: null
        });
    });
});

describe("the stored comparison", () => {
    const stored = {
        question: "Q",
        columns: [{ threadId: T1, choice: choice("anthropic", "m-1"), sent: true }]
    };

    function Probe({ kept, clear }: { kept: boolean; clear?: boolean }) {
        const [comparison, setComparison] = compare.useComparison(kept);
        return (
            <button type="button" onClick={() => clear && setComparison(null)}>
                {comparison ? "open" : "none"}
            </button>
        );
    }

    it("is restored only where a comparison can be started", async () => {
        window.sessionStorage.setItem("polar.compare", JSON.stringify(stored));
        render(<Probe kept />);
        expect(await screen.findByText("open")).toBeTruthy();
        cleanup();
        render(<Probe kept={false} clear />);
        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByText("none")).toBeTruthy();
        // The side panel neither shows it nor clears it for the full page.
        expect(window.sessionStorage.getItem("polar.compare")).not.toBeNull();
    });
});

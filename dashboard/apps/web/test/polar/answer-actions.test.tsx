// @vitest-environment jsdom
/**
 * What an answer's row offers: one rate menu of good and bad (a bad one asking
 * what was wrong, a refused save put back), reading it aloud only with a voice
 * to read it in, sharing the chat up to that answer, and answering again as it
 * was, with more detail, or on another model for that turn only.
 *
 * `useChat` is replaced by a store the test drives, and the transport's
 * request builder is caught so what a turn would send can be read.
 */

import type { ReactNode } from "react";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const chat = {
    messages: [] as Array<{
        id: string;
        role: string;
        parts: Array<{ type: string; text?: string }>;
    }>,
    regenerated: 0
};

type Prepare = (input: { messages: unknown[] }) => { body: Record<string, unknown> };
let prepare: Prepare | null = null;

vi.mock("ai", async (original) => ({
    ...(await original<typeof import("ai")>()),
    DefaultChatTransport: class {
        constructor(options: { prepareSendMessagesRequest: Prepare }) {
            prepare = options.prepareSendMessagesRequest;
        }
    }
}));
vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: "ready",
        messages: chat.messages,
        error: undefined,
        sendMessage: async () => undefined,
        stop: async () => undefined,
        setMessages: () => undefined,
        regenerate: async () => void chat.regenerated++,
        addToolApprovalResponse: async () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/tasks",
    useRouter: () => ({ push: () => undefined })
}));

const PROVIDERS = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: ["own"],
        models: [
            { provider: "anthropic", model: "m-1", name: "Model One", reasoning: true },
            { provider: "anthropic", model: "m-2", name: "Model Two", reasoning: false }
        ]
    }
];

const calls: Array<{ url: string; method: string; body: unknown }> = [];
const state = { speech: false, refuseMark: false, marks: {} as Record<string, unknown> };

class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onpause: (() => void) | null = null;
    async play() {
        queueMicrotask(() => this.onended?.());
    }
    pause() {
        this.onpause?.();
    }
}

beforeEach(() => {
    chat.messages = [
        { id: "q1", role: "user", parts: [{ type: "text", text: "Disk?" }] },
        {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: "It is half full. Clean the cache." }]
        }
    ];
    chat.regenerated = 0;
    calls.length = 0;
    state.speech = false;
    state.refuseMark = false;
    state.marks = {};
    try {
        window.localStorage.clear();
    } catch {
        // No storage in this environment.
    }
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => undefined;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            calls.push({
                url,
                method,
                body: typeof init?.body === "string" ? JSON.parse(init.body) : null
            });
            if (url === "/api/polar/models") {
                return Response.json({
                    providers: PROVIDERS,
                    tools: {},
                    isAdmin: false,
                    voice: { dictation: false, speech: state.speech }
                });
            }
            if (url.startsWith("/api/polar/feedback?"))
                return Response.json({ marks: state.marks });
            if (url === "/api/polar/feedback") {
                return state.refuseMark
                    ? Response.json({ error: "x" }, { status: 500 })
                    : Response.json({ mark: {} });
            }
            if (url === "/api/polar/speak") return new Response("a");
            if (url.endsWith("/share") && method === "GET") return Response.json({ link: null });
            if (url.endsWith("/share") && method === "POST") {
                return Response.json({
                    link: {
                        url: "https://polaris.example/c/tok",
                        sharedAt: new Date().toISOString(),
                        views: 0,
                        hasPassword: false,
                        expiresAt: null,
                        maxViews: null,
                        allowedCidrs: [],
                        allowedCountries: [],
                        allowedContinents: []
                    }
                });
            }
            if (url.endsWith("/share/people")) return Response.json({ people: [] });
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <MessagesWrapper>
            <ToastProvider>{children}</ToastProvider>
        </MessagesWrapper>
    );
}

async function mount() {
    render(<PolarChat />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Model One", { exact: false })).toBeTruthy());
}

const puts = () =>
    calls.filter((call) => call.url === "/api/polar/feedback" && call.method === "PUT");

/** Opens the one "Rate response" menu under the answer. */
async function openRating() {
    const trigger = screen.getByLabelText("Rate response");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await screen.findByRole("menu");
}

describe("rate response", () => {
    it("is one button whose menu offers a good and a bad response", async () => {
        await mount();
        expect(screen.queryByLabelText("Good response")).toBeNull();
        expect(screen.queryByLabelText("Bad response")).toBeNull();
        await openRating();
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
            "Good response",
            "Bad response"
        ]);
    });

    it("marks an answer good at once, shows it, and clears it from the menu", async () => {
        await mount();
        await openRating();
        fireEvent.click(screen.getByRole("menuitem", { name: "Good response" }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0]?.body).toEqual({
            messageId: "a1",
            rating: "good",
            reasons: [],
            note: null
        });
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
        const trigger = screen.getByLabelText("Rate response");
        expect(trigger.querySelector(".lucide-thumbs-up.fill-current")).toBeTruthy();
        await openRating();
        fireEvent.click(screen.getByRole("menuitem", { name: "Clear rating" }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(puts()[1]?.body).toEqual({ messageId: "a1", rating: null });
    });

    it("asks what was wrong after a bad mark and sends the reasons and note", async () => {
        await mount();
        await openRating();
        fireEvent.click(screen.getByRole("menuitem", { name: "Bad response" }));
        expect(await screen.findByText("What went wrong?")).toBeTruthy();
        const send = screen.getByRole("button", { name: "Send" });
        expect(send.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Not correct" }));
        fireEvent.change(screen.getByLabelText("Details"), { target: { value: " Wrong year " } });
        fireEvent.click(send);
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(puts()[1]?.body).toEqual({
            messageId: "a1",
            rating: "bad",
            reasons: ["incorrect"],
            note: "Wrong year"
        });
        await waitFor(() => expect(screen.queryByText("What went wrong?")).toBeNull());
    });

    it("puts the mark back and says so when the save is refused", async () => {
        state.refuseMark = true;
        await mount();
        await openRating();
        fireEvent.click(screen.getByRole("menuitem", { name: "Good response" }));
        expect(await screen.findByText("Couldn't save your rating. Try again.")).toBeTruthy();
        const trigger = screen.getByLabelText("Rate response");
        expect(trigger.querySelector(".lucide-thumbs-up")).toBeNull();
    });

    it("shows the marks already given when the chat opens", async () => {
        state.marks = { a1: { rating: "bad", reasons: [], note: null } };
        await mount();
        await waitFor(() =>
            expect(
                screen
                    .getByLabelText("Rate response")
                    .querySelector(".lucide-thumbs-down.fill-current")
            ).toBeTruthy()
        );
    });
});

describe("read aloud", () => {
    it("is not offered without a voice to read with", async () => {
        await mount();
        expect(screen.queryByLabelText("Read aloud")).toBeNull();
    });

    it("says the answer sentence by sentence, then is ready again", async () => {
        state.speech = true;
        await mount();
        fireEvent.click(await screen.findByLabelText("Read aloud"));
        await waitFor(() =>
            expect(calls.filter((call) => call.url === "/api/polar/speak")).toHaveLength(2)
        );
        expect(
            calls.filter((call) => call.url === "/api/polar/speak").map((call) => call.body)
        ).toEqual([
            { text: "It is half full.", payer: null, lang: expect.any(String) },
            { text: "Clean the cache.", payer: null, lang: expect.any(String) }
        ]);
        expect(await screen.findByLabelText("Read aloud")).toBeTruthy();
    });

    it("reads the words and leaves out the views the answer drew", async () => {
        state.speech = true;
        chat.messages[1] = {
            id: "a1",
            role: "assistant",
            parts: [
                { type: "text", text: "It is half full." },
                {
                    type: "tool-polar_show",
                    toolCallId: "v1",
                    state: "output-available",
                    input: {
                        view: { kind: "table", columns: [{ label: "Disk" }], rows: [["sda"]] }
                    },
                    output: { ok: true, text: "Shown to the person." }
                } as never
            ]
        };
        await mount();
        fireEvent.click(await screen.findByLabelText("Read aloud"));
        await waitFor(() =>
            expect(calls.filter((call) => call.url === "/api/polar/speak")).toHaveLength(1)
        );
        expect(calls.find((call) => call.url === "/api/polar/speak")?.body).toEqual({
            text: "It is half full.",
            payer: null,
            lang: expect.any(String)
        });
    });
});

describe("share up to here", () => {
    it("opens the share dialog for this answer and makes the link up to it", async () => {
        await mount();
        fireEvent.click(screen.getByLabelText("Share up to here"));
        expect(
            await screen.findByText(
                "Anyone with the link can read this conversation up to this answer.",
                { exact: false }
            )
        ).toBeTruthy();
        fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
        await waitFor(() =>
            expect(
                calls.find((call) => call.url.endsWith("/share") && call.method === "POST")?.body
            ).toEqual({ upTo: "a1" })
        );
    });
});

describe("answer again", () => {
    async function pick(name: string) {
        const trigger = screen.getByLabelText("Answer again");
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        fireEvent.click(await screen.findByRole("menuitem", { name }));
    }

    it("asks for more detail on that turn only", async () => {
        await mount();
        await pick("Add details");
        expect(chat.regenerated).toBe(1);
        expect(prepare?.({ messages: chat.messages }).body.refine).toBe("longer");
        expect(prepare?.({ messages: chat.messages }).body.refine).toBeNull();
    });

    it("answers on another model without moving the chat to it", async () => {
        await mount();
        const trigger = screen.getByLabelText("Answer again");
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        const sub = await screen.findByRole("menuitem", { name: "Try another model" });
        fireEvent.keyDown(sub, { key: "ArrowRight" });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Model Two" }));
        await act(async () => undefined);
        expect(chat.regenerated).toBe(1);
        const body = prepare?.({ messages: chat.messages }).body;
        expect(body?.choice).toMatchObject({ provider: "anthropic", model: "m-2" });
        expect(body?.remember).toBe(false);
    });
});

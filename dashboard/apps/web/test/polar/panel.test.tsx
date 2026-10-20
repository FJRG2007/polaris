// @vitest-environment jsdom
/**
 * Polar's chat as somebody uses it: what the empty panel offers, what it says
 * with no key, and the queue of messages typed while a turn is still running -
 * kept in order, editable, removable, saved with the thread so a reload brings
 * it back, and sent one by one once the turn ends.
 *
 * `useChat` is replaced by a store the test drives; everything else is real.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const chat = {
    status: "ready" as "ready" | "submitted" | "streaming" | "error",
    messages: [] as Array<{
        id: string;
        role: string;
        parts: Array<{ type: string; text?: string }>;
    }>,
    sent: [] as Array<{ text?: string }>,
    stopped: 0,
    rerender: () => undefined as void
};

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: chat.status,
        messages: chat.messages,
        error: undefined,
        // As the SDK does: a send marks the turn submitted before it awaits anything.
        sendMessage: async (message: { text?: string }) => {
            chat.sent.push(message);
            chat.status = "submitted";
        },
        stop: async () => void chat.stopped++,
        setMessages: (next: typeof chat.messages) => {
            chat.messages = next;
        },
        regenerate: async () => undefined,
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
        models: [{ provider: "anthropic", model: "m-1", name: "Model One", reasoning: true }]
    }
];

let providers: unknown[] = PROVIDERS;
const patches: unknown[] = [];
let storedThread: unknown = null;
let ownCommands: unknown[] = [];

beforeEach(() => {
    chat.status = "ready";
    chat.messages = [];
    chat.sent = [];
    chat.stopped = 0;
    providers = PROVIDERS;
    patches.length = 0;
    storedThread = null;
    ownCommands = [];
    try {
        window.localStorage.clear();
        window.sessionStorage.clear();
    } catch {
        // No storage in this environment.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url === "/api/polar/models") {
                return Response.json({ providers, tools: {}, isAdmin: false });
            }
            if (url === "/api/polar/commands") return Response.json({ commands: ownCommands });
            if (url === "/api/polar/threads") {
                return Response.json({
                    threads: [{ id: "t-old", title: "Old chat", updatedAt: "2026-10-19T00:00:00Z" }]
                });
            }
            if (url.startsWith("/api/polar/threads/") && init?.method === "PATCH") {
                patches.push(JSON.parse(String(init.body)));
                return Response.json({ ok: true });
            }
            if (url === "/api/polar/threads/t-old") return Response.json({ thread: storedThread });
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarAside, PolarChat, PolarProvider, ownCommandIn, slashMatches } =
    await import("@/components/polar/polar-panel");

function mount() {
    const view = render(<PolarChat />, { wrapper: MessagesWrapper });
    return { ...view, again: () => view.rerender(<PolarChat />) };
}

async function type(text: string) {
    const box = screen.getByLabelText("Message Polar");
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
}

async function ready() {
    // The model list arrives before anything can be sent.
    await waitFor(() => expect(screen.getByText("Model One", { exact: false })).toBeTruthy());
}

describe("the side panel", () => {
    it("lets the chat fill the panel's height, so the composer sits at the bottom", async () => {
        render(
            <PolarProvider>
                <PolarAside />
            </PolarProvider>,
            { wrapper: MessagesWrapper }
        );
        fireEvent.keyDown(window, { key: "j", ctrlKey: true });
        const aside = await screen.findByRole("complementary");
        const column = aside.lastElementChild as HTMLElement;
        // The column sets its own width from xl; flex-none there would also stop it growing tall.
        expect(column.className).toContain("flex-1");
        expect(column.className).not.toMatch(/(^|\s)\S*:?flex-none(\s|$)/);
    });
});

describe("an empty panel", () => {
    it("offers suggestions, shows the page it sees, and a composer", async () => {
        mount();
        await ready();
        expect(screen.getByText("What's on this page?")).toBeTruthy();
        expect(screen.getByTitle(/Polar sees this page/)).toBeTruthy();
        expect(screen.getByLabelText("Message Polar")).toBeTruthy();
    });

    it("says in plain words that it needs a key, with the way to add one", async () => {
        providers = [];
        mount();
        await waitFor(() =>
            expect(screen.getByText("Polar needs an AI provider key")).toBeTruthy()
        );
        const link = screen.getByText("Add your own key").closest("a");
        expect(link?.getAttribute("href")).toBe("/account/ai-keys");
        expect(screen.queryByText("Manage this Polaris's keys")).toBeNull();
    });

    it("sends a message when the turn is free", async () => {
        mount();
        await ready();
        await type("Hello");
        expect(chat.sent.map((message) => message.text)).toEqual(["Hello"]);
    });
});

describe("the / commands", () => {
    const options = () => screen.queryAllByRole("option").map((option) => option.textContent);
    const highlighted = () =>
        screen
            .getAllByRole("option")
            .find((option) => option.getAttribute("aria-selected") === "true")?.textContent;
    const slash = (text: string) =>
        fireEvent.change(screen.getByLabelText("Message Polar"), { target: { value: text } });

    it("opens on a slash with the first command highlighted, and narrows as you type", async () => {
        mount();
        await ready();
        slash("/");
        // Polar's six, the ten that act on the chat, then the entry that
        // writes a new one.
        expect(options()).toHaveLength(17);
        expect(options()[16]).toMatch(/^New command/);
        expect(highlighted()).toMatch(/^\/new/);
        const box = screen.getByLabelText("Message Polar");
        expect(box.getAttribute("aria-activedescendant")).toBe(
            screen.getAllByRole("option")[0]!.id
        );
        slash("/mo");
        expect(options()).toHaveLength(3);
        expect(options()[0]).toMatch(/^\/model/);
        slash("/model now");
        expect(screen.queryByRole("listbox")).toBeNull();
        slash("");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("walks the commands with the arrows, skips the ones not ready, and runs one on Enter", async () => {
        mount();
        await ready();
        slash("/");
        const box = screen.getByLabelText("Message Polar");
        fireEvent.keyDown(box, { key: "ArrowUp" });
        // Up from the first wraps to the last row, the new command entry.
        expect(highlighted()).toMatch(/^New command/);
        fireEvent.keyDown(box, { key: "ArrowDown" });
        expect(highlighted()).toMatch(/^\/new/);
        for (let step = 0; step < 4; step++) fireEvent.keyDown(box, { key: "ArrowDown" });
        expect(highlighted()).toMatch(/^\/tools/);
        // "/call" is not ready yet, so down from "/tools" skips it.
        fireEvent.keyDown(box, { key: "ArrowDown" });
        expect(highlighted()).toMatch(/^\/clear/);
        fireEvent.keyDown(box, { key: "ArrowUp" });
        expect(highlighted()).toMatch(/^\/tools/);
        fireEvent.keyDown(box, { key: "Enter" });
        expect(chat.sent.map((message) => message.text)).toEqual([
            "What can you do for me on this page? List the tools you have, briefly."
        ]);
        expect((box as HTMLTextAreaElement).value).toBe("");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("closes on Escape and leaves the text", async () => {
        mount();
        await ready();
        slash("/to");
        const box = screen.getByLabelText("Message Polar") as HTMLTextAreaElement;
        fireEvent.keyDown(box, { key: "Escape" });
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(box.value).toBe("/to");
        expect(chat.sent).toEqual([]);
    });

    it("runs a command on click and says why one is not ready", async () => {
        mount();
        await ready();
        slash("/");
        const call = screen
            .getAllByRole("option")
            .find((option) => option.textContent?.startsWith("/call"))!;
        expect(call.getAttribute("aria-disabled")).toBe("true");
        expect(call.textContent).toContain("Coming in a later update");
        fireEvent.mouseDown(call);
        expect(screen.getByRole("listbox")).toBeTruthy();
        const tools = screen
            .getAllByRole("option")
            .find((option) => option.textContent?.startsWith("/tools"))!;
        fireEvent.mouseEnter(tools);
        expect(highlighted()).toMatch(/^\/tools/);
        fireEvent.mouseDown(tools);
        expect(chat.sent).toHaveLength(1);
    });
});

describe("your own / commands", () => {
    const COMMAND = {
        id: "c1",
        shortcut: "tldr",
        prompt: "Sum this up in three lines\nThen list the open questions",
        choice: {
            kind: "language",
            provider: "auto",
            model: "auto",
            intelligence: "balanced",
            payer: null
        }
    };
    const box = () => screen.getByLabelText("Message Polar") as HTMLTextAreaElement;

    it("lists them after Polar's, by a fuzzy match, with the prompt's first line", async () => {
        ownCommands = [COMMAND];
        mount();
        await ready();
        fireEvent.change(box(), { target: { value: "/tdr" } });
        await waitFor(() =>
            expect(screen.getAllByRole("option")[0]!.textContent).toMatch(/^\/tldr/)
        );
        expect(screen.getAllByRole("option")[0]!.textContent).toContain(
            "Sum this up in three lines"
        );
        expect(screen.getAllByRole("option")[0]!.textContent).not.toContain("open questions");
    });

    it("puts the shortcut in the box when picked, and sends its prompt with what follows", async () => {
        ownCommands = [COMMAND];
        mount();
        await ready();
        fireEvent.change(box(), { target: { value: "/tld" } });
        await waitFor(() =>
            expect(screen.getAllByRole("option")[0]!.textContent).toMatch(/^\/tldr/)
        );
        fireEvent.keyDown(box(), { key: "Enter" });
        expect(box().value).toBe("/tldr ");
        expect(chat.sent).toEqual([]);
        fireEvent.change(box(), { target: { value: "/tldr the release notes" } });
        fireEvent.keyDown(box(), { key: "Enter" });
        expect(chat.sent.map((message) => message.text)).toEqual([
            "Sum this up in three lines\nThen list the open questions\n\nthe release notes"
        ]);
    });

    it("opens the form from the end of the list with the typed shortcut", async () => {
        mount();
        await ready();
        fireEvent.change(box(), { target: { value: "/review" } });
        const entry = screen
            .getAllByRole("option")
            .find((option) => option.textContent?.startsWith("New command"))!;
        fireEvent.mouseDown(entry);
        const shortcut = (await screen.findByLabelText("Shortcut *")) as HTMLInputElement;
        expect(shortcut.value).toBe("review");
        expect(screen.getByText("Automatic")).toBeTruthy();
        fireEvent.change(shortcut, { target: { value: "new" } });
        expect(screen.getByText("Polar already has a command with this name.")).toBeTruthy();
    });
});

describe("/model", () => {
    it("opens the model menu, typed whole or picked from the list", async () => {
        mount();
        await ready();
        await type("/model");
        expect(await screen.findByPlaceholderText("Find a model")).toBeTruthy();
        expect((screen.getByLabelText("Message Polar") as HTMLTextAreaElement).value).toBe("");
        fireEvent.keyDown(screen.getByPlaceholderText("Find a model"), { key: "Escape" });
        await waitFor(() => expect(screen.queryByPlaceholderText("Find a model")).toBeNull());
        fireEvent.change(screen.getByLabelText("Message Polar"), { target: { value: "/mo" } });
        fireEvent.mouseDown(screen.getAllByRole("option")[0]!);
        expect(await screen.findByPlaceholderText("Find a model")).toBeTruthy();
    });
});

describe("the conversation list after a turn", () => {
    const row = (n: number) => ({
        id: `t-${n}`,
        title: `Chat ${n}`,
        updatedAt: new Date(Date.UTC(2026, 9, 19) - n * 60_000).toISOString()
    });
    const firstPage = Array.from({ length: 50 }, (_, n) => row(n));
    const secondPage = [row(50), row(51)];

    it("keeps the pages read with Show more when the turn ends", async () => {
        let lists = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url === "/api/polar/models") {
                    return Response.json({ providers, tools: {}, isAdmin: false });
                }
                if (url === "/api/polar/threads") {
                    lists++;
                    return Response.json({ threads: firstPage, more: true });
                }
                if (url.startsWith("/api/polar/threads?view=recent&cursor=")) {
                    return Response.json({ threads: secondPage });
                }
                return Response.json({});
            })
        );
        chat.status = "streaming";
        chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }];
        const view = render(<PolarChat fullPage />, { wrapper: MessagesWrapper });
        await ready();
        fireEvent.click(await screen.findByText("Show more"));
        expect(await screen.findByText("Chat 51")).toBeTruthy();
        const before = lists;
        chat.status = "ready";
        act(() => view.rerender(<PolarChat fullPage />));
        await waitFor(() => expect(lists).toBe(before + 1));
        await act(async () => undefined);
        expect(screen.getByText("Chat 51")).toBeTruthy();
        expect(screen.getByText("Chat 0")).toBeTruthy();
    });

    it("does not read the list again when a stored conversation is opened", async () => {
        let lists = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url === "/api/polar/models") {
                    return Response.json({ providers, tools: {}, isAdmin: false });
                }
                if (url === "/api/polar/threads") {
                    lists++;
                    return Response.json({ threads: [row(0)] });
                }
                return Response.json({});
            })
        );
        const view = render(<PolarChat fullPage />, { wrapper: MessagesWrapper });
        await ready();
        await screen.findByText("Chat 0");
        const before = lists;
        chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }];
        act(() => view.rerender(<PolarChat fullPage />));
        await act(async () => undefined);
        expect(lists).toBe(before);
    });
});

describe("a message's copy button", () => {
    it("turns into a check once the text is in the clipboard", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText },
            configurable: true
        });
        chat.messages = [
            { id: "a1", role: "assistant", parts: [{ type: "text", text: "Here you go" }] }
        ];
        mount();
        await ready();
        fireEvent.click(screen.getByLabelText("Copy message"));
        expect(await screen.findByLabelText("Copied")).toBeTruthy();
        expect(writeText).toHaveBeenCalledWith("Here you go");
    });

    it("stays a copy icon when the clipboard refuses", async () => {
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
            configurable: true
        });
        chat.messages = [
            { id: "a1", role: "assistant", parts: [{ type: "text", text: "Here you go" }] }
        ];
        mount();
        await ready();
        fireEvent.click(screen.getByLabelText("Copy message"));
        await act(async () => undefined);
        expect(screen.queryByLabelText("Copied")).toBeNull();
    });
});

describe("the queue", () => {
    const busyThread = () => {
        chat.status = "streaming";
        chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "First" }] }];
    };

    it("keeps what is typed during a turn, in order, and saves it with the thread", async () => {
        busyThread();
        mount();
        await ready();
        await type("second");
        await type("third");
        expect(chat.sent).toEqual([]);
        const items = screen.getAllByLabelText("Queued message") as HTMLInputElement[];
        expect(items.map((item) => item.value)).toEqual(["second", "third"]);
        expect(patches.at(-1)).toMatchObject({ queue: [{ text: "second" }, { text: "third" }] });
    });

    it("lets a queued message be edited, moved and removed", async () => {
        busyThread();
        mount();
        await ready();
        await type("second");
        await type("third");
        const [first] = screen.getAllByLabelText("Queued message") as HTMLInputElement[];
        fireEvent.change(first!, { target: { value: "second, edited" } });
        fireEvent.blur(first!);
        expect(patches.at(-1)).toMatchObject({
            queue: [{ text: "second, edited" }, { text: "third" }]
        });
        fireEvent.click(screen.getAllByLabelText("Move down")[0]!);
        expect(patches.at(-1)).toMatchObject({
            queue: [{ text: "third" }, { text: "second, edited" }]
        });
        fireEvent.click(screen.getAllByLabelText("Remove from queue")[0]!);
        expect(patches.at(-1)).toMatchObject({ queue: [{ text: "second, edited" }] });
    });

    it("sends the queue one message at a time once the turn ends, and stopping keeps it", async () => {
        busyThread();
        const view = mount();
        await ready();
        await type("second");
        await type("third");
        fireEvent.click(screen.getByLabelText("Stop"));
        expect(chat.stopped).toBe(1);
        expect(screen.getAllByLabelText("Queued message")).toHaveLength(2);
        chat.status = "ready";
        act(() => view.again());
        await waitFor(() => expect(chat.sent.map((message) => message.text)).toEqual(["second"]));
        expect(
            (screen.getAllByLabelText("Queued message") as HTMLInputElement[]).map(
                (item) => item.value
            )
        ).toEqual(["third"]);
    });

    it("comes back with the thread after a reload", async () => {
        storedThread = {
            id: "t-old",
            messages: [
                { id: "u1", parentId: null, role: "user", parts: [{ type: "text", text: "Hi" }] }
            ],
            queue: [{ id: "q1", text: "waiting since before the reload" }],
            choice: null
        };
        chat.status = "streaming";
        mount();
        await ready();
        fireEvent.click(screen.getByLabelText("Conversations"));
        fireEvent.click(await screen.findByText("Old chat"));
        await waitFor(() =>
            expect((screen.getByLabelText("Queued message") as HTMLInputElement).value).toBe(
                "waiting since before the reload"
            )
        );
    });
});

describe("matching the / list", () => {
    const row = (shortcut: string) => ({
        id: shortcut,
        shortcut,
        prompt: "p",
        choice: {
            kind: "language" as const,
            provider: "auto",
            model: "auto",
            intelligence: "balanced" as const,
            payer: null
        }
    });
    const labels = (input: string, own = [row("tldr"), row("translate"), row("fix-tests")]) =>
        slashMatches(input, own).map((match) =>
            match.kind === "own" ? match.row.shortcut : match.command
        );

    it("ranks a prefix over a contained run over letters in order, Polar's first", () => {
        expect(labels("/t")).toEqual([
            "tools",
            "temp",
            "compact",
            "context",
            "export",
            "tldr",
            "translate",
            "fix-tests"
        ]);
        expect(labels("/ft")).toEqual(["fix-tests"]);
        expect(labels("/zz")).toEqual([]);
        expect(labels("/tldr now")).toEqual([]);
    });

    it("finds the command a message starts with, and nothing for any other", () => {
        expect(ownCommandIn("/TLDR  the notes\nand more", [row("tldr")])).toEqual({
            row: row("tldr"),
            rest: "the notes\nand more"
        });
        expect(ownCommandIn("/tldr", [row("tldr")])?.rest).toBe("");
        expect(ownCommandIn("/other x", [row("tldr")])).toBeNull();
        expect(ownCommandIn("tldr x", [row("tldr")])).toBeNull();
    });
});

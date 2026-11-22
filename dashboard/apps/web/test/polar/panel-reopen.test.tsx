// @vitest-environment jsdom
/**
 * The side panel opened again comes back to the chat it had. The open chat was
 * remembered only in the browser's storage, which every tab and window shares:
 * /polar on its own in another window wrote its chat there, and the panel,
 * closed and opened again, came back on that chat instead of its own.
 *
 * `useChat` is replaced by a store keyed by id, like the SDK's; everything else
 * is real.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Message = { id: string; role: string; parts: Array<{ type: string; text?: string }> };

const chats = new Map<string, Message[]>();
/** What the account's "Reopen the last chat" answers. */
let reopenSetting = true;

vi.mock("@ai-sdk/react", async () => {
    const { useState } = await import("react");
    return {
        useChat: (options: { id: string; messages?: Message[] }) => {
            const [, redraw] = useState(0);
            if (!chats.has(options.id)) chats.set(options.id, options.messages ?? []);
            const id = options.id;
            return {
                id,
                status: "ready",
                messages: chats.get(id)!,
                error: undefined,
                sendMessage: async () => undefined,
                stop: async () => undefined,
                setMessages: (next: Message[]) => {
                    chats.set(id, next);
                    redraw((count) => count + 1);
                },
                regenerate: async () => undefined,
                addToolApprovalResponse: async () => undefined
            };
        }
    };
});
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

function storedThread(id: string, text: string) {
    return {
        thread: {
            id,
            projectId: null,
            messages: [{ id: `${id}-u1`, parentId: null, role: "user", parts: [{ type: "text", text }] }],
            queue: [],
            choice: null
        }
    };
}

/** A storage area kept in memory: the browser's own is shared by every tab,
 *  the session one is this tab's. */
function memoryStorage(): Storage {
    const kept = new Map<string, string>();
    return {
        get length() {
            return kept.size;
        },
        key: (index: number) => [...kept.keys()][index] ?? null,
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
        clear: () => kept.clear()
    };
}

beforeEach(() => {
    chats.clear();
    reopenSetting = true;
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/models") {
                return Response.json({ providers: PROVIDERS, tools: {}, isAdmin: false });
            }
            if (url === "/api/polar/preferences") return Response.json({ reopenLastChat: reopenSetting });
            if (url === "/api/polar/threads") {
                return Response.json({
                    threads: [{ id: "t-panel", title: "Panel chat", updatedAt: "2026-10-19T00:00:00Z" }]
                });
            }
            if (url === "/api/polar/threads/t-panel") {
                return Response.json(storedThread("t-panel", "Asked in the side panel"));
            }
            if (url === "/api/polar/threads/t-page") {
                return Response.json(storedThread("t-page", "Asked on Polar's own page"));
            }
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const { PolarChat, rememberedThread, resetReloadForTests } = await import("@/components/polar/polar-panel");
const { polarDisplayStore } = await import("@/components/polar/polar-display");

/** How many times the side panel's chat was asked for. */
const panelFetches = () =>
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/polar/threads/t-panel").length;

describe("the side panel opened again", () => {
    it("comes back to its own chat, not one another window opened since", async () => {
        await polarDisplayStore.load();
        expect(polarDisplayStore.get().reopenLastChat).toBe(true);

        const first = render(<PolarChat />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(screen.getAllByText("Automatic", { exact: false })[0]).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Conversations"));
        fireEvent.click(await screen.findByText("Panel chat"));
        expect(await screen.findByText("Asked in the side panel")).toBeTruthy();
        await waitFor(() => expect(window.localStorage.getItem("polar.thread")).toBe("t-panel"));
        first.unmount();

        // /polar in another window moves on to a chat of its own meanwhile.
        window.localStorage.setItem("polar.thread", "t-page");

        render(<PolarChat />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Asked in the side panel")).toBeTruthy();
        expect(screen.queryByText("Asked on Polar's own page")).toBeNull();
        expect(
            vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/polar/threads/t-page")
        ).toBe(false);
    });

    // BUG-0007, then BUG-0016: with the setting on "A new chat", a reload with
    // the panel open keeps the chat on screen, and closing and opening the
    // panel afterwards starts a new one - in that order, every time.
    it("keeps its chat across a reload, and starts a new one when opened again", async () => {
        reopenSetting = false;
        await polarDisplayStore.load();
        polarDisplayStore.set({ ...polarDisplayStore.get(), reopenLastChat: false });
        window.localStorage.setItem("polar.thread", "t-panel");
        vi.spyOn(performance, "getEntriesByType").mockImplementation(() => [
            { type: "reload", name: window.location.href } as unknown as PerformanceEntry
        ]);
        resetReloadForTests({ panelOpen: true });

        const first = render(<PolarChat />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Asked in the side panel")).toBeTruthy();
        await waitFor(() => expect(window.sessionStorage.getItem("polar.thread")).toBe("t-panel"));
        first.unmount();
        const before = panelFetches();

        render(<PolarChat />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(screen.getAllByText("Automatic", { exact: false })[0]).toBeTruthy());
        expect(screen.queryByText("Asked in the side panel")).toBeNull();
        expect(panelFetches()).toBe(before);
    });

    it("starts on a new chat when the page reloaded with the panel closed", async () => {
        reopenSetting = false;
        await polarDisplayStore.load();
        polarDisplayStore.set({ ...polarDisplayStore.get(), reopenLastChat: false });
        window.localStorage.setItem("polar.thread", "t-panel");
        window.sessionStorage.setItem("polar.thread", "t-panel");
        vi.spyOn(performance, "getEntriesByType").mockImplementation(() => [
            { type: "reload", name: window.location.href } as unknown as PerformanceEntry
        ]);
        resetReloadForTests({ panelOpen: false });
        const before = panelFetches();

        render(<PolarChat />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(screen.getAllByText("Automatic", { exact: false })[0]).toBeTruthy());
        expect(screen.queryByText("Asked in the side panel")).toBeNull();
        expect(panelFetches()).toBe(before);
    });

    it("falls back to the browser's chat in a tab that has none of its own", () => {
        window.localStorage.setItem("polar.thread", "t-page");
        expect(rememberedThread("polar.thread")).toBe("t-page");
        window.sessionStorage.setItem("polar.thread", "t-panel");
        expect(rememberedThread("polar.thread")).toBe("t-panel");
        // A new chat started in this tab stays new, whatever another tab opened.
        window.sessionStorage.setItem("polar.thread", "");
        expect(rememberedThread("polar.thread")).toBe("");
    });
});

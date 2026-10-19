// @vitest-environment jsdom
/**
 * Polar as a page, laid out like ChatGPT's and Claude's: one "New chat" on top
 * of the sidebar, no heading repeated above the list, conversations grouped by
 * when they were last touched, rename and delete behind each row's "..." menu
 * (delete asks in the app's own dialog), a sidebar that can be put away and
 * remembers it, and a centred welcome while the conversation is empty.
 */

import type { ReactNode } from "react";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: "ready",
        messages: [],
        error: undefined,
        sendMessage: async () => undefined,
        stop: async () => undefined,
        setMessages: () => undefined,
        regenerate: async () => undefined,
        addToolApprovalResponse: async () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/polar",
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
const DAY = 86_400_000;
const now = Date.now();
const THREADS = [
    {
        id: "00000000-0000-4000-8000-000000000001",
        title: "Fresh one",
        updatedAt: new Date(now).toISOString()
    },
    {
        id: "00000000-0000-4000-8000-000000000002",
        title: "From yesterday",
        updatedAt: new Date(now - DAY).toISOString()
    },
    {
        id: "00000000-0000-4000-8000-000000000003",
        title: "Long ago",
        updatedAt: new Date(now - 90 * DAY).toISOString()
    }
];

const calls: Array<{ url: string; method: string; body?: unknown }> = [];
let threads: typeof THREADS = THREADS;
let refuseRename = false;

beforeEach(() => {
    calls.length = 0;
    threads = THREADS;
    refuseRename = false;
    // This environment has no storage of its own; the sidebar's memory needs one.
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        clear: () => stored.clear()
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            calls.push({
                url,
                method,
                body: init?.body ? JSON.parse(String(init.body)) : undefined
            });
            if (url === "/api/polar/models")
                return Response.json({ providers: PROVIDERS, tools: {}, isAdmin: false });
            if (url === "/api/polar/threads") return Response.json({ threads });
            if (method === "PATCH" && refuseRename) return Response.json({}, { status: 500 });
            return Response.json({ ok: true });
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

function mountPage() {
    return render(<PolarChat fullPage />, { wrapper: Wrapper });
}

function narrowWindow() {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    }));
}

function openRowMenu(title: string) {
    const row = screen.getByTitle(title).parentElement as HTMLElement;
    fireEvent.pointerDown(within(row).getByLabelText("Conversation options"), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse"
    });
}

describe("the /polar sidebar", () => {
    it("has one New chat and no heading repeated above the list", async () => {
        mountPage();
        await screen.findByText("Fresh one");
        expect(screen.getAllByRole("button", { name: "New chat" })).toHaveLength(1);
        expect(screen.queryAllByText("Conversations")).toHaveLength(0);
    });

    it("groups conversations by their last update", async () => {
        mountPage();
        await screen.findByText("Fresh one");
        const groups = screen
            .getAllByRole("group")
            .map((group) => group.getAttribute("aria-labelledby"))
            .filter((id) => id?.startsWith("polar-group-"));
        expect(groups).toEqual(["polar-group-today", "polar-group-yesterday", "polar-group-older"]);
        expect(
            within(screen.getByRole("group", { name: "Today" })).getByText("Fresh one")
        ).toBeTruthy();
        expect(
            within(screen.getByRole("group", { name: "Yesterday" })).getByText("From yesterday")
        ).toBeTruthy();
        expect(
            within(screen.getByRole("group", { name: "Older" })).getByText("Long ago")
        ).toBeTruthy();
    });

    it("says so in one line when there are no conversations", async () => {
        threads = [];
        mountPage();
        expect(await screen.findByText("No conversations yet.")).toBeTruthy();
        expect(screen.queryAllByText("Conversations")).toHaveLength(0);
    });

    it("asks in a dialog before deleting, then deletes", async () => {
        mountPage();
        await screen.findByText("Long ago");
        openRowMenu("Long ago");
        fireEvent.click(await screen.findByText("Delete"));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Delete conversation?")).toBeTruthy();
        expect(calls.some((call) => call.method === "DELETE")).toBe(false);
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
        await waitFor(() =>
            expect(calls.find((call) => call.method === "DELETE")?.url).toBe(
                `/api/polar/threads/${THREADS[2]!.id}`
            )
        );
        expect(screen.queryByText("Long ago")).toBeNull();
    });

    it("renames a conversation in place", async () => {
        mountPage();
        await screen.findByText("Fresh one");
        openRowMenu("Fresh one");
        fireEvent.click(await screen.findByText("Rename"));
        const field = (await screen.findByLabelText("Conversation name")) as HTMLInputElement;
        fireEvent.change(field, { target: { value: "  Renamed chat  " } });
        fireEvent.keyDown(field, { key: "Enter" });
        await waitFor(() =>
            expect(calls.find((call) => call.method === "PATCH")).toEqual({
                url: `/api/polar/threads/${THREADS[0]!.id}`,
                method: "PATCH",
                body: { title: "Renamed chat" }
            })
        );
        expect(screen.getByText("Renamed chat")).toBeTruthy();
    });

    it("puts only that title back and says so when a rename is refused", async () => {
        refuseRename = true;
        mountPage();
        await screen.findByText("Fresh one");
        openRowMenu("Fresh one");
        fireEvent.click(await screen.findByText("Rename"));
        const field = (await screen.findByLabelText("Conversation name")) as HTMLInputElement;
        fireEvent.change(field, { target: { value: "Renamed chat" } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(
            await screen.findByText("Couldn't rename the conversation. Try again.")
        ).toBeTruthy();
        expect(screen.getByText("Fresh one")).toBeTruthy();
        expect(screen.queryByText("Renamed chat")).toBeNull();
        expect(screen.getByText("Long ago")).toBeTruthy();
    });

    it("opens the conversations in a drawer on a phone, with focus inside and Escape to close", async () => {
        narrowWindow();
        mountPage();
        const menu = await screen.findByRole("button", { name: "Show conversations" });
        expect(screen.queryByText("Fresh one")).toBeNull();
        menu.focus();
        fireEvent.click(menu);
        const drawer = await screen.findByRole("dialog", { name: "Conversations" });
        expect(within(drawer).getByText("Fresh one")).toBeTruthy();
        await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(document.activeElement).toBe(menu);
        fireEvent.click(menu);
        const again = await screen.findByRole("dialog", { name: "Conversations" });
        fireEvent.click(within(again).getByRole("button", { name: "New chat" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(document.activeElement).toBe(screen.getByLabelText("Message Polar"));
    });

    it("puts the sidebar away and remembers it", async () => {
        mountPage();
        await screen.findByText("Fresh one");
        fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
        expect(screen.queryByText("Fresh one")).toBeNull();
        expect(window.localStorage.getItem("polar.sidebar")).toBe("hidden");
        cleanup();
        mountPage();
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Show conversations" })).toBeTruthy()
        );
        expect(screen.queryByRole("navigation")).toBeNull();
    });

    it("welcomes an empty conversation in the middle of the page", async () => {
        mountPage();
        expect(await screen.findByRole("heading", { name: "How can I help?" })).toBeTruthy();
        expect(screen.getByLabelText("Message Polar")).toBeTruthy();
    });
});

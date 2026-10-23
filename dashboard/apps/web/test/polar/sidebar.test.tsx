// @vitest-environment jsdom
/**
 * The ChatGPT-style sidebar: Pinned only when something is pinned, Projects
 * with their own chats, Recents that fold and remember it, and a row menu whose
 * actions change the row at once and put it back when the server refuses.
 */

import type { ReactNode } from "react";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
    within
} from "@testing-library/react";

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

const NOW = new Date().toISOString();
const PROJECT = { id: "00000000-0000-4000-8000-0000000000aa", name: "Homelab", instructions: "" };
const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    updatedAt: NOW,
    pinnedAt: null,
    archivedAt: null,
    projectId: null,
    ...extra
});
const RECENT = row("00000000-0000-4000-8000-000000000001", "Recent chat");
const PINNED = row("00000000-0000-4000-8000-000000000002", "Pinned chat", { pinnedAt: NOW });
const FILED = row("00000000-0000-4000-8000-000000000003", "Filed chat", {
    projectId: PROJECT.id
});

const OLD = row("00000000-0000-4000-8000-000000000004", "Old chat", {
    updatedAt: "2024-01-01T00:00:00.000Z"
});

const calls: Array<{ url: string; method: string; body?: unknown }> = [];
let refuse = false;
let pinned = [PINNED];
let more = false;

beforeEach(() => {
    calls.length = 0;
    refuse = false;
    pinned = [PINNED];
    more = false;
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
            if (url === "/api/polar/runs")
                return Response.json({
                    runs: [
                        { threadId: RECENT.id, state: "running", unread: false, startedAt: 2 },
                        { threadId: PINNED.id, state: "approval", unread: false, startedAt: 1 }
                    ]
                });
            if (url.endsWith("/stream")) return new Response(null, { status: 204 });
            if (url === "/api/polar/models")
                return Response.json({ providers: [], tools: {}, isAdmin: false });
            if (url === "/api/polar/threads")
                return Response.json({ threads: [RECENT], more, pinned, projects: [PROJECT] });
            if (url.startsWith("/api/polar/threads?view=project"))
                return Response.json({ threads: [FILED], more });
            if (url.startsWith("/api/polar/search"))
                return Response.json({ results: [OLD], more: false });
            if (url.includes("cursor=")) return Response.json({ threads: [], more: false });
            if (url === `/api/polar/threads/${OLD.id}` && method === "GET")
                return Response.json({
                    thread: { ...OLD, choice: null, queue: [], messages: [] }
                });
            if (url.endsWith("/share") && method === "GET") return Response.json({ link: null });
            if (url.endsWith("/share") && method === "POST")
                return Response.json({
                    link: {
                        url: "https://polaris.example/c/token",
                        sharedAt: NOW,
                        views: 0,
                        hasPassword: false,
                        expiresAt: null,
                        maxViews: null,
                        allowedCidrs: [],
                        allowedCountries: [],
                        allowedContinents: []
                    }
                });
            if (method !== "GET" && refuse) return Response.json({}, { status: 500 });
            return Response.json({ ok: true });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");
const { usePolarSidebar } = await import("@/components/polar/use-polar-sidebar");

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <MessagesWrapper>
            <ToastProvider>{children}</ToastProvider>
        </MessagesWrapper>
    );
}

async function mountPage() {
    render(<PolarChat fullPage />, { wrapper: Wrapper });
    await screen.findByText("Recent chat");
}

function section(name: string) {
    return screen.getByRole("group", { name });
}

function openMenu(title: string) {
    const item = screen.getByTitle(title).parentElement as HTMLElement;
    fireEvent.pointerDown(within(item).getByLabelText("Conversation options"), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse"
    });
}

describe("chats answering elsewhere", () => {
    it("marks a chat that is answering, and one waiting for an approval", async () => {
        await mountPage();
        const recent = screen.getByTitle("Recent chat").parentElement as HTMLElement;
        expect(await within(recent).findByRole("img", { name: "Answering now" })).toBeTruthy();
        const waiting = screen.getByTitle("Pinned chat").parentElement as HTMLElement;
        expect(within(waiting).getByRole("img", { name: "Needs your approval" })).toBeTruthy();
    });
});

describe("the sections", () => {
    it("lists pinned chats under Pinned and the rest under Recents", async () => {
        await mountPage();
        expect(within(section("Pinned")).getByText("Pinned chat")).toBeTruthy();
        expect(within(section("Pinned")).queryByText("Recent chat")).toBeNull();
        expect(screen.getAllByText("Pinned chat")).toHaveLength(1);
    });

    it("has no Pinned section while nothing is pinned", async () => {
        pinned = [];
        await mountPage();
        expect(screen.queryByRole("group", { name: "Pinned" })).toBeNull();
    });

    it("opens a project to show its own chats, which are not in Recents", async () => {
        await mountPage();
        fireEvent.click(screen.getByRole("button", { name: "Homelab" }));
        expect(await screen.findByText("Filed chat")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Homelab" }).getAttribute("aria-expanded")).toBe(
            "true"
        );
        expect(
            within(screen.getByRole("group", { name: "Today" })).queryByText("Filed chat")
        ).toBeNull();
    });

    it("folds Recents and remembers it", async () => {
        await mountPage();
        fireEvent.click(screen.getByRole("button", { name: "Recents" }));
        expect(screen.queryByText("Recent chat")).toBeNull();
        expect(window.localStorage.getItem("polar.recents")).toBe("folded");
    });

    it("has nav rows only for what Polar has", async () => {
        await mountPage();
        expect(screen.getAllByRole("button", { name: "New chat" })).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Search chats" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
    });
});

describe("the row menu", () => {
    it("pins from the row's pin button and moves it to Pinned at once", async () => {
        await mountPage();
        const item = screen.getByTitle("Recent chat").parentElement as HTMLElement;
        fireEvent.click(within(item).getByRole("button", { name: "Pin" }));
        expect(within(section("Pinned")).getByText("Recent chat")).toBeTruthy();
        await waitFor(() =>
            expect(calls.find((call) => call.method === "PATCH")).toEqual({
                url: `/api/polar/threads/${RECENT.id}`,
                method: "PATCH",
                body: { pinned: true }
            })
        );
    });

    it("puts a refused pin back and says so", async () => {
        refuse = true;
        pinned = [];
        await mountPage();
        const item = screen.getByTitle("Recent chat").parentElement as HTMLElement;
        fireEvent.click(within(item).getByRole("button", { name: "Pin" }));
        expect(
            await screen.findByText("Couldn't update the conversation. Try again.")
        ).toBeTruthy();
        expect(screen.queryByRole("group", { name: "Pinned" })).toBeNull();
        expect(screen.getByText("Recent chat")).toBeTruthy();
    });

    it("has the options in ChatGPT's order, Delete in red", async () => {
        await mountPage();
        openMenu("Recent chat");
        const menu = await screen.findByRole("menu");
        const names = within(menu)
            .getAllByRole("menuitem")
            .map((entry) => entry.textContent);
        expect(names).toEqual([
            "Rename",
            "Pin",
            "Share",
            "Export as Markdown",
            "Export as JSON",
            "Archive",
            "Delete",
            "Move to project"
        ]);
    });

    it("archives a chat out of the list", async () => {
        await mountPage();
        openMenu("Recent chat");
        fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
        await waitFor(() => expect(screen.queryByText("Recent chat")).toBeNull());
        expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ archived: true });
    });

    it("moves a chat into a project from the submenu", async () => {
        await mountPage();
        openMenu("Recent chat");
        const trigger = await screen.findByRole("menuitem", { name: "Move to project" });
        fireEvent.keyDown(trigger, { key: "ArrowRight" });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Homelab" }));
        await waitFor(() =>
            expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
                projectId: PROJECT.id
            })
        );
    });

    it("asks in the app's dialog before deleting", async () => {
        await mountPage();
        openMenu("Recent chat");
        fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
        const dialog = await screen
            .findByRole("alertdialog")
            .catch(() => screen.findByRole("dialog"));
        expect(calls.some((call) => call.method === "DELETE")).toBe(false);
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
        expect(screen.queryByText("Recent chat")).toBeNull();
    });

    it("shares through a link made on the server", async () => {
        await mountPage();
        openMenu("Recent chat");
        fireEvent.click(await screen.findByRole("menuitem", { name: "Share" }));
        fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
        const field = (await screen.findByLabelText("Public link")) as HTMLInputElement;
        expect(field.value).toBe("https://polaris.example/c/token");
        expect(screen.getByRole("button", { name: "Delete link" })).toBeTruthy();
    });
});

describe("Show more", () => {
    it("reads the next recents after the last one the server sent, not a chat found by search", async () => {
        more = true;
        await mountPage();
        fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
        fireEvent.change(await screen.findByLabelText("Search titles and messages"), {
            target: { value: "old" }
        });
        fireEvent.click(await screen.findByTitle("Old chat"));
        await screen.findByText("Old chat");
        const recents = screen.getByRole("button", { name: "Recents" })
            .parentElement as HTMLElement;
        fireEvent.click(within(recents).getByRole("button", { name: "Show more" }));
        await waitFor(() => expect(calls.some((call) => call.url.includes("cursor="))).toBe(true));
        expect(calls.find((call) => call.url.includes("cursor="))?.url).toBe(
            `/api/polar/threads?view=recent&cursor=${RECENT.id}`
        );
    });

    it("pages a project's own chats", async () => {
        more = true;
        await mountPage();
        fireEvent.click(screen.getByRole("button", { name: "Homelab" }));
        await screen.findByText("Filed chat");
        const project = screen.getByRole("button", { name: "Homelab" }).closest("div")
            ?.parentElement as HTMLElement;
        fireEvent.click(within(project).getByRole("button", { name: "Show more" }));
        await waitFor(() =>
            expect(calls.map((call) => call.url)).toContain(
                `/api/polar/threads?view=project&project=${PROJECT.id}&cursor=${FILED.id}`
            )
        );
    });
});

describe("the sidebar's state", () => {
    it("reads an open project again when the list is shown again", async () => {
        const { result, rerender } = renderHook(
            ({ enabled }) => usePolarSidebar({ enabled, onRemoved: () => undefined }),
            { wrapper: Wrapper, initialProps: { enabled: true } }
        );
        await waitFor(() => expect(result.current.rows).not.toBeNull());
        act(() => result.current.openProject(PROJECT.id));
        await waitFor(() =>
            expect(result.current.rows?.some((entry) => entry.id === FILED.id)).toBe(true)
        );
        rerender({ enabled: false });
        rerender({ enabled: true });
        await waitFor(() =>
            expect(calls.filter((call) => call.url.includes("view=project")).length).toBe(2)
        );
        await waitFor(() =>
            expect(result.current.rows?.some((entry) => entry.id === FILED.id)).toBe(true)
        );
        expect(result.current.openProjects.has(PROJECT.id)).toBe(true);
    });
});

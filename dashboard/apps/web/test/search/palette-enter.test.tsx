// @vitest-environment jsdom

/**
 * Enter in the search panel runs exactly the row that is highlighted: after
 * arrow keys, after results arrive late and re-sort the list, and not while an
 * input method is still composing.
 */

import { MessagesWrapper } from "../setup/i18n";
import { CommandPalette } from "@/components/command-palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
const show = vi.fn();
const late = vi.hoisted(() => ({ resolve: null as null | ((body: { recent: unknown[] }) => void) }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => "/home"
}));

vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({ show, dismiss: vi.fn() })
}));

vi.mock("@/app/(app)/search-actions", () => ({
    clearSearchHistoryAction: vi.fn(async () => ({})),
    forgetSearchAction: vi.fn(async () => ({})),
    listRecentSearchesAction: vi.fn(async () => ({ recent: [] })),
    recordSearchAction: vi.fn(async () => ({}))
}));

// The hidden "Locked chats" lookup is a server action; no reader here hid it.
vi.mock("@/app/(app)/chat/lock-actions", () => ({
    searchLockAction: async () => null,
    openLockedChatsAction: async () => ({ error: "wrong" })
}));
vi.mock("@/app/(app)/tour-actions", () => ({
    markOverviewAction: vi.fn(async () => undefined),
    shouldOfferOverviewAction: vi.fn(async () => false)
}));

// jsdom draws nothing, so it has no scrolling to do.
Element.prototype.scrollIntoView = () => undefined;

beforeEach(() => {
    late.resolve = null;
    try {
        window.localStorage.clear();
    } catch {
        // No storage in this environment; the panel works without it.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
            if (String(input).startsWith("/api/search/recent"))
                return new Promise<Response>((resolve) => {
                    late.resolve = (body) => resolve(Response.json(body));
                });
            return Response.json({ hits: [], resources: [] });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function openField(): Promise<HTMLInputElement> {
    render(<CommandPalette appIds={["deploy", "tasks", "chat"]} />, { wrapper: MessagesWrapper });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    return (await screen.findByRole("combobox")) as HTMLInputElement;
}

const highlighted = () => document.querySelector('[data-active="true"]') as HTMLElement;

describe("Enter in the search panel", () => {
    it("runs the row the arrow keys moved to", async () => {
        const field = await openField();
        fireEvent.keyDown(field, { key: "ArrowDown" });
        fireEvent.keyDown(field, { key: "ArrowDown" });
        const seen = highlighted();
        const rows = [...document.querySelectorAll("[data-active]")];
        expect(rows.indexOf(seen)).toBe(2);
        fireEvent.keyDown(field, { key: "Enter" });
        expect(push).toHaveBeenCalledTimes(1);
        expect(seen.textContent).toBeTruthy();
    });

    it("still runs the row that was highlighted when results arrive late and re-sort the list", async () => {
        const field = await openField();
        fireEvent.keyDown(field, { key: "ArrowDown" });
        const seen = highlighted().textContent;
        const before = [...document.querySelectorAll("[data-active]")].length;

        // What the account remembers arrives now and is listed above the pages.
        await waitFor(() => expect(late.resolve).not.toBeNull());
        late.resolve!({
            recent: [
                { kind: "result", scope: "tasks", term: "", label: "Late one", href: "/tasks/late-1", usedAt: new Date().toISOString() },
                { kind: "result", scope: "tasks", term: "", label: "Late two", href: "/tasks/late-2", usedAt: new Date().toISOString() }
            ]
        });
        await screen.findByText("Late one");
        expect([...document.querySelectorAll("[data-active]")].length).toBeGreaterThan(before);
        expect(highlighted().textContent).toBe(seen);

        fireEvent.keyDown(field, { key: "Enter" });
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalledWith("/tasks/late-1");
        expect(push).not.toHaveBeenCalledWith("/tasks/late-2");
    });

    it("does not run a row for the Enter that confirms an input method candidate", async () => {
        const field = await openField();
        fireEvent.keyDown(field, { key: "Enter", isComposing: true });
        expect(push).not.toHaveBeenCalled();
    });
});

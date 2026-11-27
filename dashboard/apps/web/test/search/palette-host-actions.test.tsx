// @vitest-environment jsdom

/**
 * A host row's actions in the desktop's search window (Raycast's Ctrl+K action
 * panel): Ctrl+K lists Open and what else the row can do, an action is sent
 * with the answer the row came from and the rows are asked for again, Escape
 * closes the panel and not the search, and a host too old to have actions, or
 * to number its answers, offers none.
 */


import { MessagesWrapper } from "../setup/i18n";
import type { SearchHost } from "@/lib/search/search-host";
import { CommandPalette } from "@/components/command-palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => "/launcher"
}));

vi.mock("@/app/(app)/search-actions", () => ({
    clearSearchHistoryAction: vi.fn(async () => ({})),
    forgetSearchAction: vi.fn(async () => ({})),
    listRecentSearchesAction: vi.fn(async () => ({ recent: [] })),
    recordSearchAction: vi.fn(async () => ({}))
}));
vi.mock("@/app/(app)/chat/lock-actions", () => ({
    searchLockAction: async () => null,
    openLockedChatsAction: async () => ({ error: "wrong" })
}));
vi.mock("@/app/(app)/tour-actions", () => ({
    markOverviewAction: vi.fn(async () => undefined),
    shouldOfferOverviewAction: vi.fn(async () => false)
}));

Element.prototype.scrollIntoView = () => undefined;

const DOLPHIN = { id: "0", kind: "app", title: "Dolphin", subtitle: "Application" };

function fakeHost({ acts = true, numbered = true } = {}) {
    let game = false;
    let version = 0;
    const host: SearchHost = {
        query: vi.fn(async () => {
            version += 1;
            const row = { ...DOLPHIN, ...(game ? { game: true } : {}), actions: [game ? "treat-as-app" : "treat-as-game"] };
            return numbered ? { rows: [row], version } : { rows: [row] };
        }),
        run: vi.fn(),
        navigate: vi.fn(),
        close: vi.fn(),
        onOpened: () => undefined,
        act: acts
            ? vi.fn(async () => {
                  game = !game;
                  return true;
              })
            : undefined
    };
    return host;
}

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => (input === "/api/search" ? Response.json({ resources: [] }) : Response.json({ recent: [] })))
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function typed(host: SearchHost, text: string): Promise<HTMLElement> {
    render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
    const field = await screen.findByRole("combobox");
    fireEvent.change(field, { target: { value: text } });
    await screen.findByRole("option", { name: "Dolphin" });
    return field;
}

describe("a host row's actions", () => {
    it("lists Open and the other kind on Ctrl+K, and sends the action with the answer the row came from", async () => {
        const host = fakeHost();
        const field = await typed(host, "dolphin");
        const asked = vi.mocked(host.query).mock.calls.length;
        const version = asked;

        fireEvent.keyDown(field, { key: "k", ctrlKey: true });
        expect(screen.getByRole("group", { name: "Actions for Dolphin" })).toBeTruthy();
        expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual(["Open", "Treat as Game"]);

        fireEvent.keyDown(field, { key: "ArrowDown" });
        fireEvent.keyDown(field, { key: "Enter" });
        await waitFor(() => expect(host.act).toHaveBeenCalledWith("0", "treat-as-game", version));
        // Asked again, so the row shows what it is now.
        await waitFor(() => expect(vi.mocked(host.query).mock.calls.length).toBeGreaterThan(asked));
        expect(await screen.findByRole("option", { name: "Dolphin" })).toBeTruthy();
        fireEvent.keyDown(field, { key: "k", ctrlKey: true });
        expect(screen.getByRole("option", { name: "Treat as Application" })).toBeTruthy();
    });

    it("opens the row from its first entry, and closes the panel, not the search, on Escape", async () => {
        const host = fakeHost();
        const field = await typed(host, "dolphin");
        fireEvent.keyDown(field, { key: "k", ctrlKey: true });
        fireEvent.keyDown(field, { key: "Escape" });
        expect(screen.queryByRole("group", { name: "Actions for Dolphin" })).toBeNull();
        expect(screen.getByRole("combobox")).toBeTruthy();
        expect(host.close).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
        fireEvent.keyDown(field, { key: "Enter" });
        expect(host.run).toHaveBeenCalledWith("0");
        expect(host.act).not.toHaveBeenCalled();
    });

    it("offers no actions from a host without them, or one that does not number its answers", async () => {
        for (const host of [fakeHost({ acts: false }), fakeHost({ numbered: false })]) {
            const field = await typed(host, "dolphin");
            fireEvent.keyDown(field, { key: "k", ctrlKey: true });
            expect(screen.queryByRole("group", { name: "Actions for Dolphin" })).toBeNull();
            expect(screen.queryByRole("button", { name: /Actions/ })).toBeNull();
            cleanup();
        }
    });
});

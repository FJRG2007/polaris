// @vitest-environment jsdom

/**
 * An address typed into the search panel: its "Open" row leads and Enter opens
 * it in a new tab; anything that is not http, https or mailto is never offered.
 */

import { MessagesWrapper } from "../setup/i18n";
import { CommandPalette } from "@/components/command-palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const push = vi.fn();
const show = vi.fn();

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
    try {
        window.localStorage.clear();
    } catch {
        // No storage in this environment; the panel works without it.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ hits: [], resources: [] }))
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function openField(): Promise<HTMLInputElement> {
    render(<CommandPalette appIds={["deploy", "tasks"]} />, { wrapper: MessagesWrapper });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    return (await screen.findByRole("combobox")) as HTMLInputElement;
}

describe("an address typed into the search panel", () => {
    it("leads with Open <host> and opens it in a new tab on Enter", async () => {
        const open = vi.fn(() => null);
        vi.stubGlobal("open", open);
        const field = await openField();
        fireEvent.change(field, { target: { value: "example.com/docs" } });

        const first = screen.getAllByRole("option")[0];
        expect(first?.getAttribute("aria-label")).toBe("Open example.com");
        fireEvent.keyDown(field, { key: "Enter" });
        expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener");
    });

    it.each(["javascript:alert(1)", "file:///C:/Windows", "1.5", "grand theft auto"])(
        "offers no address for %j",
        async (input) => {
            const field = await openField();
            fireEvent.change(field, { target: { value: input } });
            expect(screen.queryByRole("option", { name: /^Open / })).toBeNull();
        }
    );
});

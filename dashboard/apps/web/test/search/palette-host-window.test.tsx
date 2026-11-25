// @vitest-environment jsdom

/**
 * The palette in Polaris Desktop's Alt+Space window (`/launcher`): every open
 * hands the field the keys - after Escape, after the window lost focus, and
 * with a desktop too old to say it hid - nothing dims the screen behind it, and
 * an index already loaded paints at once instead of waiting on the network.
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

const indexRequests: string[] = [];

/** A host as the desktop's bridge drives it: it says when it shows the
 *  window, and - when new enough - when it hid it by itself. */
function fakeHost(withHidden = true) {
    let opened: () => void = () => undefined;
    let hidden: () => void = () => undefined;
    const host: SearchHost = {
        query: vi.fn(async () => ({ rows: [] })),
        run: vi.fn(),
        navigate: vi.fn(),
        close: vi.fn(),
        onOpened: (listener) => {
            opened = listener;
        },
        onHidden: withHidden
            ? (listener) => {
                  hidden = listener;
              }
            : undefined
    };
    return { host, open: () => act(() => opened()), hide: () => act(() => hidden()) };
}

beforeEach(() => {
    indexRequests.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
            if (input === "/api/search") {
                indexRequests.push(input);
                return Response.json({
                    resources: [
                        { id: "p1", kind: "project", label: "Zephyr deploy", context: "Prod", href: "/apps/deploy/p1" }
                    ]
                });
            }
            return Response.json({ recent: [] });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function focusedField(): Promise<HTMLElement> {
    const field = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(field));
    return field;
}

describe("the palette in the desktop's search window", () => {
    it("focuses the field again when reopened after Escape", async () => {
        const { host, open } = fakeHost();
        render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
        await focusedField();

        fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
        // Gone for good, not left mounted mid exit animation in a hidden window.
        await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
        expect(host.close).toHaveBeenCalled();

        (document.activeElement as HTMLElement | null)?.blur();
        open();
        await focusedField();
    });

    it("closes when the window is hidden by a lost focus, and focuses the field on the next open", async () => {
        const { host, open, hide } = fakeHost();
        render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
        const first = await focusedField();
        fireEvent.change(first, { target: { value: "half typed" } });

        hide();
        await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());

        open();
        const field = await focusedField();
        expect((field as HTMLInputElement).value).toBe("");
    });

    it("still focuses the field when a desktop too old to say it hid shows it again", async () => {
        const { host, open } = fakeHost(false);
        render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
        const field = await focusedField();
        field.blur();
        expect(document.activeElement).not.toBe(field);
        open();
        await focusedField();
    });

    it("does not dim the screen behind the panel", async () => {
        const { host } = fakeHost();
        render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
        await focusedField();
        const backdrop = document.querySelector("[data-search-backdrop]");
        expect(backdrop?.className).toContain("bg-transparent");
        expect(backdrop?.className).toContain("backdrop-blur-none");
        expect(document.querySelector("[data-radix-dialog-overlay], .bg-black\\/50:not(.bg-transparent)")).toBeNull();
    });

    it("paints an index it already has at once when stale, and asks again only after the panel is up", async () => {
        const { host, open } = fakeHost();
        render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
        await focusedField();
        await waitFor(() => expect(indexRequests).toHaveLength(1));

        fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());

        // Past the index's freshness window, as after a while idle.
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
        open();
        const field = await focusedField();
        fireEvent.change(field, { target: { value: "zephyr" } });
        // Drawn from what was loaded, with no spinner and no request yet.
        expect(screen.getByRole("option", { name: /Zephyr deploy/ })).toBeTruthy();
        expect(document.querySelector(".animate-spin")).toBeNull();
        expect(document.querySelector(".animate-pulse")).toBeNull();
        expect(indexRequests).toHaveLength(1);
        // Revalidated behind it.
        await waitFor(() => expect(indexRequests).toHaveLength(2));
        expect(screen.getByRole("option", { name: /Zephyr deploy/ })).toBeTruthy();
    });
});

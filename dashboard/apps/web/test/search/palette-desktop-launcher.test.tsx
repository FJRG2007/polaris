// @vitest-environment jsdom

/**
 * Inside Polaris Desktop's main window, every way into search - the header
 * button, the search key, a request from elsewhere on the page - opens the
 * app's launcher (the Alt+Space window) instead of this page's panel, with
 * the text it was asked for. A browser, a desktop build older than the bridge
 * call, and a launcher switched off keep the page's own panel.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { SearchHost } from "@/lib/search/search-host";
import { CommandPalette } from "@/components/command-palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDesktopLauncher, openSearch } from "@/lib/search/open-search";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let pathname = "/home";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => pathname
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

/** The main window's bridge as the desktop app's preload exposes it. */
function stubDesktop(showLauncher?: (query?: string) => Promise<boolean>) {
    const noop = vi.fn(async () => undefined);
    vi.stubGlobal("polarisDesktop", {
        version: "0.1.0",
        platform: "win32",
        notify: noop,
        closeNotice: noop,
        pickFolder: noop,
        pushLocal: noop,
        openWindow: noop,
        ...(showLauncher ? { showLauncher } : {})
    });
}

beforeEach(() => {
    pathname = "/home";
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) =>
            input === "/api/search" ? Response.json({ resources: [] }) : Response.json({ recent: [] })
        )
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("openDesktopLauncher", () => {
    it("opens the page's panel in a browser", () => {
        const fallback = vi.fn();
        openDesktopLauncher("x", fallback);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it("opens the page's panel on a desktop build older than the bridge call", () => {
        stubDesktop();
        const fallback = vi.fn();
        openDesktopLauncher(null, fallback);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it("hands the launcher the text and leaves the panel shut", async () => {
        const show = vi.fn(async () => true);
        stubDesktop(show);
        const fallback = vi.fn();
        openDesktopLauncher("notes", fallback);
        await waitFor(() => expect(show).toHaveBeenCalledWith("notes"));
        await Promise.resolve();
        expect(fallback).not.toHaveBeenCalled();
    });

    it("opens the panel when the launcher is switched off or the call fails", async () => {
        stubDesktop(vi.fn(async () => false));
        const off = vi.fn();
        openDesktopLauncher(null, off);
        await waitFor(() => expect(off).toHaveBeenCalledOnce());

        stubDesktop(vi.fn(async () => Promise.reject(new Error("gone"))));
        const failed = vi.fn();
        openDesktopLauncher(null, failed);
        await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    });
});

describe("the palette in the desktop app's main window", () => {
    it("opens the launcher from the header button", async () => {
        const show = vi.fn(async () => true);
        stubDesktop(show);
        render(<CommandPalette appIds={[]} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Search Polaris" }));
        await waitFor(() => expect(show).toHaveBeenCalledWith(""));
        expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("opens the launcher from the search key", async () => {
        const show = vi.fn(async () => true);
        stubDesktop(show);
        render(<CommandPalette appIds={[]} />, { wrapper: MessagesWrapper });
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        await waitFor(() => expect(show).toHaveBeenCalledOnce());
        expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("hands the launcher the text a request asked for", async () => {
        const show = vi.fn(async () => true);
        stubDesktop(show);
        render(<CommandPalette appIds={[]} />, { wrapper: MessagesWrapper });
        act(() => openSearch(null, "  quarterly\nreport "));
        await waitFor(() => expect(show).toHaveBeenCalledWith("quarterly report"));
        expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("keeps Chat's own scoped search, and its quick switcher, on the page", async () => {
        const show = vi.fn(async () => true);
        stubDesktop(show);
        render(<CommandPalette appIds={[]} />, { wrapper: MessagesWrapper });
        act(() => openSearch("chat"));
        expect(await screen.findByRole("combobox")).toBeTruthy();
        cleanup();

        pathname = "/chat";
        render(<CommandPalette appIds={[]} />, { wrapper: MessagesWrapper });
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        expect(await screen.findByRole("combobox")).toBeTruthy();
        expect(show).not.toHaveBeenCalled();
    });

    it("opens the page's panel when the launcher is switched off", async () => {
        stubDesktop(vi.fn(async () => false));
        render(<CommandPalette appIds={[]} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Search Polaris" }));
        expect(await screen.findByRole("combobox")).toBeTruthy();
    });
});

describe("the palette in the launcher window", () => {
    it("opens with the text the main window handed over", async () => {
        let opened: (query?: string) => void = () => undefined;
        const host: SearchHost = {
            query: vi.fn(async () => ({ rows: [] })),
            run: vi.fn(),
            navigate: vi.fn(),
            close: vi.fn(),
            onOpened: (listener) => {
                opened = listener;
            }
        };
        render(<CommandPalette appIds={[]} host={host} />, { wrapper: MessagesWrapper });
        await screen.findByRole("combobox");
        act(() => opened("deploy"));
        await waitFor(() => expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("deploy"));
        act(() => opened());
        await waitFor(() => expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(""));
    });
});

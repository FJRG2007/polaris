// @vitest-environment jsdom

/**
 * The search panel opened from Chat's field: already narrowed to Chat, with the
 * filters a chat app's quick switcher has, and a filter that keeps what was typed.
 */

import { openSearch } from "@/lib/search/open-search";
import { CommandPalette } from "@/components/command-palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
let pathname = "/chat";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => pathname
}));

vi.mock("@/app/(app)/search-actions", () => ({
    clearSearchHistoryAction: vi.fn(async () => ({})),
    forgetSearchAction: vi.fn(async () => ({})),
    listRecentSearchesAction: vi.fn(async () => ({ recent: [] })),
    recordSearchAction: vi.fn(async () => ({}))
}));

const requested: string[] = [];

// jsdom draws nothing, so it has no scrolling to do.
Element.prototype.scrollIntoView = () => undefined;

beforeEach(() => {
    requested.length = 0;
    pathname = "/chat";
    try {
        window.localStorage.clear();
    } catch {
        // No storage in this environment; the panel works without it.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
            requested.push(input);
            if (input.startsWith("/api/search/lookup")) {
                const scope = new URL(input, "http://x").searchParams.get("scope");
                return Response.json({
                    hits:
                        scope === "messages"
                            ? [
                                  {
                                      id: "m1",
                                      scope: "messages",
                                      label: "the release is out",
                                      detail: "Bo in Crew",
                                      href: "/chat/c/grp/m1"
                                  }
                              ]
                            : [
                                  {
                                      id: "u1",
                                      scope: "contacts",
                                      label: "Ana Ruiz",
                                      detail: "Message",
                                      href: "/chat/with/u1"
                                  },
                                  {
                                      id: "grp",
                                      scope: "chats",
                                      label: "Release crew",
                                      detail: "Group",
                                      href: "/chat/c/grp"
                                  }
                              ]
                });
            }
            return Response.json({ resources: [] });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function lookups(): string[] {
    return requested.filter((url) => url.startsWith("/api/search/lookup"));
}

describe("opened from Chat", () => {
    it("is narrowed to Chat, groups each kind, and filters without losing the words", async () => {
        render(<CommandPalette appIds={[]} />);
        act(() => openSearch("chat"));

        const field = await screen.findByRole("combobox");
        expect(screen.getByRole("radiogroup", { name: "What to find" })).toBeTruthy();
        fireEvent.change(field, { target: { value: "release" } });

        await waitFor(() =>
            expect(lookups().some((url) => url.includes("scope=chat&q=release"))).toBe(true)
        );
        expect(await screen.findByRole("group", { name: "People" })).toBeTruthy();
        expect(screen.getByRole("group", { name: "Conversations" })).toBeTruthy();

        fireEvent.click(screen.getByRole("radio", { name: "Messages" }));
        await waitFor(() =>
            expect(lookups().some((url) => url.includes("scope=messages&q=release"))).toBe(true)
        );
        const hit = await screen.findByRole("option", { name: "the release is out" });
        fireEvent.click(hit);
        expect(push).toHaveBeenCalledWith("/chat/c/grp/m1");
    });

    it("is Chat's switcher on Ctrl+K inside Chat, and the whole search elsewhere", async () => {
        render(<CommandPalette appIds={[]} />);
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        await screen.findByRole("combobox");
        expect(screen.getByRole("radiogroup", { name: "What to find" })).toBeTruthy();
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());

        pathname = "/tasks";
        cleanup();
        render(<CommandPalette appIds={[]} />);
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        await screen.findByRole("combobox");
        expect(screen.queryByRole("radiogroup", { name: "What to find" })).toBeNull();
    });

    it("ignores a request for a scope that does not exist", async () => {
        render(<CommandPalette appIds={[]} />);
        act(() => {
            window.dispatchEvent(
                new CustomEvent("polaris:open-search", { detail: { scope: "everything" } })
            );
        });
        await screen.findByRole("combobox");
        expect(screen.queryByRole("radiogroup", { name: "What to find" })).toBeNull();
    });
});

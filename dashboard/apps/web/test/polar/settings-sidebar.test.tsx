// @vitest-environment jsdom

/**
 * Polar's settings keep Polar's conversation list beside them, as /polar does:
 * a chat picked there opens on /polar, a new one starts there, and putting the
 * list away is the choice the chat page remembers.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsWithSidebar } from "@/app/(app)/polar/settings/settings-sidebar";

const pushed: string[] = [];
const kept = new Map<string, string>();

vi.mock("next/navigation", () => ({
    usePathname: () => "/polar/settings",
    useRouter: () => ({ push: (href: string) => void pushed.push(href), back: () => undefined })
}));

vi.mock("@/components/polar/use-polar-sidebar", () => ({
    usePolarSidebar: () => ({
        rows: [
            {
                id: "t1",
                title: "Trip to Lisbon",
                updatedAt: new Date().toISOString(),
                pinnedAt: null,
                archivedAt: null,
                projectId: null
            }
        ],
        projects: [],
        hasMore: () => false,
        isLoading: () => false,
        openProjects: new Set(),
        refresh: () => undefined,
        loadMore: () => undefined,
        know: () => undefined,
        retitle: () => undefined,
        remove: async () => undefined,
        toggleProject: () => undefined,
        openProject: () => undefined,
        createProject: async () => undefined,
        updateProject: async () => undefined,
        deleteProject: async () => undefined,
        rename: async () => undefined,
        setPinned: async () => undefined,
        setArchived: async () => undefined,
        move: async () => undefined
    })
}));

beforeEach(() => {
    pushed.length = 0;
    kept.clear();
    const storage = {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
        clear: () => kept.clear()
    };
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function draw() {
    return render(
        <SettingsWithSidebar>
            <h1>Polar settings</h1>
        </SettingsWithSidebar>,
        { wrapper: MessagesWrapper }
    );
}

describe("the settings page's conversation list", () => {
    it("lists the chats beside the settings", () => {
        draw();
        expect(screen.getByRole("navigation", { name: "Conversations" })).toBeTruthy();
        expect(screen.getByText("Trip to Lisbon")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Polar settings" })).toBeTruthy();
    });

    it("opens a chat on Polar's page", () => {
        draw();
        fireEvent.click(screen.getByText("Trip to Lisbon"));
        expect(pushed).toEqual(["/polar?thread=t1"]);
    });

    it("starts a new chat on Polar's page", () => {
        kept.set("polar.thread", "t1");
        draw();
        fireEvent.click(screen.getByText("New chat"));
        expect(pushed).toEqual(["/polar?new=1"]);
        expect(kept.get("polar.thread")).toBe("");
    });

    it("puts the list away and back, remembered like the chat page", () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
        expect(screen.queryByText("Trip to Lisbon")).toBeNull();
        expect(kept.get("polar.sidebar")).toBe("hidden");
        fireEvent.click(screen.getByRole("button", { name: "Show conversations" }));
        expect(screen.getByText("Trip to Lisbon")).toBeTruthy();
        expect(kept.get("polar.sidebar")).toBe("shown");
    });

    it("opens the list as a drawer on a narrow screen", async () => {
        vi.stubGlobal("matchMedia", (query: string) => ({
            matches: false,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }));
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Show conversations" }));
        const drawer = await screen.findByRole("dialog");
        fireEvent.click(within(drawer).getByText("Trip to Lisbon"));
        expect(pushed).toEqual(["/polar?thread=t1"]);
    });
});

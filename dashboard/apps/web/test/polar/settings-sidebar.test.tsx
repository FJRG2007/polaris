// @vitest-environment jsdom

/**
 * Polar's settings list their own pages beside them, as every Polaris app's
 * settings do: the page on screen is marked, a section left out (connectors for
 * an account they are closed to) is not offered, Back to chat leaves, and
 * putting the list away is the choice the chat page remembers. On a narrow
 * screen the list opens as a drawer.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsWithSidebar } from "@/app/(app)/polar/settings/settings-sidebar";
import { POLAR_SETTINGS_SECTIONS, settingsSection, type PolarSettingsSection } from "@/lib/polar/settings-path";

const kept = new Map<string, string>();
const at = { pathname: "/polar/settings/routing", wide: true };

vi.mock("next/navigation", () => ({
    usePathname: () => at.pathname,
    useRouter: () => ({ push: () => undefined, back: () => undefined })
}));
vi.mock("@/components/polar/use-wide", () => ({ useWide: () => at.wide }));

beforeEach(() => {
    at.pathname = settingsSection("routing");
    at.wide = true;
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

function draw(sections: readonly PolarSettingsSection[] = POLAR_SETTINGS_SECTIONS) {
    return render(
        <SettingsWithSidebar sections={sections}>
            <h1>Fallbacks page</h1>
        </SettingsWithSidebar>,
        { wrapper: MessagesWrapper }
    );
}

const pages = () => screen.getByRole("navigation", { name: "Polar settings" });

describe("the settings page's sidebar", () => {
    it("lists every settings page as a link to its own address", () => {
        draw();
        const links = within(pages()).getAllByRole("link");
        expect(links.map((link) => link.getAttribute("href"))).toEqual(
            POLAR_SETTINGS_SECTIONS.map((id) => settingsSection(id))
        );
        expect(screen.getByRole("heading", { name: "Fallbacks page" })).toBeTruthy();
    });

    it("marks the page on screen, and only that one", () => {
        draw();
        const current = within(pages())
            .getAllByRole("link")
            .filter((link) => link.getAttribute("aria-current") === "page");
        expect(current.map((link) => link.getAttribute("href"))).toEqual([settingsSection("routing")]);
    });

    it("does not offer a page the layout left out", () => {
        draw(POLAR_SETTINGS_SECTIONS.filter((id) => id !== "connectors"));
        const hrefs = within(pages())
            .getAllByRole("link")
            .map((link) => link.getAttribute("href"));
        expect(hrefs).not.toContain(settingsSection("connectors"));
    });

    it("leads back to the chat", () => {
        draw();
        expect(screen.getByRole("link", { name: "Back to chat" }).getAttribute("href")).toBe("/polar");
    });

    it("puts the list away and back, remembered like the chat page", () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
        expect(screen.queryByRole("navigation", { name: "Polar settings" })).toBeNull();
        expect([...kept.values()]).toContain("hidden");
        fireEvent.click(screen.getByRole("button", { name: "Show settings pages" }));
        expect(pages()).toBeTruthy();
        expect([...kept.values()]).toContain("shown");
    });

    it("opens the list as a drawer on a narrow screen", () => {
        at.wide = false;
        draw();
        // The rail itself is hidden by CSS below the breakpoint; the drawer is
        // what a narrow screen reaches.
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Show settings pages" }));
        const drawer = screen.getByRole("dialog");
        expect(within(drawer).getAllByRole("link").length).toBeGreaterThan(POLAR_SETTINGS_SECTIONS.length - 1);
    });
});

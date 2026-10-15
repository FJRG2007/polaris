// @vitest-environment jsdom
/**
 * Picking an Overview sidebar preset in account settings: the current one is
 * marked, an edited list reads as Custom, and picking writes the preset's
 * favorites through the app menu's own save.
 */

import type { ReactNode } from "react";
import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SIDEBAR_PRESETS } from "@/lib/setup/sidebar-presets";
import { SidebarPresetCard } from "@/components/setup/sidebar-preset-card";
import { FavoriteAppsContext, type FavoriteApps } from "@/components/favorite-apps-context";

afterEach(cleanup);

function draw(favorites: readonly string[], order: readonly string[] = []) {
    const replacePrefs = vi.fn();
    const value = {
        favorites,
        order,
        replacePrefs,
        arrangeApps: () => undefined,
        resetOrder: () => undefined,
        launcherOpen: false,
        setLauncherOpen: () => undefined,
        openLauncher: () => undefined
    } satisfies FavoriteApps;
    const wrap = (node: ReactNode) => (
        <FavoriteAppsContext.Provider value={value}>{node}</FavoriteAppsContext.Provider>
    );
    render(withMessages(wrap(<SidebarPresetCard />)));
    return replacePrefs;
}

describe("the sidebar preset card", () => {
    it("marks Default for an account that never picked one", () => {
        draw([]);
        const checked = screen
            .getAllByRole("radio")
            .filter((radio) => radio.getAttribute("aria-checked") === "true");
        expect(checked.map((radio) => radio.textContent)).toEqual([
            expect.stringMatching(/^Default/)
        ]);
    });

    it("writes the preset's apps as the favorites when one is picked", async () => {
        const user = userEvent.setup();
        const replacePrefs = draw([]);
        await user.click(screen.getByRole("radio", { name: /Team workspace/ }));
        expect(replacePrefs).toHaveBeenCalledWith({
            favorites: [...SIDEBAR_PRESETS.team],
            order: []
        });
    });

    it("is one Tab stop whose arrows move to and pick the next preset", async () => {
        const user = userEvent.setup();
        const replacePrefs = draw([]);
        await user.tab();
        expect(document.activeElement?.textContent).toMatch(/^Default/);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement?.textContent).toMatch(/^Hosting and deploys/);
        expect(replacePrefs).toHaveBeenCalledWith({
            favorites: [...SIDEBAR_PRESETS.hosting],
            order: []
        });
    });

    it("does nothing when the current preset is picked again", async () => {
        const user = userEvent.setup();
        const replacePrefs = draw([...SIDEBAR_PRESETS.team]);
        await user.click(screen.getByRole("radio", { name: /Team workspace/ }));
        expect(replacePrefs).not.toHaveBeenCalled();
    });

    it("says an edited list is custom, with none of the presets marked", () => {
        draw(["chat"]);
        expect(screen.getByText(/You arranged your own list/)).toBeTruthy();
        expect(
            screen
                .getAllByRole("radio")
                .some((radio) => radio.getAttribute("aria-checked") === "true")
        ).toBe(false);
    });
});

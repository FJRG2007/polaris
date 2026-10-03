// @vitest-environment jsdom

/**
 * The dialog that arranges favorites with a button instead of a drag - the
 * keyboard and touch way to do what dragging a tile in the app menu does with a
 * mouse (see `arrange-favorites-dialog`).
 *
 * What is asserted: favorites are listed in their order with move-up and
 * move-down buttons that call `arrange` with the reordered list and disable at
 * each end; an X unpins through `toggle`; apps that are not favorites and not
 * locked are offered below with a way to pin them; a locked app never is; and
 * the empty state shows when there are no favorites.
 */

import { withMessages } from "../setup/i18n";
import type { PolarisApp } from "@polaris/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Gamepad2, HardDrive, MessageCircle, Mail } from "lucide-react";
import { ArrangeFavoritesDialog } from "@/components/arrange-favorites-dialog";
import { FavoriteAppsContext, type FavoriteApps } from "@/components/favorite-apps-context";

afterEach(cleanup);

const APPS: PolarisApp[] = [
    { id: "drive", label: "Drive", icon: HardDrive, href: "/drive" },
    { id: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
    { id: "games", label: "Game servers", icon: Gamepad2, href: "/apps/games" },
    { id: "mail", label: "Mail", icon: Mail, href: "/mail", locked: true }
];

function renderDialog(favorites: readonly string[], overrides: Partial<FavoriteApps> = {}) {
    const toggle = vi.fn();
    const arrange = vi.fn();
    const value: FavoriteApps = {
        favorites,
        toggle,
        arrange,
        launcherOpen: false,
        setLauncherOpen: () => undefined,
        openLauncher: () => undefined,
        ...overrides
    };
    render(
        withMessages(
            <FavoriteAppsContext.Provider value={value}>
                <ArrangeFavoritesDialog open onOpenChange={() => undefined} apps={APPS} />
            </FavoriteAppsContext.Provider>
        )
    );
    return { toggle, arrange };
}

describe("the arrange favorites dialog", () => {
    it("lists favorites in order, each with a way to move it and unpin it", () => {
        renderDialog(["chat", "drive"]);
        const rows = screen.getAllByRole("listitem");
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining("Chat"),
            expect.stringContaining("Drive"),
            expect.stringContaining("Game servers")
        ]);
        expect(screen.getByRole("button", { name: "Move Chat earlier" }).getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByRole("button", { name: "Move Drive later" }).getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByRole("button", { name: "Move Chat later" }).getAttribute("aria-disabled")).toBeNull();
        expect(screen.getByRole("button", { name: "Move Drive earlier" }).getAttribute("aria-disabled")).toBeNull();
    });

    it("moves a favorite later and keeps the rest in place", async () => {
        const { arrange } = renderDialog(["chat", "drive"]);
        await screen.getByRole("button", { name: "Move Chat later" }).click();
        expect(arrange).toHaveBeenCalledWith(["drive", "chat"]);
    });

    it("moves a favorite earlier", async () => {
        const { arrange } = renderDialog(["chat", "drive"]);
        await screen.getByRole("button", { name: "Move Drive earlier" }).click();
        expect(arrange).toHaveBeenCalledWith(["drive", "chat"]);
    });

    it("does nothing when a disabled move button is clicked anyway", async () => {
        const { arrange } = renderDialog(["chat", "drive"]);
        await screen.getByRole("button", { name: "Move Chat earlier" }).click();
        expect(arrange).not.toHaveBeenCalled();
    });

    it("unpins a favorite through toggle, not arrange", async () => {
        const { toggle, arrange } = renderDialog(["chat", "drive"]);
        await screen.getByRole("button", { name: "Remove Chat from favorites" }).click();
        expect(toggle).toHaveBeenCalledWith("chat");
        expect(arrange).not.toHaveBeenCalled();
    });

    it("offers every other reachable app below, but never a locked one", () => {
        renderDialog(["chat"]);
        expect(screen.getByText("Other apps")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Add Drive to favorites" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Add Game servers to favorites" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Add Mail to favorites" })).toBeNull();
    });

    it("pins an app from the other-apps list through toggle", async () => {
        const { toggle } = renderDialog(["chat"]);
        await screen.getByRole("button", { name: "Add Drive to favorites" }).click();
        expect(toggle).toHaveBeenCalledWith("drive");
    });

    it("shows the empty state and nothing to move when there are no favorites", () => {
        renderDialog([]);
        expect(screen.getByText("No favorites yet. Add one below.")).toBeTruthy();
        expect(document.querySelector("ol")).toBeNull();
    });

    it("reads in Spanish", () => {
        render(
            withMessages(
                <FavoriteAppsContext.Provider
                    value={{
                        favorites: ["chat"],
                        toggle: () => undefined,
                        arrange: () => undefined,
                        launcherOpen: false,
                        setLauncherOpen: () => undefined,
                        openLauncher: () => undefined
                    }}
                >
                    <ArrangeFavoritesDialog open onOpenChange={() => undefined} apps={APPS} />
                </FavoriteAppsContext.Provider>,
                "es-ES"
            )
        );
        expect(screen.getByText("Ordenar favoritos")).toBeTruthy();
        expect(screen.getByText("Otras apps")).toBeTruthy();
    });
});

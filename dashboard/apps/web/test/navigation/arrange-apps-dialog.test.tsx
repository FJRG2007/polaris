// @vitest-environment jsdom

/**
 * The dialog that arranges the app menu with buttons instead of a drag - the
 * touch and screen-reader way to do what dragging a tile in the menu does with
 * a mouse (see `arrange-apps-dialog`).
 *
 * What is asserted: every app is listed in the menu's order with move-up and
 * move-down buttons that call `arrangeApps` with the reordered list and disable
 * at each end; there is no star on any row; an order changed elsewhere keeps
 * the rows where they are until a move reorders them; the way back to the
 * automatic order shows only once the menu was arranged; and it reads in
 * Spanish.
 */

import { withMessages } from "../setup/i18n";
import type { PolarisApp } from "@polaris/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ArrangeAppsDialog } from "@/components/arrange-apps-dialog";
import { Gamepad2, HardDrive, MessageCircle, Mail } from "lucide-react";
import { FavoriteAppsContext, type FavoriteApps } from "@/components/favorite-apps-context";

afterEach(cleanup);

const APPS: PolarisApp[] = [
    { id: "drive", label: "Drive", icon: HardDrive, href: "/drive" },
    { id: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
    { id: "games", label: "Game servers", icon: Gamepad2, href: "/apps/games" },
    { id: "mail", label: "Mail", icon: Mail, href: "/mail", locked: true }
];

const ORDER = ["chat", "drive", "games", "mail"];

function store(overrides: Partial<FavoriteApps> = {}): FavoriteApps {
    return {
        favorites: [],
        order: [],
        arrangeApps: vi.fn(),
        resetOrder: vi.fn(),
        launcherOpen: false,
        setLauncherOpen: () => undefined,
        openLauncher: () => undefined,
        ...overrides
    };
}

function renderDialog(overrides: Partial<FavoriteApps> = {}, locale?: "es-ES") {
    const value = store(overrides);
    render(
        withMessages(
            <FavoriteAppsContext.Provider value={value}>
                <ArrangeAppsDialog open onOpenChange={() => undefined} apps={APPS} order={ORDER} />
            </FavoriteAppsContext.Provider>,
            locale
        )
    );
    return value;
}

describe("the arrange apps dialog", () => {
    it("lists every app in the menu's order, each with a way to move it", () => {
        renderDialog();
        const rows = screen.getAllByRole("listitem");
        expect(rows.map((row) => row.textContent)).toEqual([
            "Chat",
            "Drive",
            "Game servers",
            "Mail"
        ]);
        expect(
            screen.getByRole("button", { name: "Move Chat earlier" }).getAttribute("aria-disabled")
        ).toBe("true");
        expect(
            screen.getByRole("button", { name: "Move Mail later" }).getAttribute("aria-disabled")
        ).toBe("true");
        expect(
            screen.getByRole("button", { name: "Move Chat later" }).getAttribute("aria-disabled")
        ).toBeNull();
    });

    it("moves an app later and earlier as the whole order", () => {
        const { arrangeApps } = renderDialog();
        screen.getByRole("button", { name: "Move Chat later" }).click();
        expect(arrangeApps).toHaveBeenCalledWith(["drive", "chat", "games", "mail"]);
        screen.getByRole("button", { name: "Move Game servers earlier" }).click();
        expect(arrangeApps).toHaveBeenLastCalledWith(["chat", "games", "drive", "mail"]);
    });

    it("does nothing when a disabled move button is clicked anyway", () => {
        const { arrangeApps } = renderDialog();
        screen.getByRole("button", { name: "Move Chat earlier" }).click();
        expect(arrangeApps).not.toHaveBeenCalled();
    });

    it("offers moving and nothing else - no star on any row", () => {
        renderDialog({ favorites: ["chat"] });
        expect(screen.queryByRole("button", { name: /favorites/i })).toBeNull();
        for (const row of screen.getAllByRole("listitem")) {
            expect(within(row).getAllByRole("button")).toHaveLength(2);
        }
    });

    it("keeps the rows in place when the menu's order changes elsewhere, until a move", () => {
        const value = store();
        const tree = (order: string[], arranged: readonly string[] = value.order) =>
            withMessages(
                <FavoriteAppsContext.Provider value={{ ...value, order: arranged }}>
                    <ArrangeAppsDialog
                        open
                        onOpenChange={() => undefined}
                        apps={APPS}
                        order={order}
                    />
                </FavoriteAppsContext.Provider>
            );
        const labels = () => screen.getAllByRole("listitem").map((row) => row.textContent);
        const { rerender } = render(tree(ORDER));
        rerender(tree(["games", "chat", "drive", "mail"]));
        expect(labels()).toEqual(["Chat", "Drive", "Game servers", "Mail"]);
        rerender(tree(["drive", "chat", "games", "mail"], ["drive", "chat", "games", "mail"]));
        expect(labels()).toEqual(["Drive", "Chat", "Game servers", "Mail"]);
    });

    it("offers the automatic order back only once the menu was arranged", () => {
        renderDialog();
        expect(screen.queryByRole("button", { name: "Use automatic order" })).toBeNull();
        cleanup();
        const { resetOrder } = renderDialog({ order: ["drive"] });
        screen.getByRole("button", { name: "Use automatic order" }).click();
        expect(resetOrder).toHaveBeenCalled();
    });

    it("reads in Spanish", () => {
        renderDialog({ order: ["drive"] }, "es-ES");
        expect(screen.getByText("Ordenar apps")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Usar orden automático" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Subir Drive" })).toBeTruthy();
    });
});

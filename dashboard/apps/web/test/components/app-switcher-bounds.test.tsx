// @vitest-environment jsdom

/**
 * The app switcher on a phone. Its list of apps can be taller than the screen,
 * and its surface clipped what did not fit - so the bottom half of the list
 * could not be reached. Menus now keep off the edge and scroll inside what is
 * left of the screen. The grid it draws now carries no descriptions, so a long
 * one can no longer push a tile off the side either.
 */

import { AppSwitcher } from "@polaris/ui";
import { Bell, Files, Mail } from "lucide-react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

afterEach(cleanup);

const APPS = [
    {
        id: "drive",
        label: "Drive",
        description: "Files across every NAS",
        icon: Files,
        href: "/drive"
    },
    {
        id: "mail",
        label: "Mail",
        description: "Your mailboxes, read and answered here",
        icon: Mail,
        href: "/mail"
    },
    {
        id: "watch",
        label: "Watch",
        description: "Alarms on app health, spikes and outages",
        icon: Bell,
        href: "/watch"
    }
];

describe("the app switcher's surface", () => {
    it("scrolls within the screen instead of clipping, and draws no descriptions", async () => {
        render(<AppSwitcher apps={APPS} currentAppId="drive" />);
        await userEvent.click(screen.getByRole("button"));
        const menu = await screen.findByRole("menu");
        const classes = menu.className;
        expect(classes).toContain("max-h-[--radix-dropdown-menu-content-available-height]");
        expect(classes).toContain("max-w-[--radix-dropdown-menu-content-available-width]");
        expect(classes).toContain("overflow-y-auto");
        expect(classes).not.toContain("overflow-hidden");
        expect(menu.textContent).not.toContain("Your mailboxes, read and answered here");
        // Long names cut at the tile's edge rather than widening it.
        expect(screen.getByText("Mail").className).toContain("truncate");
        expect(screen.getAllByRole("menuitem")).toHaveLength(APPS.length);
    });

    it("keeps thirty-two apps with long names inside a phone's width", async () => {
        const many = Array.from({ length: 32 }, (_, at) => ({
            id: `fixture-${at}`,
            label: `Fixture application with a very long name ${at}`,
            icon: Files,
            href: `/fixture-${at}`
        }));
        render(<AppSwitcher apps={many} currentAppId="fixture-0" />);
        await userEvent.click(screen.getByRole("button"));
        const menu = await screen.findByRole("menu");
        // 19.5rem is 312px: inside a 390px screen with its 16px gutters, and
        // never wider than what is left of the screen.
        expect(menu.className).toContain("w-[19.5rem]");
        expect(menu.className).toContain("max-w-[--radix-dropdown-menu-content-available-width]");
        const grid = menu.querySelector("[data-launcher-grid]")!;
        expect(grid.className).toContain("grid-cols-3");
        const first = menu.querySelector<HTMLElement>('[data-launcher-tile="fixture-0"]')!;
        // The name is cut at the tile's edge, and the whole of it is on hover.
        expect(first.getAttribute("title")).toBe(many[0]!.label);
        expect(first.parentElement?.className).toContain("min-w-0");
        expect(first.className).toContain("min-w-0");
        expect(within(first).getByText(many[0]!.label).className).toContain("truncate");
    });
});

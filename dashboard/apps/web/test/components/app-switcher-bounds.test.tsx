// @vitest-environment jsdom

/**
 * The app switcher on a phone. It lists every app with a line under each, which
 * is taller than the screen, and its surface clipped what did not fit - so the
 * bottom half of the list could not be reached. Menus now keep off the edge and
 * scroll inside what is left of the screen.
 */

import { AppSwitcher } from "@polaris/ui";
import { Bell, Files, Mail } from "lucide-react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
    it("scrolls within the screen instead of clipping, and wraps long descriptions", async () => {
        render(<AppSwitcher apps={APPS} currentAppId="drive" />);
        await userEvent.click(screen.getByRole("button"));
        const menu = await screen.findByRole("menu");
        const classes = menu.className;
        expect(classes).toContain("max-h-[--radix-dropdown-menu-content-available-height]");
        expect(classes).toContain("max-w-[--radix-dropdown-menu-content-available-width]");
        expect(classes).toContain("overflow-y-auto");
        expect(classes).not.toContain("overflow-hidden");
        const description = screen.getByText("Your mailboxes, read and answered here");
        expect(description.parentElement?.className).toContain("min-w-0");
        expect(screen.getAllByRole("menuitem")).toHaveLength(APPS.length);
    });
});

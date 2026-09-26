// @vitest-environment jsdom

/**
 * The switcher opened: a grid of icons and names, the top row above the rest,
 * and a star that pins an app without closing the menu.
 */

import { AppSwitcher } from "@polaris/ui";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gamepad2, HardDrive, MessageCircle } from "lucide-react";
import { cleanup, render, screen, within } from "@testing-library/react";

afterEach(cleanup);

const APPS = [
    { id: "drive", label: "Drive", description: "Files across every NAS", icon: HardDrive, href: "/drive" },
    { id: "chat", label: "Chat", description: "Channels", icon: MessageCircle, href: "/chat", badge: "3" },
    { id: "games", label: "Game servers", description: "Servers", icon: Gamepad2, href: "/apps/games" }
];

describe("the app switcher grid", () => {
    it("shows the top row first, every app once, and no descriptions", async () => {
        const user = userEvent.setup();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                featured={["games"]}
                featuredLabel="Favorites"
                pinned={["games"]}
                onTogglePin={() => undefined}
            />
        );
        await user.click(screen.getByRole("button", { name: /drive/i }));
        const menu = await screen.findByRole("menu");
        const links = within(menu).getAllByRole("menuitem").filter((item) => item.tagName === "A");
        expect(links.map((link) => link.textContent)).toEqual(["Game servers", "Drive", "3Chat"]);
        expect(within(menu).getByText("Favorites")).toBeTruthy();
        expect(within(menu).getByText("More apps")).toBeTruthy();
        expect(menu.textContent).not.toContain("Files across every NAS");
        expect(within(menu).getByRole("menuitem", { name: "Remove Game servers from favorites" })).toBeTruthy();
    });

    it("pins an app from its star and keeps the menu open", async () => {
        const user = userEvent.setup();
        const onTogglePin = vi.fn();
        render(<AppSwitcher apps={APPS} currentAppId="drive" featured={[]} onTogglePin={onTogglePin} />);
        await user.click(screen.getByRole("button", { name: /drive/i }));
        await user.click(await screen.findByRole("menuitem", { name: "Add Chat to favorites" }));
        expect(onTogglePin).toHaveBeenCalledWith("chat");
        expect(screen.getByRole("menu")).toBeTruthy();
    });
});

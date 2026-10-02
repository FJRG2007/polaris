// @vitest-environment jsdom

/**
 * The switcher opened: a grid of icons and names under their headings, a search
 * that narrows it, arrow keys that walk it as a grid, a star that pins an app
 * without closing the menu, and favorites that move with Alt and an arrow.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gamepad2, HardDrive, MessageCircle } from "lucide-react";
import { AppSwitcher, type AppSwitcherSection } from "@polaris/ui";
import { cleanup, render, screen, within } from "@testing-library/react";

afterEach(cleanup);

const APPS = [
    {
        id: "drive",
        label: "Drive",
        description: "Files across every NAS",
        icon: HardDrive,
        href: "/drive"
    },
    {
        id: "chat",
        label: "Chat",
        description: "Channels",
        icon: MessageCircle,
        href: "/chat",
        badge: "3"
    },
    {
        id: "games",
        label: "Game servers",
        description: "Servers",
        icon: Gamepad2,
        href: "/apps/games",
        keywords: ["Juegos"]
    }
];

/** Thirty-two apps on six shelves, for the grid's geometry. */
const MANY = Array.from({ length: 32 }, (_, at) => ({
    id: `app-${at + 1}`,
    label: `App ${at + 1}`,
    icon: HardDrive,
    href: `/app-${at + 1}`
}));
const MANY_SECTIONS: AppSwitcherSection[] = [
    { key: "favorites", label: "Favorites", ids: ["app-1", "app-2", "app-3", "app-4"], arrangeable: true },
    { key: "work", label: "Work", ids: MANY.slice(4, 18).map((app) => app.id) },
    { key: "tools", label: "Tools", ids: MANY.slice(18).map((app) => app.id) }
];

const tile = (id: string) => document.querySelector<HTMLElement>(`[data-launcher-tile="${id}"]`);

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await user.click(screen.getByRole("button", { name }));
    return screen.findByRole("menu");
}

describe("the app switcher grid", () => {
    it("draws its sections in order under their headings, every app once, with no descriptions", async () => {
        const user = userEvent.setup();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                sections={[
                    { key: "favorites", label: "Favorites", ids: ["games"] },
                    { key: "work", label: "Work", ids: ["drive", "chat"] }
                ]}
                pinned={["games"]}
                onTogglePin={() => undefined}
            />
        );
        const menu = await openMenu(user, /drive/i);
        const links = within(menu)
            .getAllByRole("menuitem")
            .filter((item) => item.tagName === "A");
        expect(links.map((link) => link.textContent)).toEqual(["Game servers", "Drive", "3Chat"]);
        expect(within(menu).getByText("Favorites")).toBeTruthy();
        expect(within(menu).getByText("Work")).toBeTruthy();
        expect(menu.textContent).not.toContain("Files across every NAS");
        expect(
            within(menu).getByRole("menuitem", { name: "Remove Game servers from favorites" })
        ).toBeTruthy();
    });

    it("pins an app from its star and keeps the menu open", async () => {
        const user = userEvent.setup();
        const onTogglePin = vi.fn();
        render(<AppSwitcher apps={APPS} currentAppId="drive" onTogglePin={onTogglePin} />);
        await openMenu(user, /drive/i);
        await user.click(await screen.findByRole("menuitem", { name: "Add Chat to favorites" }));
        expect(onTogglePin).toHaveBeenCalledWith("chat");
        expect(screen.getByRole("menu")).toBeTruthy();
    });
});

describe("searching the app switcher", () => {
    it("takes the keyboard as it opens and narrows every app to the ones that match", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={APPS} currentAppId="drive" />);
        await openMenu(user, /drive/i);
        const field = await screen.findByRole("textbox", { name: "Search apps" });
        await vi.waitFor(() => expect(document.activeElement).toBe(field));
        await user.type(field, "chat");
        expect(tile("chat")).toBeTruthy();
        expect(tile("drive")).toBeNull();
        expect(tile("games")).toBeNull();
    });

    it("finds an app by a keyword it is never drawn with", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={APPS} currentAppId="drive" />);
        await openMenu(user, /drive/i);
        await user.type(await screen.findByRole("textbox", { name: "Search apps" }), "juegos");
        expect(tile("games")).toBeTruthy();
        expect(tile("drive")).toBeNull();
    });

    it("forgives a typo in a name but answers nothing for a word no app carries", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={APPS} currentAppId="drive" />);
        await openMenu(user, /drive/i);
        const field = await screen.findByRole("textbox", { name: "Search apps" });
        await user.type(field, "drvie");
        expect(tile("drive")).toBeTruthy();
        await user.clear(field);
        await user.type(field, "spreadsheet");
        expect(document.querySelectorAll("[data-launcher-tile]")).toHaveLength(0);
        expect(screen.getByText("No app matches spreadsheet")).toBeTruthy();
    });
});

describe("walking the app switcher with the keyboard", () => {
    it("moves along the grid, a row at a time, and across a heading at the same column", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" sections={MANY_SECTIONS} />);
        await openMenu(user, /app 1/i);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-1"));
        await user.keyboard("{ArrowRight}");
        expect(document.activeElement).toBe(tile("app-2"));
        // Favorites run app-1..3 on the first row and app-4 alone on the second.
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-4"));
        // Out of the favorites into Work, same column as far as it goes.
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-5"));
        await user.keyboard("{ArrowRight}{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-9"));
        await user.keyboard("{End}");
        expect(document.activeElement).toBe(tile("app-32"));
        await user.keyboard("{Home}{ArrowUp}");
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search apps" }));
    });

    it("reaches each app's star with tab", async () => {
        const user = userEvent.setup();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                sections={[{ key: "all", label: "", ids: ["drive", "chat", "games"] }]}
                onTogglePin={() => undefined}
            />
        );
        await openMenu(user, /drive/i);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("drive"));
        await user.keyboard("{Tab}");
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Add Drive to favorites");
        await user.keyboard("{Tab}");
        expect(document.activeElement).toBe(tile("chat"));
    });

    it("moves a favorite with Alt and an arrow, says where it went, and keeps it focused", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(
            <AppSwitcher
                apps={MANY}
                currentAppId="app-1"
                sections={MANY_SECTIONS}
                onArrange={onArrange}
            />
        );
        await openMenu(user, /app 1/i);
        await user.keyboard("{ArrowDown}{Alt>}{ArrowRight}{/Alt}");
        expect(onArrange).toHaveBeenCalledWith(["app-2", "app-1", "app-3", "app-4"]);
        expect(document.activeElement).toBe(tile("app-1"));
        expect(screen.getByText("App 1 moved to position 2 of 4")).toBeTruthy();
    });

    it("does not move an app that is not a favorite, nor one already at the end", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(
            <AppSwitcher
                apps={MANY}
                currentAppId="app-1"
                sections={MANY_SECTIONS}
                onArrange={onArrange}
            />
        );
        await openMenu(user, /app 1/i);
        await user.keyboard("{ArrowDown}{Alt>}{ArrowLeft}{/Alt}");
        await user.keyboard("{ArrowDown}{ArrowDown}{Alt>}{ArrowRight}{/Alt}");
        expect(onArrange).not.toHaveBeenCalled();
    });
});

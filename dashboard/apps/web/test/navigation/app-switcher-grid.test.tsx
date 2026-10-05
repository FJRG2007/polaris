// @vitest-environment jsdom

/**
 * The switcher opened: one grid of icons and names with no headings, the first
 * screenful and a More button for the rest, a search that reaches every app,
 * arrow keys that walk it as a grid, and an order that moves with a drag or with
 * Alt and an arrow - which is the whole of arranging it: no star on any tile.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSwitcher, DropdownMenuItem } from "@polaris/ui";
import { Gamepad2, HardDrive, MessageCircle } from "lucide-react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

/** Thirty-two apps, for the grid's geometry and the More button. */
const MANY = Array.from({ length: 32 }, (_, at) => ({
    id: `app-${at + 1}`,
    label: `App ${at + 1}`,
    icon: HardDrive,
    href: `/app-${at + 1}`
}));
const MANY_IDS = MANY.map((app) => app.id);

const tile = (id: string) => document.querySelector<HTMLElement>(`[data-launcher-tile="${id}"]`);
const tiles = () =>
    [...document.querySelectorAll<HTMLElement>("[data-launcher-tile]")].map((node) =>
        node.getAttribute("data-launcher-tile")
    );

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await user.click(screen.getByRole("button", { name }));
    return screen.findByRole("menu");
}

/** What a drag carries, for jsdom, which has no DataTransfer of its own. */
function transfer() {
    return { setData: () => undefined, getData: () => "", effectAllowed: "", dropEffect: "" };
}

describe("the app switcher grid", () => {
    it("draws one grid in the order given, every app once, with no headings or descriptions", async () => {
        const user = userEvent.setup();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                order={["games", "drive", "chat"]}
                onArrange={() => undefined}
            />
        );
        const menu = await openMenu(user, /drive/i);
        const links = within(menu)
            .getAllByRole("menuitem")
            .filter((item) => item.tagName === "A");
        expect(links.map((link) => link.textContent)).toEqual(["Game servers", "Drive", "3Chat"]);
        expect(menu.querySelectorAll("[data-launcher-grid]")).toHaveLength(1);
        expect(within(menu).queryByRole("group")).toBeNull();
        expect(within(menu).queryByText("Favorites")).toBeNull();
        expect(within(menu).queryByText("Recent")).toBeNull();
        expect(menu.textContent).not.toContain("Files across every NAS");
        // Arranged by dragging alone: no star, on any tile.
        expect(within(menu).queryByRole("menuitem", { name: /favorites/i })).toBeNull();
        expect(menu.querySelector("[data-launcher-star]")).toBeNull();
    });

    it("shows no More button when every app fits the first screen", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={APPS} currentAppId="drive" />);
        await openMenu(user, /drive/i);
        expect(screen.queryByRole("menuitem", { name: "More" })).toBeNull();
    });
});

describe("the More button", () => {
    it("draws the first twelve apps, and the rest in the same grid when pressed", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" />);
        await openMenu(user, /app 1/i);
        expect(tiles()).toEqual(MANY_IDS.slice(0, 12));
        await user.click(screen.getByRole("menuitem", { name: "More" }));
        expect(tiles()).toEqual(MANY_IDS);
        expect(document.querySelectorAll("[data-launcher-grid]")).toHaveLength(1);
        expect(screen.queryByRole("menuitem", { name: "More" })).toBeNull();
        expect(document.activeElement).toBe(tile("app-13"));
        expect(screen.getByRole("menu")).toBeTruthy();
    });

    it("is reached from the last row, and back", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" />);
        await openMenu(user, /app 1/i);
        const more = screen.getByRole("menuitem", { name: "More" });
        await user.keyboard("{ArrowDown}{End}{ArrowDown}");
        expect(document.activeElement).toBe(more);
        await user.keyboard("{ArrowUp}");
        expect(document.activeElement).toBe(tile("app-12"));
    });

    it("folds the rest away again once the menu closes", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" />);
        await openMenu(user, /app 1/i);
        await user.click(screen.getByRole("menuitem", { name: "More" }));
        await user.keyboard("{Escape}");
        await openMenu(user, /app 1/i);
        expect(tiles()).toHaveLength(12);
    });

    it("does not hide an app from the search", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" />);
        await openMenu(user, /app 1/i);
        await user.type(screen.getByRole("textbox", { name: "Search apps" }), "App 30");
        expect(tile("app-30")).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "More" })).toBeNull();
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
    it("moves along the grid and a row at a time", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" />);
        await openMenu(user, /app 1/i);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-1"));
        await user.keyboard("{ArrowRight}");
        expect(document.activeElement).toBe(tile("app-2"));
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-5"));
        await user.keyboard("{ArrowRight}{ArrowDown}");
        expect(document.activeElement).toBe(tile("app-9"));
        await user.keyboard("{End}");
        expect(document.activeElement).toBe(tile("app-12"));
        await user.keyboard("{Home}{ArrowUp}");
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search apps" }));
    });

    it("walks tile to tile with tab", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={APPS} currentAppId="drive" onArrange={() => undefined} />);
        await openMenu(user, /drive/i);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(tile("drive"));
        await user.keyboard("{Tab}");
        expect(document.activeElement).toBe(tile("chat"));
        await user.keyboard("{Shift>}{Tab}{/Shift}");
        expect(document.activeElement).toBe(tile("drive"));
    });

    it("goes on to the options under the grid from the last row and the last tab stop", async () => {
        const user = userEvent.setup();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                footer={<DropdownMenuItem>Arrange apps</DropdownMenuItem>}
            />
        );
        await openMenu(user, /drive/i);
        const arrange = screen.getByRole("menuitem", { name: "Arrange apps" });
        await user.keyboard("{ArrowDown}{End}{ArrowDown}");
        expect(document.activeElement).toBe(arrange);
        tile("games")?.focus();
        await user.keyboard("{Tab}");
        expect(document.activeElement).toBe(arrange);
    });

    it("tabs from the last tile to More while there is more", async () => {
        const user = userEvent.setup();
        render(
            <AppSwitcher
                apps={MANY}
                currentAppId="app-1"
                footer={<DropdownMenuItem>Arrange apps</DropdownMenuItem>}
            />
        );
        await openMenu(user, /app 1/i);
        tile("app-12")?.focus();
        await user.keyboard("{Tab}");
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "More" }));
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Arrange apps" }));
    });
});

describe("arranging the app switcher", () => {
    it("moves an app with Alt and an arrow, says where it went, and keeps it focused", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" onArrange={onArrange} />);
        await openMenu(user, /app 1/i);
        await user.keyboard("{ArrowDown}{Alt>}{ArrowRight}{/Alt}");
        expect(onArrange).toHaveBeenCalledWith(["app-2", "app-1", ...MANY_IDS.slice(2)]);
        expect(document.activeElement).toBe(tile("app-1"));
        expect(screen.getByText("App 1 moved to position 2 of 32")).toBeTruthy();
    });

    it("opens the rest when an app is moved past the first screen", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" onArrange={onArrange} />);
        await openMenu(user, /app 1/i);
        tile("app-11")?.focus();
        await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
        const next = [...MANY_IDS];
        next.splice(10, 1);
        next.splice(13, 0, "app-11");
        expect(onArrange).toHaveBeenCalledWith(next);
        expect(tiles()).toHaveLength(32);
        expect(document.activeElement).toBe(tile("app-11"));
    });

    it("advertises every move an app makes", async () => {
        const user = userEvent.setup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" onArrange={() => undefined} />);
        await openMenu(user, /app 1/i);
        expect(tile("app-1")?.getAttribute("aria-keyshortcuts")).toBe(
            "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
        );
    });

    it("does not move an app already at the start, nor any app when it cannot be arranged", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" onArrange={onArrange} />);
        await openMenu(user, /app 1/i);
        await user.keyboard("{ArrowDown}{Alt>}{ArrowLeft}{ArrowUp}{/Alt}");
        expect(onArrange).not.toHaveBeenCalled();
        cleanup();
        render(<AppSwitcher apps={MANY} currentAppId="app-1" />);
        await openMenu(user, /app 1/i);
        expect(tile("app-1")?.hasAttribute("aria-keyshortcuts")).toBe(false);
        expect(tile("app-1")?.getAttribute("draggable")).toBe("false");
    });

    it("moves an app dropped onto another, making room as it passes", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                order={["drive", "chat", "games"]}
                onArrange={onArrange}
            />
        );
        await openMenu(user, /drive/i);
        const data = transfer();
        fireEvent.dragStart(tile("games")!, { dataTransfer: data });
        fireEvent.dragOver(tile("drive")!, { dataTransfer: data });
        expect(tiles()).toEqual(["games", "drive", "chat"]);
        fireEvent.drop(tile("drive")!, { dataTransfer: data });
        fireEvent.dragEnd(tile("games")!, { dataTransfer: data });
        expect(onArrange).toHaveBeenCalledWith(["games", "drive", "chat"]);
    });

    it("puts the grid back when a drag is let go outside it", async () => {
        const user = userEvent.setup();
        const onArrange = vi.fn();
        render(
            <AppSwitcher
                apps={APPS}
                currentAppId="drive"
                order={["drive", "chat", "games"]}
                onArrange={onArrange}
            />
        );
        await openMenu(user, /drive/i);
        const data = transfer();
        fireEvent.dragStart(tile("games")!, { dataTransfer: data });
        fireEvent.dragOver(tile("drive")!, { dataTransfer: data });
        fireEvent.dragEnd(tile("games")!, { dataTransfer: data });
        expect(onArrange).not.toHaveBeenCalled();
        expect(tiles()).toEqual(["drive", "chat", "games"]);
    });
});

describe("opening the app switcher on a touch screen", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("leaves the search unfocused when the menu is opened from elsewhere", async () => {
        vi.stubGlobal("matchMedia", (query: string) => ({
            matches: query === "(pointer: coarse)",
            media: query,
            addEventListener() {},
            removeEventListener() {}
        }));
        render(
            <AppSwitcher apps={APPS} currentAppId="drive" open onOpenChange={() => undefined} />
        );
        const field = await screen.findByRole("textbox", { name: "Search apps" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(document.activeElement).not.toBe(field);
    });
});

// @vitest-environment jsdom

/**
 * Choosing several players at once, and the menus a player row opens.
 *
 * The players table takes the keys Drive's file list takes - a press chooses
 * that row alone, Shift stretches, Ctrl (Cmd) adds, Ctrl+A takes every row and
 * Escape lets go - and a right press on one of several chosen rows offers only
 * what all of them can take. A single row keeps its own menu, where the game
 * mode is one entry with the modes behind it, the current one ticked, and the
 * bag can be exported or imported without opening the editor first.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MinecraftStatus } from "@polaris-app/game-servers/src/lib/minecraft/service";
import { MinecraftPlayers } from "@polaris-app/game-servers/src/screens/installed/minecraft-players";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({}));
// Reached through the row dialogs' imports; nothing here signs anybody in.
vi.mock("@/lib/session", () => ({}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));

const SERVER = "00000000-0000-4000-8000-000000000001";
const NAMES = ["Steve", "Alex", "Notch"];

const STATUS: MinecraftStatus = {
    edition: "java",
    running: true,
    containerRunning: true,
    crashLoop: null,
    answering: true,
    players: { online: 2, max: 20, players: ["Steve", "Alex"] },
    address: "mc.example.com",
    message: null,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null
};

function Players() {
    return (
        <MinecraftPlayers
            installedAppId={SERVER}
            status={STATUS}
            roster={{ ops: [], whitelist: NAMES, bans: [], whitelistEnforced: true }}
            rosterAsOf={null}
            access={{
                rules: [],
                bindAddresses: true,
                addressesAvailable: true,
                edition: "java",
                refusals: [],
                links: []
            }}
            sessions={[]}
            seen={{}}
            now={Date.now()}
            timeouts={[]}
            levels={{}}
            lastLevels={{}}
            pending={[]}
            passwords={null}
            modes={{ Steve: "creative", Alex: "survival" }}
            onPasswordsChanged={vi.fn()}
            onChanged={vi.fn()}
        />
    );
}

function row(name: string): HTMLElement {
    const found = screen.getByTitle(name).closest("tr");
    if (!found) throw new Error(`no row for ${name}`);
    return found;
}

/** The player rows in the order they are drawn. */
function drawnRows(): HTMLElement[] {
    return screen.getAllByRole("row").filter((one) => one.hasAttribute("aria-selected"));
}

function chosen(): string[] {
    return NAMES.filter((name) => row(name).getAttribute("aria-selected") === "true");
}

/** A press on the row's name cell, which is not a control. */
function press(name: string, keys: { shiftKey?: boolean; ctrlKey?: boolean } = {}): void {
    fireEvent.click(screen.getByTitle(name), keys);
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("choosing players on the table", () => {
    it("takes the row alone on a plain press, and lets go on a second one", () => {
        render(<Players />);
        press("Steve");
        expect(chosen()).toEqual(["Steve"]);
        press("Alex");
        expect(chosen()).toEqual(["Alex"]);
        press("Alex");
        expect(chosen()).toEqual([]);
    });

    it("adds with Ctrl and stretches with Shift, as Drive does", () => {
        render(<Players />);
        const order = drawnRows().map((one) =>
            NAMES.find((name) => within(one).queryByTitle(name))
        );
        const [first, second, third] = order as [string, string, string];
        expect(order.sort()).toEqual([...NAMES].sort());

        press(first);
        press(third, { ctrlKey: true });
        expect(chosen().sort()).toEqual([first, third].sort());

        press(first);
        press(third, { shiftKey: true });
        expect(chosen().sort()).toEqual([first, second, third].sort());
    });

    it("takes every row on Ctrl+A and lets go on Escape", () => {
        render(<Players />);
        const steve = row("Steve");
        fireEvent.keyDown(steve, { key: "a", ctrlKey: true });
        expect(chosen().sort()).toEqual([...NAMES].sort());
        expect(screen.getByRole("region", { name: "Selected players" })).toBeTruthy();

        fireEvent.keyDown(steve, { key: "Escape" });
        expect(chosen()).toEqual([]);
        expect(screen.queryByRole("region", { name: "Selected players" })).toBeNull();
    });

    it("toggles one row from its checkbox without dropping the others", () => {
        render(<Players />);
        press("Steve");
        fireEvent.click(screen.getByLabelText("Select Alex"));
        expect(chosen().sort()).toEqual(["Alex", "Steve"]);
    });
});

describe("the menu on several chosen players", () => {
    it("offers only what they can all take", async () => {
        render(<Players />);
        press("Steve");
        press("Alex", { ctrlKey: true });

        fireEvent.contextMenu(screen.getByTitle("Alex"));
        const menu = await screen.findByRole("menu");
        expect(within(menu).getByText("2 selected")).toBeTruthy();
        expect(within(menu).getByText("Export inventories")).toBeTruthy();
        expect(within(menu).getByText("Make operator")).toBeTruthy();
        expect(within(menu).getByText("Kick")).toBeTruthy();
        // One player's own verbs stay on their own row.
        expect(within(menu).queryByText("Import inventory")).toBeNull();
        expect(within(menu).queryByText("Export inventory")).toBeNull();
    });

    it("keeps a single row's own menu when only that row is chosen", async () => {
        render(<Players />);
        press("Steve");
        fireEvent.contextMenu(screen.getByTitle("Steve"));
        const menu = await screen.findByRole("menu");
        expect(within(menu).queryByText("Export inventories")).toBeNull();
        expect(within(menu).getByText("Import inventory")).toBeTruthy();
    });
});

describe("the menu on one player", () => {
    it("has the game mode as one entry, the current mode ticked", async () => {
        render(<Players />);
        fireEvent.contextMenu(screen.getByTitle("Steve"));
        const menu = await screen.findByRole("menu");
        // No mode is listed flat on the menu itself.
        expect(within(menu).queryByText("Creative")).toBeNull();

        fireEvent.click(within(menu).getByText("Game mode"));
        const creative = await screen.findByRole("menuitemradio", { name: /Creative/ });
        expect(creative.getAttribute("aria-checked")).toBe("true");
        const survival = screen.getByRole("menuitemradio", { name: /Survival/ });
        expect(survival.getAttribute("aria-checked")).toBe("false");
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    });

    it("exports the bag from a submenu and imports one from the menu", async () => {
        render(<Players />);
        fireEvent.contextMenu(screen.getByTitle("Steve"));
        const menu = await screen.findByRole("menu");
        expect(within(menu).getByText("Import inventory")).toBeTruthy();

        fireEvent.click(within(menu).getByText("Export inventory"));
        expect(await screen.findByText("Copy as JSON")).toBeTruthy();
        expect(screen.getByText("Download JSON")).toBeTruthy();
    });
});

// @vitest-environment jsdom

/**
 * The kept console commands, behind one button.
 *
 * Pinned: a long list is typed down by name or by the command itself; Enter
 * runs the first one left; nothing runs while the server cannot take it; and
 * each one still offers edit, schedule, put it in the box and forget, under a
 * one-line copy of the command whose whole text is on hover.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SavedCommand } from "@polaris-app/game-servers/src/lib/console-commands";

Element.prototype.scrollIntoView ??= () => undefined;

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useLocale: () => "en-US" } }
}));

const { KeptCommandsMenu, duplicateDraft, filterKeptCommands } = await import(
    "@polaris-app/game-servers/src/screens/installed/console-kept-menu"
);

afterEach(cleanup);

const LONG = `say ${"x".repeat(380)}`;
const SAVED: SavedCommand[] = [
    ...Array.from({ length: 40 }, (_, index) => ({
        id: `c${index}`,
        label: `Command ${index}`,
        command: `say ${index}`
    })),
    { id: "night", label: "Night", command: "time set night" },
    { id: "long", label: "Shout", command: LONG }
];

function renderMenu(canRun = true) {
    const handlers = {
        onRun: vi.fn(),
        onEdit: vi.fn(),
        onSchedule: vi.fn(),
        onLoad: vi.fn(),
        onDuplicate: vi.fn(),
        onForget: vi.fn()
    };
    render(<KeptCommandsMenu saved={SAVED} canRun={canRun} canManage {...handlers} />);
    return handlers;
}

describe("finding a kept command", () => {
    it("matches the name or the command, anywhere in it", () => {
        expect(filterKeptCommands(SAVED, "").length).toBe(42);
        expect(filterKeptCommands(SAVED, "night").map((entry) => entry.id)).toEqual(["night"]);
        expect(filterKeptCommands(SAVED, "TIME SET").map((entry) => entry.id)).toEqual(["night"]);
        expect(filterKeptCommands(SAVED, "command 3").map((entry) => entry.id)).toEqual([
            "c3",
            "c30",
            "c31",
            "c32",
            "c33",
            "c34",
            "c35",
            "c36",
            "c37",
            "c38",
            "c39"
        ]);
    });
});

describe("the menu", () => {
    it("says how many are kept, and runs the first match on Enter", async () => {
        const user = userEvent.setup();
        const handlers = renderMenu();
        await user.click(screen.getByRole("button", { name: /Kept commands \(42\)/ }));
        const search = await screen.findByPlaceholderText("Search kept commands");
        await waitFor(() => expect(document.activeElement).toBe(search));
        await user.type(search, "time set{Enter}");
        expect(handlers.onRun).toHaveBeenCalledWith(SAVED[40]);
    });

    it("says so when nothing matches", async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        await user.type(await screen.findByPlaceholderText("Search kept commands"), "zzz");
        expect(screen.getByText("No kept command matches that.")).toBeTruthy();
    });

    it("runs nothing while the server cannot take it", async () => {
        const user = userEvent.setup();
        const handlers = renderMenu(false);
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        await user.type(await screen.findByPlaceholderText("Search kept commands"), "night");
        expect(screen.getByText("Start the server to send commands")).toBeTruthy();
        const item = screen.getByRole("menuitem", { name: /^Night/ });
        expect(item.getAttribute("aria-disabled")).toBe("true");
        await user.click(item);
        expect(handlers.onRun).not.toHaveBeenCalled();
    });

    it("leaves Enter doing nothing while the server cannot take it", async () => {
        const user = userEvent.setup();
        const handlers = renderMenu(false);
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        await user.type(await screen.findByPlaceholderText("Search kept commands"), "night{Enter}");
        expect(handlers.onRun).not.toHaveBeenCalled();
        expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    });

    it("offers the rest under each one by the keyboard, with the command cut to a line", async () => {
        const user = userEvent.setup();
        const handlers = renderMenu();
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        await user.type(await screen.findByPlaceholderText("Search kept commands"), "shout");
        // By the keyboard: the arrow to the right of a command opens the rest.
        screen.getByRole("menuitem", { name: "More for Shout" }).focus();
        await user.keyboard("{ArrowRight}");
        // In the submenu as well as on the item that runs it, cut to a line
        // each time and whole on hover.
        await waitFor(() => expect(screen.getAllByTitle(LONG)).toHaveLength(2));
        const label = screen.getAllByTitle(LONG).find((element) => element.textContent === LONG);
        expect(label?.className).toContain("truncate");
        await waitFor(() => expect(document.activeElement?.textContent).toBe("Edit"));
        await user.keyboard("{ArrowDown}{Enter}");
        expect(handlers.onSchedule).toHaveBeenCalledWith(SAVED[41]);
    });
});

describe("a kept sequence", () => {
    const SEQUENCE: SavedCommand = {
        id: "restart",
        label: "Restart",
        command: "say Restarting\nwait 5\nstop"
    };

    function renderSequence() {
        const onSchedule = vi.fn();
        render(
            <KeptCommandsMenu
                saved={[SEQUENCE]}
                canRun
                canManage
                onRun={vi.fn()}
                onEdit={vi.fn()}
                onSchedule={onSchedule}
                onLoad={vi.fn()}
                onDuplicate={vi.fn()}
                onForget={vi.fn()}
            />
        );
        return onSchedule;
    }

    it("says how many commands it sends, with its lines on one row", async () => {
        const user = userEvent.setup();
        renderSequence();
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        expect(await screen.findByText("2 commands")).toBeTruthy();
        expect(screen.getByText("say Restarting | wait 5 | stop")).toBeTruthy();
    });

    it("offers no schedule for one that pauses, and says why", async () => {
        const user = userEvent.setup();
        const onSchedule = renderSequence();
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        screen.getByRole("menuitem", { name: "More for Restart" }).focus();
        await user.keyboard("{ArrowRight}");
        const schedule = await screen.findByRole("menuitem", { name: /Schedule/ });
        expect(schedule.getAttribute("aria-disabled")).toBe("true");
        expect(schedule.textContent).toContain("With pauses it runs only from the console");
        expect(onSchedule).not.toHaveBeenCalled();
    });
});

describe("duplicating a kept command", () => {
    const copyName = (name: string) => `${name} (copy)`;

    it("keeps the command and its blanks under a new name, as a new one", () => {
        const entry: SavedCommand = {
            id: "tp",
            label: "Bring",
            command: "tp {player} ~ ~ ~",
            variables: [{ name: "player", kind: "player" } as never]
        };
        const draft = duplicateDraft(entry, copyName);
        expect(draft).toEqual({
            label: "Bring (copy)",
            command: entry.command,
            variables: entry.variables
        });
        expect("id" in draft).toBe(false);
    });

    it("cuts a long name so the copy still fits", () => {
        const draft = duplicateDraft(
            { id: "x", label: "y".repeat(40), command: "say hi" },
            copyName
        );
        expect(draft.label.length).toBeLessThanOrEqual(40);
        expect(draft.label.endsWith(" (copy)")).toBe(true);
    });

    it("is offered beside the rest, named for the command it copies", async () => {
        const user = userEvent.setup();
        const handlers = renderMenu();
        await user.click(screen.getByRole("button", { name: /Kept commands/ }));
        await user.type(await screen.findByPlaceholderText("Search kept commands"), "night");
        screen.getByRole("menuitem", { name: "More for Night" }).focus();
        await user.keyboard("{ArrowRight}");
        const item = await screen.findByRole("menuitem", { name: "Duplicate Night" });
        expect(item.getAttribute("title")).toBe("Duplicate Night");
        await user.click(item);
        expect(handlers.onDuplicate).toHaveBeenCalledWith(SAVED[40]);
    });
});

// @vitest-environment jsdom

/**
 * The dialogs around a kept console command with variables.
 *
 * Pinned: keeping one shows what can be used and puts a variable where the
 * caret is when it is clicked; running one asks for each declared value with
 * its default filled in, says what is wrong as it is typed, waits for every
 * field, and asks who a `{player}` command is for; scheduling one hands over
 * the repeat as asked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SavedCommand } from "@polaris-app/game-servers/src/lib/console-commands";

// What jsdom does not implement and Radix's menus call on the way open.
Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined
});

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useLocale: () => "en-US" } }
}));

const { KeepCommandDialog } = await import(
    "@polaris-app/game-servers/src/screens/installed/console-keep-dialog"
);
const { RunCommandDialog } = await import(
    "@polaris-app/game-servers/src/screens/installed/console-run-dialog"
);

afterEach(cleanup);

const GIVE: SavedCommand = {
    id: "c1",
    label: "Bread",
    command: "give {player} {item} {amount}",
    variables: [
        { name: "item", label: "Item", type: "item", initial: "minecraft:bread" },
        { name: "amount", label: "How many", type: "number", initial: "" }
    ]
};

describe("keeping a command", () => {
    it("lists what can be used and puts a variable where the caret is", () => {
        const onKeep = vi.fn();
        render(
            <KeepCommandDialog
                initial={{ label: "", command: "say  joined", variables: [] }}
                edition="java"
                pending={false}
                error=""
                onClose={() => undefined}
                onKeep={onKeep}
            />
        );
        const field = screen.getByRole("textbox", { name: /^Command/ }) as HTMLInputElement;
        field.setSelectionRange(4, 4);
        fireEvent.click(screen.getByRole("button", { name: "{player}" }));
        expect(field.value).toBe("say {player} joined");
        expect(screen.getByText(/Braces that are not a variable/)).toBeTruthy();
        // A per-player value the game draws itself is not offered in a command.
        expect(screen.queryByRole("button", { name: "{player.level}" })).toBeNull();
    });

    it("keeps a declared variable only once the command uses it", () => {
        const onKeep = vi.fn();
        render(
            <KeepCommandDialog
                initial={{ label: "", command: "give @a bread", variables: [] }}
                edition="java"
                pending={false}
                error=""
                onClose={() => undefined}
                onKeep={onKeep}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
        fireEvent.change(screen.getByRole("textbox", { name: "In the command" }), {
            target: { value: "amount" }
        });
        expect(screen.getByRole("alert").textContent).toBe(
            "amount is not in the command. Use it or remove it."
        );
        fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
        expect(onKeep).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "{amount}" }));
        fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
        expect(onKeep).toHaveBeenCalledWith(
            expect.objectContaining({
                command: "give @a bread{amount}",
                variables: [{ name: "amount", label: "amount", type: "text", initial: "" }]
            })
        );
    });

    it("keeps several lines as one sequence, asking once for a variable used on each", () => {
        const onKeep = vi.fn();
        render(
            <KeepCommandDialog
                initial={{ label: "", command: "", variables: [] }}
                edition="java"
                pending={false}
                error=""
                onClose={() => undefined}
                onKeep={onKeep}
            />
        );
        fireEvent.change(screen.getByRole("textbox", { name: /^Command/ }), {
            target: { value: "  say in {x=10}s \n\n wait 5\nsay {x}\n" }
        });
        expect(screen.getByText("2 commands")).toBeTruthy();
        expect(screen.getByText(/x = 10/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
        expect(onKeep).toHaveBeenCalledWith(
            expect.objectContaining({ command: "say in {x=10}s\nwait 5\nsay {x}" })
        );
    });

    it("says what is wrong with a sequence Run several would refuse", () => {
        const onKeep = vi.fn();
        render(
            <KeepCommandDialog
                initial={{ label: "", command: "say a\nwait 500", variables: [] }}
                edition="java"
                pending={false}
                error=""
                onClose={() => undefined}
                onKeep={onKeep}
            />
        );
        expect(screen.getByRole("alert").textContent).toBe(
            "Line 2 waits longer than 120 seconds. Use the Schedule tab for that."
        );
        fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
        expect(onKeep).not.toHaveBeenCalled();
    });

    it("says the game has none of Polaris's own on another game", () => {
        render(
            <KeepCommandDialog
                initial={{ label: "", command: "", variables: [] }}
                edition={null}
                pending={false}
                error=""
                onClose={() => undefined}
                onKeep={() => undefined}
            />
        );
        expect(screen.getByText(/variables are for Minecraft only/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "{player}" })).toBeNull();
    });
});

describe("running one", () => {
    it("asks for each value, checks it as typed, and waits for every field", async () => {
        const user = userEvent.setup();
        const onRun = vi.fn();
        render(
            <RunCommandDialog
                entry={GIVE}
                mode="run"
                edition="java"
                players={["Steve", "Alex"]}
                pending={false}
                error=""
                onClose={() => undefined}
                onRun={onRun}
                onSchedule={() => undefined}
            />
        );
        const item = screen.getByRole("textbox", { name: /Item/ }) as HTMLInputElement;
        expect(item.value).toBe("minecraft:bread");
        const amount = screen.getByRole("textbox", { name: /How many/ });
        // Empty is not yet, not wrong.
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(onRun).not.toHaveBeenCalled();

        fireEvent.change(amount, { target: { value: '8" run op Eve' } });
        expect(screen.getByRole("alert").textContent).toBe(
            "No quotes, backslashes, brackets or line breaks"
        );
        fireEvent.change(amount, { target: { value: "8" } });
        expect(screen.queryByRole("alert")).toBeNull();

        fireEvent.click(screen.getByRole("radio", { name: "One player" }));
        // Nobody is picked for them.
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(onRun).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Player" }));
        const search = await screen.findByPlaceholderText("Search players");
        await user.type(search, "al");
        // Who is on comes first; what was typed stays offered for somebody who is not.
        expect(screen.getAllByRole("menuitem").map((option) => option.textContent)).toEqual([
            "Alex",
            'Use "al"'
        ]);
        await user.click(screen.getByRole("menuitem", { name: "Alex" }));
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(onRun).toHaveBeenCalledWith({
            values: { item: "minecraft:bread", amount: "8" },
            target: { player: "Alex" }
        });
    });

    it("schedules it with the repeat as asked", () => {
        const onSchedule = vi.fn();
        render(
            <RunCommandDialog
                entry={{ id: "c2", label: "Save", command: "save-all" }}
                mode="schedule"
                edition="java"
                players={[]}
                pending={false}
                error=""
                onClose={() => undefined}
                onRun={() => undefined}
                onSchedule={onSchedule}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
        expect(onSchedule).toHaveBeenCalledWith(
            expect.objectContaining({
                values: {},
                target: null,
                startIn: { amount: 5, unit: "minutes" },
                repeat: { kind: "once" }
            })
        );
    });

    it("picks a player variable from who is on", async () => {
        const user = userEvent.setup();
        const onRun = vi.fn();
        render(
            <RunCommandDialog
                entry={{
                    id: "c3",
                    label: "Swap",
                    command: "tp {who} 0 64 0",
                    variables: [{ name: "who", label: "Who", type: "player", initial: "" }]
                }}
                mode="run"
                edition="java"
                players={["Steve", "Alex"]}
                pending={false}
                error=""
                onClose={() => undefined}
                onRun={onRun}
                onSchedule={() => undefined}
            />
        );
        expect(screen.queryByRole("textbox", { name: /Who/ })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Who" }));
        await user.click(await screen.findByRole("menuitem", { name: "Steve" }));
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(onRun).toHaveBeenCalledWith({ values: { who: "Steve" }, target: null });
    });

    it("schedules it in so many hours, repeating every so many days", async () => {
        const user = userEvent.setup();
        const onSchedule = vi.fn();
        render(
            <RunCommandDialog
                entry={{ id: "c2", label: "Save", command: "save-all" }}
                mode="schedule"
                edition="java"
                players={[]}
                pending={false}
                error=""
                onClose={() => undefined}
                onRun={() => undefined}
                onSchedule={onSchedule}
            />
        );
        await user.click(screen.getByRole("combobox", { name: "First run" }));
        await user.click(await screen.findByRole("option", { name: "In..." }));
        const amount = screen.getByRole("spinbutton", { name: /^In/ });
        await user.click(screen.getByRole("combobox", { name: "Unit" }));
        await user.click(await screen.findByRole("option", { name: "hours" }));

        await user.click(screen.getByRole("combobox", { name: "Repeat" }));
        await user.click(await screen.findByRole("option", { name: "Every" }));
        const gap = screen.getByRole("spinbutton", { name: "Every" });
        fireEvent.change(gap, { target: { value: "2" } });
        await user.click(screen.getByRole("combobox", { name: "Repeat unit" }));
        await user.click(await screen.findByRole("option", { name: "days" }));

        // Empty is not yet; zero is wrong, and said so.
        fireEvent.change(amount, { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
        expect(onSchedule).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.change(amount, { target: { value: "0" } });
        expect(screen.getByRole("alert").textContent).toBe(
            "Whole minutes, hours or days, up to a year"
        );

        fireEvent.change(amount, { target: { value: "3" } });
        fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
        await waitFor(() => expect(onSchedule).toHaveBeenCalled());
        const choice = onSchedule.mock.calls[0]?.[0];
        expect(choice).toMatchObject({
            startIn: { amount: 3, unit: "hours" },
            repeat: { kind: "every", minutes: 2 * 24 * 60 }
        });
        const ahead = Date.parse(choice.firstAt) - Date.now();
        expect(ahead).toBeGreaterThan(3 * 60 * 60_000 - 60_000);
        expect(ahead).toBeLessThanOrEqual(3 * 60 * 60_000);
    });

    it("keeps a date and time as the first run when one is picked", async () => {
        const user = userEvent.setup();
        const onSchedule = vi.fn();
        render(
            <RunCommandDialog
                entry={{ id: "c2", label: "Save", command: "save-all" }}
                mode="schedule"
                edition="java"
                players={[]}
                pending={false}
                error=""
                onClose={() => undefined}
                onRun={() => undefined}
                onSchedule={onSchedule}
            />
        );
        await user.click(screen.getByRole("combobox", { name: "First run" }));
        await user.click(await screen.findByRole("option", { name: "At a set time" }));
        fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
        expect(onSchedule).toHaveBeenCalledTimes(1);
        expect(onSchedule.mock.calls[0]?.[0]).not.toHaveProperty("startIn");
    });
});

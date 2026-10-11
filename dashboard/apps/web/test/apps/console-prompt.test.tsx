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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SavedCommand } from "@polaris-app/game-servers/src/lib/console-commands";

Element.prototype.scrollIntoView ??= () => undefined;

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
    it("asks for each value, checks it as typed, and waits for every field", () => {
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
        fireEvent.change(screen.getByRole("combobox", { name: /Player/ }), {
            target: { value: "Alex" }
        });
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
            expect.objectContaining({ values: {}, target: null, repeat: { kind: "once" } })
        );
    });
});

import { describe, expect, it } from "vitest";
import {
    MAX_SAVED_COMMANDS,
    normalizeSavedCommand,
    placeholderRange,
    readSavedCommands,
    withSavedCommand,
    withoutSavedCommand,
    type SavedCommand
} from "@polaris-app/game-servers/src/lib/console-commands";

const entry = (id: string, command = "SaveWorld", label?: string): SavedCommand => {
    const normalized = normalizeSavedCommand({ id, command, label });
    if (!normalized) throw new Error("fixture is not a usable command");
    return normalized;
};

describe("normalizeSavedCommand", () => {
    it("names an unnamed command after itself", () => {
        expect(normalizeSavedCommand({ id: "a", command: " SaveWorld " })).toEqual({
            id: "a",
            label: "SaveWorld",
            command: "SaveWorld"
        });
    });

    it("keeps the name somebody gave it", () => {
        expect(
            normalizeSavedCommand({ id: "a", label: " Save the world ", command: "SaveWorld" })
                ?.label
        ).toBe("Save the world");
    });

    it("keeps several lines as one sequence, each line trimmed and the empty ones dropped", () => {
        // A second line is a sequence the person wrote, shown as one on its
        // button - never a single command that quietly became two.
        expect(
            normalizeSavedCommand({ id: "a", command: " SaveWorld \r\n\n  Broadcast bye\n" })
        ).toEqual({ id: "a", label: "SaveWorld", command: "SaveWorld\nBroadcast bye" });
    });

    it("refuses an empty command and one nobody could send", () => {
        expect(normalizeSavedCommand({ id: "a", command: "   " })).toBeNull();
        expect(normalizeSavedCommand({ id: "a", command: "x".repeat(401) })).toBeNull();
    });

    it("repairs a name rather than refusing it", () => {
        const kept = normalizeSavedCommand({
            id: "a",
            label: "x".repeat(80),
            command: "SaveWorld"
        });
        expect(kept?.label.length).toBe(40);
    });
});

describe("readSavedCommands", () => {
    it("reads back what was written", () => {
        const list = [entry("a"), entry("b", "Broadcast hello")];
        expect(readSavedCommands({ consoleCommands: list })).toEqual(list);
    });

    it("is empty for a server that has none, and for a blob of the wrong shape", () => {
        expect(readSavedCommands({})).toEqual([]);
        expect(readSavedCommands({ consoleCommands: "SaveWorld" })).toEqual([]);
    });

    it("drops an entry it cannot read rather than showing half of one", () => {
        const rows = [
            { id: "a", command: "SaveWorld" },
            { id: "b" },
            null,
            { command: "Broadcast hi" }
        ];
        expect(readSavedCommands({ consoleCommands: rows }).map((row) => row.id)).toEqual(["a"]);
    });

    it("drops a repeated id, so one button cannot be two commands", () => {
        const rows = [
            { id: "a", command: "SaveWorld" },
            { id: "a", command: "DoExit" }
        ];
        expect(readSavedCommands({ consoleCommands: rows })).toEqual([entry("a")]);
    });
});

describe("withSavedCommand", () => {
    it("adds one to the end", () => {
        expect(withSavedCommand([entry("a")], entry("b", "DoExit")).map((row) => row.id)).toEqual([
            "a",
            "b"
        ]);
    });

    it("rewrites in place, so editing does not move the button", () => {
        const list = [entry("a"), entry("b", "DoExit"), entry("c", "Broadcast hi")];
        const changed = withSavedCommand(list, entry("b", "SaveWorld", "Save"));
        expect(changed.map((row) => row.id)).toEqual(["a", "b", "c"]);
        expect(changed[1]?.command).toBe("SaveWorld");
    });

    it("refuses to grow past the ceiling", () => {
        const full = Array.from({ length: MAX_SAVED_COMMANDS }, (_, index) => entry(`id-${index}`));
        expect(() => withSavedCommand(full, entry("one-more"))).toThrow();
        // Rewriting one of the ones already there is not growth.
        expect(withSavedCommand(full, entry("id-0", "DoExit"))).toHaveLength(MAX_SAVED_COMMANDS);
    });
});

describe("withoutSavedCommand", () => {
    it("takes one off and leaves the rest", () => {
        expect(
            withoutSavedCommand([entry("a"), entry("b", "DoExit")], "a").map((row) => row.id)
        ).toEqual(["b"]);
    });
});

describe("placeholderRange", () => {
    it("finds the blank to fill in", () => {
        expect(placeholderRange("Broadcast <message>")).toEqual({ start: 10, end: 19 });
    });

    it("says a complete command has none, so pressing it sends it", () => {
        expect(placeholderRange("SaveWorld")).toBeNull();
    });

    it("takes the first of several", () => {
        expect(placeholderRange("give <player> <item>")).toEqual({ start: 5, end: 13 });
    });
});

describe("a kept command's variables", () => {
    const amount = { name: "amount", label: "How many", type: "number", initial: "8" } as const;

    it("are kept with it and read back", () => {
        const kept = normalizeSavedCommand({
            id: "a",
            command: "give {player} bread {amount}",
            variables: [amount]
        });
        expect(kept?.variables).toEqual([amount]);
        expect(readSavedCommands({ consoleCommands: [kept] })).toEqual([kept]);
    });

    it("refuse a command that declares one it does not use", () => {
        expect(
            normalizeSavedCommand({ id: "a", command: "give @a bread 8", variables: [amount] })
        ).toBeNull();
    });

    it("leave a command kept before they existed exactly as it was", () => {
        expect(
            readSavedCommands({
                consoleCommands: [{ id: "a", label: "Day", command: "time set day" }]
            })
        ).toEqual([{ id: "a", label: "Day", command: "time set day" }]);
    });

    it("drop variables a later version wrote differently, and keep the command", () => {
        const read = readSavedCommands({
            consoleCommands: [
                {
                    id: "a",
                    label: "Give",
                    command: "give {player} {x}",
                    variables: [{ name: "y", type: "text" }]
                }
            ]
        });
        expect(read).toEqual([{ id: "a", label: "Give", command: "give {player} {x}" }]);
    });
});

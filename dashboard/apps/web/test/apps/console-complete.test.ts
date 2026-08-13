/**
 * Finishing a command for somebody, from a table rather than from the server.
 *
 * The cases worth pinning are the ones where a naive completer is wrong in a way
 * people notice: a caret in the middle of a line, a leading slash shifting every
 * index by one, a space meaning "a new argument starts here" rather than "nothing
 * typed yet", and a Bedrock server being offered Java's spelling of a command that
 * does not exist there.
 */

import { describe, expect, it } from "vitest";
import { applyCompletion, completeConsole, type CompletionSources } from "@/lib/apps/console-complete";

const SOURCES: CompletionSources = {
    game: "java",
    players: ["Alice", "Bob", "alfonso"],
    items: ["minecraft:diamond", "minecraft:dirt"],
    rules: ["keepInventory", "doDaylightCycle"]
};

/** Complete with the caret at the end, which is the ordinary case. */
function at(line: string, sources: CompletionSources = SOURCES) {
    return completeConsole(line, line.length, sources);
}

describe("the command itself", () => {
    it("offers the commands that start with what has been typed", () => {
        expect(at("gam").options).toEqual(["gamemode", "gamerule"]);
    });

    it("is not thrown off by the slash people type out of habit", () => {
        // The slash is stripped before the command runs, so it is not part of the
        // first word here either - counted in, every argument is off by one.
        const completion = at("/gam");
        expect(completion.options).toEqual(["gamemode", "gamerule"]);
        expect(completion.from).toBe(1);
    });

    it("offers everything on an empty line", () => {
        expect(at("").options.length).toBeGreaterThan(10);
    });
});

describe("the arguments", () => {
    it("offers who is on where a player belongs", () => {
        expect(at("kick ").options).toEqual(["Alice", "Bob", "alfonso"]);
    });

    it("matches a name however it was capitalised", () => {
        expect(at("kick al").options).toEqual(["Alice", "alfonso"]);
    });

    it("offers items where an item belongs, and nothing where a number does", () => {
        expect(at("give Alice di").options).toEqual(["minecraft:diamond", "minecraft:dirt"]);
        // The count. A list here is noise in front of somebody who knows what they
        // are typing.
        expect(at("give Alice minecraft:dirt ").options).toEqual([]);
    });

    it("offers the rules, then true and false", () => {
        expect(at("gamerule keep").options).toEqual(["keepInventory"]);
        expect(at("gamerule keepInventory ").options).toEqual(["true", "false"]);
    });

    it("says nothing about a command it does not know", () => {
        // A plugin's command. Offering the wrong arguments for it would be worse
        // than offering none.
        expect(at("essentials ").options).toEqual([]);
    });

    it("stops offering past the arguments a command takes", () => {
        expect(at("list ").options).toEqual([]);
    });
});

describe("where the caret is", () => {
    it("completes the word the caret is in, not the last word on the line", () => {
        // Somebody who went back to fix a name. Completing the end of the line
        // instead is the behaviour that makes people turn a suggestion list off.
        const line = "kick Al forgot the reason";
        const completion = completeConsole(line, "kick Al".length, SOURCES);
        expect(completion.options).toEqual(["Alice", "alfonso"]);
        expect(completion.token).toBe("Al");
        expect(completion.from).toBe(5);
    });

    it("treats a caret just after a space as a fresh argument", () => {
        const completion = completeConsole("kick ", 5, SOURCES);
        expect(completion.token).toBe("");
        expect(completion.options).toEqual(["Alice", "Bob", "alfonso"]);
    });
});

describe("putting the choice in", () => {
    it("replaces the part typed and leaves the caret ready for the next argument", () => {
        const line = "kick Al";
        const result = applyCompletion(line, at(line), "Alice");
        expect(result.line).toBe("kick Alice ");
        expect(result.caret).toBe(result.line.length);
    });

    it("keeps whatever came after the caret", () => {
        const line = "kick Al forgot the reason";
        const completion = completeConsole(line, "kick Al".length, SOURCES);
        expect(applyCompletion(line, completion, "Alice").line).toBe("kick Alice  forgot the reason");
    });
});

describe("the other two games", () => {
    it("gives Bedrock its own spelling rather than Java's", () => {
        const bedrock: CompletionSources = { ...SOURCES, game: "bedrock" };
        expect(completeConsole("allow", 5, bedrock).options).toEqual(["allowlist"]);
        // Whitelist is Java's word for it, and a Bedrock server does not take it.
        expect(completeConsole("whitelist", 9, bedrock).options).toEqual([]);
    });

    it("gives ARK its own commands, capitals and all", () => {
        const ark: CompletionSources = { ...SOURCES, game: "ark" };
        expect(completeConsole("Save", 4, ark).options).toEqual(["SaveWorld"]);
        expect(completeConsole("save", 4, ark).options).toEqual(["SaveWorld"]);
        expect(completeConsole("KickPlayer ", 11, ark).options).toEqual(["Alice", "Bob", "alfonso"]);
    });
});

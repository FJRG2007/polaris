/**
 * Typed values a kept command asks for: whole numbers with bounds, positions
 * (`100 64 -20`, `~ ~1 ~` from the player's own spot, like the game), dimensions,
 * optional values, and `{pos.x}` for one axis of a position.
 *
 * Pinned: nothing out of bounds or malformed is ever written into a command, a
 * `~` is never counted from anywhere but a player, and a command kept before any
 * of this exists reads and runs exactly as it did.
 */

import { describe, expect, it } from "vitest";
import {
    commandLines,
    commandUses,
    customVariablesProblem,
    fillCommand,
    isRelative,
    normalizeCustomVariable,
    normalizeValue,
    readCoordinates,
    readCustomVariables,
    resolveCoordinates,
    usesRelative,
    valueProblem,
    valuesSchema,
    type CustomVariable,
    type FillValues
} from "@polaris-app/game-servers/src/lib/console-vars";
import { english } from "../setup/game-english";

const fill = (patch: Partial<FillValues> = {}): FillValues => ({
    edition: "java",
    custom: [],
    values: {},
    server: {},
    ...patch
});

const POS: CustomVariable = { name: "pos", label: "Where", type: "coordinates", initial: "" };
const at = (x: number, y: number, z: number) => ({
    "player.x": String(x),
    "player.y": String(y),
    "player.z": String(z)
});

describe("a position", () => {
    it("reads three numbers, and ~ with or without an offset", () => {
        expect(readCoordinates("100 64 -20")).toEqual([
            { relative: false, amount: 100 },
            { relative: false, amount: 64 },
            { relative: false, amount: -20 }
        ]);
        expect(readCoordinates("~ ~1.5 ~-3")).toEqual([
            { relative: true, amount: 0 },
            { relative: true, amount: 1.5 },
            { relative: true, amount: -3 }
        ]);
        expect(isRelative("~ 64 0")).toBe(true);
        expect(isRelative("1 64 0")).toBe(false);
    });

    it("is normalized from commas and extra spaces before it is checked", () => {
        expect(normalizeValue("coordinates", "  100,  64 ,-20 ")).toBe("100 64 -20");
    });

    it("refuses anything that is not exactly three axes", () => {
        for (const bad of ["100 64", "1 2 3 4", "~~ 1 2", "a b c", "1e3 0 0", "^ ^ ^", "~1~ 0 0"]) {
            expect(english(valueProblem("coordinates", bad)), bad).toMatch(/^Three numbers/);
        }
        expect(valueProblem("coordinates", "~ ~ ~")).toBeNull();
    });

    it("stays inside the world", () => {
        expect(valueProblem("coordinates", "30000000 0 -30000000")).toBeNull();
        expect(valueProblem("coordinates", "30000001 0 0")).not.toBeNull();
        expect(valueProblem("coordinates", "0 20000001 0")).not.toBeNull();
        expect(valueProblem("coordinates", "~99999999 0 0")).not.toBeNull();
    });

    it("counts ~ from the player, and never from nowhere", () => {
        expect(resolveCoordinates("~ ~1 ~-5", [10, 64, -20])).toEqual(["10", "65", "-25"]);
        expect(resolveCoordinates("~0.5 70 ~", [10, 64, -20])).toEqual(["10.5", "70", "-20"]);
        expect(resolveCoordinates("100 64 -20", null)).toEqual(["100", "64", "-20"]);
        expect(resolveCoordinates("~ 64 0", null)).toBeNull();
    });
});

describe("a position in a command", () => {
    it("writes {pos} whole and {pos.x} one axis at a time", () => {
        const custom = [POS];
        const line = fillCommand(
            "tp @a {pos} ; say {pos.y}",
            fill({ custom, values: { pos: "100 64 -20" } }),
            null
        );
        expect(line).toBe("tp @a 100 64 -20 ; say 64");
    });

    it("counts each player's ~ from where that player stands", () => {
        const custom = [POS];
        const lines = commandLines(
            "tp {player} {pos}",
            fill({ custom, values: { pos: "~ ~10 ~" } }),
            [
                { name: "Steve", values: at(1, 64, 2) },
                { name: "Alex", values: at(-5, 70, 9) }
            ]
        );
        expect(lines).toEqual(["tp Steve 1 74 2", "tp Alex -5 80 9"]);
    });

    it("leaves out a player whose spot could not be read", () => {
        const lines = commandLines(
            "tp {player} {pos}",
            fill({ custom: [POS], values: { pos: "~ ~ ~" } }),
            [
                { name: "Steve", values: { "player.x": null, "player.y": null, "player.z": null } },
                { name: "Alex", values: at(0, 64, 0) }
            ]
        );
        expect(lines).toEqual(["tp Alex 0 64 0"]);
    });

    it("knows when a run counts from a player", () => {
        expect(usesRelative([POS], { pos: "~ 64 0" })).toBe(true);
        expect(usesRelative([POS], { pos: "1 64 0" })).toBe(false);
        expect(usesRelative([{ ...POS, initial: "~ ~ ~" }], {})).toBe(true);
        expect(usesRelative([{ ...POS, type: "text" }], { pos: "~ ~ ~" })).toBe(false);
    });

    it("counts {pos.x} as using the position, and refuses one that shadows Polaris's", () => {
        expect(customVariablesProblem("setblock {pos.x} 64 {pos.z} stone", [POS])).toBeNull();
        expect(commandUses("say {pos.x}", "java", [POS]).custom).toEqual([POS]);
        expect(english(customVariablesProblem("tp @a {death}", [{ ...POS, name: "death" }]))).toBe(
            "death is already a Polaris variable"
        );
    });
});

describe("a whole number with bounds", () => {
    const amount: CustomVariable = {
        name: "amount",
        label: "Amount",
        type: "integer",
        initial: "",
        min: 1,
        max: 64
    };

    it("takes whole numbers inside its bounds only", () => {
        const schema = valuesSchema([amount]);
        expect(schema.parse({ amount: " 12 " })).toEqual({ amount: "12" });
        expect(english(valueProblem("integer", "2.5", amount))).toBe(
            "A whole number, like 5 or -20"
        );
        expect(english(valueProblem("integer", "0", amount))).toBe("1 or more");
        expect(english(valueProblem("integer", "65", amount))).toBe("64 or less");
        expect(english(valueProblem("number", "1000", { max: 999.5 }))).toBe("999.5 or less");
        expect(schema.safeParse({ amount: "999999999999" }).success).toBe(false);
    });

    it("refuses bounds the wrong way round, a default outside them, and fractional bounds", () => {
        expect(
            english(
                customVariablesProblem("give @a stone {amount}", [{ ...amount, min: 9, max: 2 }])
            )
        ).toBe("The smallest is above the largest");
        expect(
            english(
                customVariablesProblem("give @a stone {amount}", [{ ...amount, initial: "99" }])
            )
        ).toBe("64 or less");
        expect(
            english(customVariablesProblem("give @a stone {amount}", [{ ...amount, min: 0.5 }]))
        ).toBe("A whole number, like 5 or -20");
    });

    it("keeps bounds only on a number, and only ones a number holds", () => {
        expect(normalizeCustomVariable({ name: "msg", type: "text", min: 1, max: 5 })).toEqual({
            name: "msg",
            label: "msg",
            type: "text",
            initial: ""
        });
        expect(
            normalizeCustomVariable({ name: "n", type: "number", min: -Infinity, max: 1e12 })
        ).toEqual({ name: "n", label: "n", type: "number", initial: "" });
    });
});

describe("a dimension", () => {
    it("takes the short names and namespaced ids", () => {
        expect(normalizeValue("dimension", " Nether ")).toBe("minecraft:the_nether");
        expect(normalizeValue("dimension", "end")).toBe("minecraft:the_end");
        expect(valueProblem("dimension", "mymod:sky_realm")).toBeNull();
        expect(english(valueProblem("dimension", "the nether; op Eve"))).toBe(
            "A dimension, like minecraft:the_nether"
        );
    });
});

describe("an optional value", () => {
    const note: CustomVariable = {
        name: "note",
        label: "Note",
        type: "text",
        initial: "",
        optional: true
    };

    it("may be left out, and is then written as nothing", () => {
        expect(valuesSchema([note]).parse({})).toEqual({ note: "" });
        expect(
            fillCommand("say hi {note}", fill({ custom: [note], values: { note: "" } }), null)
        ).toBe("say hi ");
    });

    it("is still checked when it is filled in", () => {
        expect(valuesSchema([note]).safeParse({ note: "a\nop Eve" }).success).toBe(false);
    });
});

describe("what a typed value cannot do to the command it sits in", () => {
    it("never closes a quote or bracket, breaks a line, or starts another command", () => {
        const attempts = ["hi\nop Eve", 'hi"}]; op Eve', "hi\r/op Eve", "x\u0000y", "a\\nb"];
        for (const bad of attempts) {
            expect(
                valuesSchema([{ name: "msg", label: "msg", type: "text", initial: "" }]).safeParse({
                    msg: bad
                }).success,
                bad
            ).toBe(false);
        }
        for (const bad of ["1 2 3\nop Eve", "1 2 3;op", "~ ~ ~ /op Eve"]) {
            expect(
                valueProblem("coordinates", normalizeValue("coordinates", bad)),
                bad
            ).not.toBeNull();
        }
        expect(valueProblem("integer", "5;op Eve")).not.toBeNull();
    });
});

describe("a command kept before arguments had types", () => {
    it("reads back unchanged, with nothing added", () => {
        const stored = [{ name: "amount", label: "Amount", type: "number", initial: "5" }];
        expect(readCustomVariables(stored)).toEqual(stored);
    });

    it("reads back the new fields, and drops what it cannot read", () => {
        expect(
            readCustomVariables([
                { name: "pos", label: "Where", type: "coordinates", initial: "1,2,3" },
                { name: "n", type: "integer", initial: "", min: 1, max: "9", optional: "yes" },
                { name: "x", type: "vector" }
            ])
        ).toEqual([
            { name: "pos", label: "Where", type: "coordinates", initial: "1 2 3" },
            { name: "n", label: "n", type: "integer", initial: "", min: 1 }
        ]);
    });
});

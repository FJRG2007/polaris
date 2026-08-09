import { describe, expect, it } from "vitest";
import {
    GAME_RULES,
    findRule,
    normalizeRuleValue,
    parseDifficulty,
    parseGameRules,
    ruleGroups
} from "@/lib/apps/minecraft/rules";

describe("parseGameRules", () => {
    it("reads the value out of each reply", () => {
        const output = [
            "Gamerule keepInventory is currently set to: false",
            "Gamerule doDaylightCycle is currently set to: true",
            "Gamerule spawnRadius is currently set to: 10"
        ].join("\n");
        expect(Object.fromEntries(parseGameRules(output))).toEqual({
            keepInventory: "false",
            doDaylightCycle: "true",
            spawnRadius: "10"
        });
    });

    it("reads the reply a change comes back with, which words it differently", () => {
        expect(parseGameRules("Gamerule keepInventory is now set to: true").get("keepInventory")).toBe("true");
    });

    it("leaves out a rule this version does not have", () => {
        // The server answers a rule it has never heard of with a parser error, and
        // a screen that drew it anyway would offer a switch that fails every time.
        const output = [
            "Gamerule keepInventory is currently set to: true",
            "Unknown game rule 'doWardenSpawning'"
        ].join("\n");
        const found = parseGameRules(output);
        expect(found.has("keepInventory")).toBe(true);
        expect(found.has("doWardenSpawning")).toBe(false);
    });

    it("has nothing to report for output that is not a rule reply", () => {
        expect(parseGameRules("").size).toBe(0);
        expect(parseGameRules("There are 0 of a max of 20 players online:").size).toBe(0);
    });
});

describe("parseDifficulty", () => {
    it("reads what the server said it is", () => {
        expect(parseDifficulty("The difficulty is Easy")).toBe("easy");
        expect(parseDifficulty("The difficulty has been set to Hard")).toBeNull();
    });

    it("is null for anything that is not a difficulty", () => {
        expect(parseDifficulty("")).toBeNull();
        expect(parseDifficulty("The difficulty is Brutal")).toBeNull();
    });
});

describe("normalizeRuleValue", () => {
    const keepInventory = findRule("keepInventory");
    const spawnRadius = findRule("spawnRadius");

    it("takes only true or false for a switch", () => {
        expect(keepInventory).toBeDefined();
        expect(normalizeRuleValue(keepInventory!, " true ")).toBe("true");
        expect(normalizeRuleValue(keepInventory!, "false")).toBe("false");
        expect(normalizeRuleValue(keepInventory!, "yes")).toBeNull();
        expect(normalizeRuleValue(keepInventory!, "1")).toBeNull();
    });

    it("holds a number inside the range the rule has", () => {
        expect(spawnRadius).toBeDefined();
        expect(normalizeRuleValue(spawnRadius!, "16")).toBe("16");
        expect(normalizeRuleValue(spawnRadius!, "0")).toBe("0");
        expect(normalizeRuleValue(spawnRadius!, "-1")).toBeNull();
        expect(normalizeRuleValue(spawnRadius!, "1000")).toBeNull();
        expect(normalizeRuleValue(spawnRadius!, "true")).toBeNull();
        // Not a number this could send as a command argument.
        expect(normalizeRuleValue(spawnRadius!, "8; op alice")).toBeNull();
    });
});

describe("the rule catalogue", () => {
    it("names every rule the way the command spells it, and only once", () => {
        // A name with anything else in it would reach a shell as part of the read
        // script, and a duplicate would draw two switches for one setting.
        const ids = GAME_RULES.map((rule) => rule.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z]+$/);
    });

    it("gives every integer rule a range, so the screen can refuse one", () => {
        for (const rule of GAME_RULES.filter((entry) => entry.type === "integer")) {
            expect(rule.min).toBeTypeOf("number");
            expect(rule.max).toBeTypeOf("number");
        }
    });

    it("groups them, keeping what a death costs at the top", () => {
        const groups = ruleGroups();
        expect(groups[0]?.rules[0]?.id).toBe("keepInventory");
        expect(groups.flatMap((group) => group.rules)).toHaveLength(GAME_RULES.length);
    });
});

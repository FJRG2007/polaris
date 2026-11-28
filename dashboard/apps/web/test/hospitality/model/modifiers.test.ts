/**
 * The options a waiter picks for a line: group limits, swaps and refusals.
 */

import { describe, expect, it } from "vitest";
import { chooseModifiers, toggleModifier, type ModifierChoiceGroup } from "@polaris-app/hospitality/src/model/modifiers";

const groups: ModifierChoiceGroup[] = [
    { id: "size", min: 1, max: 1, options: [{ id: "cana", name: "Cana", price: 0 }, { id: "jarra", name: "Jarra", price: 150 }] },
    { id: "extras", min: 0, max: 2, options: [{ id: "lemon", name: "Lemon", price: 0 }, { id: "ice", name: "Ice", price: 0 }, { id: "shot", name: "Shot", price: 200 }] }
];

describe("chooseModifiers", () => {
    it("prices the chosen options from the product", () => {
        expect(chooseModifiers(groups, ["jarra", "shot"])).toEqual({ ok: true, modifiers: [{ name: "Jarra", price: 150 }, { name: "Shot", price: 200 }] });
    });

    it("refuses a required group left empty", () => {
        expect(chooseModifiers(groups, ["lemon"])).toEqual({ ok: false, groupId: "size" });
    });

    it("refuses more than a group's max, an unknown option and a repeat", () => {
        expect(chooseModifiers(groups, ["cana", "lemon", "ice", "shot"])).toEqual({ ok: false, groupId: "extras" });
        expect(chooseModifiers(groups, ["cana", "forged"])).toEqual({ ok: false, groupId: null });
        expect(chooseModifiers(groups, ["cana", "cana"])).toEqual({ ok: false, groupId: null });
    });

    it("accepts no options on a product with no groups", () => {
        expect(chooseModifiers([], [])).toEqual({ ok: true, modifiers: [] });
    });
});

describe("toggleModifier", () => {
    it("swaps inside a single-choice group", () => {
        expect(toggleModifier(groups, ["cana"], "jarra")).toEqual(["jarra"]);
    });

    it("ignores a tap on a full group and removes a picked option", () => {
        expect(toggleModifier(groups, ["lemon", "ice"], "shot")).toEqual(["lemon", "ice"]);
        expect(toggleModifier(groups, ["lemon", "ice"], "ice")).toEqual(["lemon"]);
    });
});

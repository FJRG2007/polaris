/**
 * Data an assistant asks for on an item, written after the id the way the
 * server's version reads it: components from Java 1.20.5, an NBT compound
 * before. Anything the server would misread is refused rather than sent.
 */

import { describe, expect, it } from "vitest";
import {
    MAX_ARGUMENT_LENGTH,
    itemDataArgument
} from "@polaris-app/game-servers/src/lib/minecraft/item-argument";

const ID = "minecraft:diamond_sword";

describe("itemDataArgument on 1.20.5 and later", () => {
    it("takes a component list with or without its brackets", () => {
        const want = { ok: true, value: `${ID}[minecraft:damage=5,custom_name='"Edge"']` };
        expect(itemDataArgument(ID, `minecraft:damage=5,custom_name='"Edge"'`, "components")).toEqual(want);
        expect(itemDataArgument(ID, `[minecraft:damage=5, custom_name='"Edge"']`, "components")).toEqual(want);
    });

    it("takes the components as an inventory reads them back", () => {
        expect(itemDataArgument(ID, `{"minecraft:damage": 5}`, "components")).toEqual({
            ok: true,
            value: `${ID}[minecraft:damage=5]`
        });
    });

    it("keeps a removed default component bare", () => {
        expect(itemDataArgument(ID, "!minecraft:food", "components")).toEqual({
            ok: true,
            value: `${ID}[!minecraft:food]`
        });
    });

    it("names the older NBT compound as the wrong form", () => {
        expect(itemDataArgument(ID, "{Damage:5}", "components")).toEqual({ ok: false, why: "wrong-form" });
    });

    it("refuses a component with no value, an open bracket, or a control character", () => {
        expect(itemDataArgument(ID, "minecraft:damage", "components")).toEqual({ ok: false, why: "unreadable" });
        expect(itemDataArgument(ID, "[minecraft:damage=5", "components")).toEqual({ ok: false, why: "unreadable" });
        expect(itemDataArgument(ID, `minecraft:damage=5${String.fromCharCode(10)}say hi`, "components")).toEqual({
            ok: false,
            why: "unreadable"
        });
        expect(itemDataArgument(ID, "   ", "components")).toEqual({ ok: false, why: "unreadable" });
    });
});

describe("itemDataArgument before 1.20.5", () => {
    it("writes the compound right after the id", () => {
        expect(itemDataArgument(ID, `{Damage:5,display:{Name:'"Edge"'}}`, "tag")).toEqual({
            ok: true,
            value: `${ID}{Damage:5,display:{Name:'"Edge"'}}`
        });
    });

    it("names components as the wrong form", () => {
        expect(itemDataArgument(ID, "[minecraft:damage=5]", "tag")).toEqual({ ok: false, why: "wrong-form" });
        expect(itemDataArgument(ID, "minecraft:damage=5", "tag")).toEqual({ ok: false, why: "wrong-form" });
    });

    it("refuses a compound left open or with something after it", () => {
        expect(itemDataArgument(ID, "{Damage:5", "tag")).toEqual({ ok: false, why: "unreadable" });
        expect(itemDataArgument(ID, "{Damage:5} extra", "tag")).toEqual({ ok: false, why: "unreadable" });
    });
});

describe("itemDataArgument length", () => {
    it("refuses what one command argument cannot hold", () => {
        const long = `{Name:"${"x".repeat(MAX_ARGUMENT_LENGTH)}"}`;
        expect(itemDataArgument(ID, long, "tag")).toEqual({ ok: false, why: "too-long" });
    });
});

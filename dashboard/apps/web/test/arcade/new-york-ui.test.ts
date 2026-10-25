/**
 * The New York game's words and its keyboard.
 *
 * Every string the game shows is a key of its catalog
 * (`apps/arcade/messages/<locale>/new-york.json`): the page marks them with
 * `data-t*` attributes and the code reads them with `t("...")`. A key missing
 * from the catalog would be drawn as the key itself. And the frame has to take
 * the keyboard once the city is up - without it the car ignored WASD until
 * something in the game was clicked.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { flattenCatalog, type Catalog } from "@polaris/core";
import { mayTakeFocus } from "../../../arcade/src/screens/frame-focus";
import { gameMessages } from "../../../arcade/messages";
// @ts-expect-error - plain browser module without types
import { fill, readCatalog } from "../../../arcade/game/new-york/engine/i18n.js";

const GAME = resolve(__dirname, "../../../arcade/game/new-york");
const english = flattenCatalog(
    JSON.parse(
        readFileSync(resolve(__dirname, "../../../arcade/messages/en-US/new-york.json"), "utf8")
    ) as Catalog
);

/** Every literal key the game asks for, in its page and in its code. */
function usedKeys(): Set<string> {
    const keys = new Set<string>();
    const page = readFileSync(join(GAME, "index.html"), "utf8");
    for (const match of page.matchAll(/data-t(?:-title|-aria|-placeholder)?="([^"]+)"/g))
        keys.add(match[1]!);
    for (const file of readdirSync(join(GAME, "engine")).filter((name) => name.endsWith(".js"))) {
        const code = readFileSync(join(GAME, "engine", file), "utf8");
        for (const match of code.matchAll(/\bt\('([\w.]+)'/g)) keys.add(match[1]!);
    }
    return keys;
}

describe("the New York catalog", () => {
    it("holds every key the game's page and code ask for", () => {
        const keys = usedKeys();
        expect(keys.size).toBeGreaterThan(80);
        expect([...keys].filter((key) => !english.has(key))).toEqual([]);
    });

    it("is what the host sends, in the reader's language or else in English", () => {
        const spanish = readCatalog(gameMessages("es-ES", "new-york"));
        expect(spanish?.get("menu.resume")).toBe("Seguir");
        expect(readCatalog(gameMessages("fr-FR", "new-york"))?.get("menu.resume")).toBe("Resume");
    });

    it("leaves no on-screen text in the page itself", () => {
        const page = readFileSync(join(GAME, "index.html"), "utf8");
        expect(page).not.toMatch(/three\.js|WebGPU|TSL/);
        expect(page).not.toMatch(/s(?:title|aria-label|placeholder)="[^"]*[a-z]{3}/);
    });
});

describe("the game's catalog reader", () => {
    it("flattens nested strings", () => {
        expect([...readCatalog({ a: { b: "x" }, c: "y" })!]).toEqual([
            ["a.b", "x"],
            ["c", "y"]
        ]);
    });

    it("refuses anything that is not a catalog of strings", () => {
        expect(readCatalog(null)).toBeNull();
        expect(readCatalog(["x"])).toBeNull();
        expect(readCatalog({ a: 1 })).toBeNull();
        expect(readCatalog({ "bad key": "x" })).toBeNull();
        expect(readCatalog({ a: "x".repeat(501) })).toBeNull();
    });

    it("fills placeholders it knows and leaves the rest", () => {
        expect(fill("{place} · {other}", { place: "Times Sq" })).toBe("Times Sq · {other}");
    });
});

describe("the game frame and the keyboard", () => {
    const element = (tag: string, matches = false, inside = true) => {
        const doc = { body: {}, documentElement: {} };
        return {
            tagName: tag,
            ownerDocument: doc,
            matches: () => matches,
            inside
        } as unknown as Element & { inside: boolean };
    };
    const screen = { contains: (el: { inside: boolean }) => el.inside } as unknown as Element;

    it("takes it when nothing on the page has it", () => {
        expect(mayTakeFocus(null, screen)).toBe(true);
        const body = element("BODY");
        Object.assign(body.ownerDocument as object, { body });
        expect(mayTakeFocus(body, screen)).toBe(true);
    });

    it("takes it from the frame and from the game screen's own controls", () => {
        expect(mayTakeFocus(element("IFRAME"), screen)).toBe(true);
        expect(mayTakeFocus(element("A"), screen)).toBe(true);
    });

    it("never takes it from a field, or from elsewhere on the page", () => {
        expect(mayTakeFocus(element("INPUT", true), screen)).toBe(false);
        expect(mayTakeFocus(element("BUTTON", false, false), screen)).toBe(false);
    });
});

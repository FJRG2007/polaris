/**
 * Where the Ranks tab appears and what it is called.
 *
 * A tab is wired in four places that do not know about each other: the tab
 * list with its grant, the server's rail, the word the game catalog gives it
 * and the rail's own label. Missing any one of them is a screen that is absent,
 * or one that reads in English to a Spanish reader.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { installedAppSubapp } from "@/lib/apps";
import { GAME_TABS, tabsForGame } from "@/app/(app)/apps/installed/[id]/tabs";

const ID = "6f2d1c34-2b6b-4a4b-9f0e-1c2d3e4f5a6b";
const GAMES = "../game-servers/messages";

function json(path: string): Record<string, Record<string, string>> {
    return JSON.parse(readFileSync(path, "utf8"));
}

describe("the Ranks tab", () => {
    it("is offered on Minecraft only, to those who may run console commands", () => {
        const tab = GAME_TABS.find((one) => one.slug === "ranks");
        expect(tab?.permission).toBe("games.console");
        expect(tabsForGame("minecraft").map((one) => one.slug)).toContain("ranks");
        expect(tabsForGame("ark").map((one) => one.slug)).not.toContain("ranks");
        expect(tabsForGame("fivem").map((one) => one.slug)).not.toContain("ranks");
    });

    it("has a place on the server's rail, under its own path", () => {
        const subapp = installedAppSubapp(ID, { name: "Survival", tabs: ["", "players", "ranks"] });
        const section = subapp?.sections.find((one) => one.label === "Ranks");
        expect(section?.href).toBe(`/apps/installed/${ID}/ranks`);
    });

    it("is named in both languages, in the tab bar and on the rail", () => {
        const words = readFileSync("../game-servers/src/screens/game-text.ts", "utf8");
        expect(words).toMatch(/Ranks: "tabs\.ranks"/);
        for (const locale of ["en-US", "es-ES"]) {
            expect(json(`${GAMES}/${locale}/games.json`).tabs?.ranks, locale).toBeTruthy();
            const nav = JSON.stringify(json(`messages/${locale}/nav.json`));
            expect(nav, locale).toContain('"Ranks":');
        }
        expect(json(`${GAMES}/es-ES/games.json`).tabs?.ranks).toBe("Rangos");
    });
});

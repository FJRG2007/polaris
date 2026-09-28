/**
 * Telling which game is running from the list of running programs.
 *
 * What is pinned: each platform's list is read down to bare lowercased program
 * names, so one key means the same game everywhere; a game under a compatibility
 * layer on Linux is found by its Windows program; somebody's own additions win
 * over the built-in names; nothing on the built-in list is a program many
 * things share; and the watcher says a game once when it starts, again only as
 * the heartbeat, once when it stops - and nothing at all when it could not look.
 */

import { describe, expect, it } from "vitest";
import { KNOWN_GAMES } from "@/main/known-games";
import {
    GameWatcher,
    matchGame,
    parseCmdline,
    parsePs,
    parseTasklist,
    REPEAT_MS,
    type RunningGame
} from "@/main/game-detect";

describe("reading the list of programs", () => {
    it("reads tasklist's CSV", () => {
        const text = '"System Idle Process","0","Services","0","8 K"\r\n"Hollow_Knight.exe","4120","Console","1","512,000 K"\r\n';
        expect(parseTasklist(text)).toEqual(["system idle process", "hollow_knight.exe"]);
    });

    it("reads ps, whose names on macOS are paths", () => {
        expect(parsePs("/Applications/Factorio.app/Contents/MacOS/factorio\n/usr/sbin/cfprefsd\n")).toEqual([
            "factorio",
            "cfprefsd"
        ]);
    });

    it("finds a Windows game run through a compatibility layer on Linux", () => {
        const raw = ["/usr/bin/wine64-preloader", "Z:\\games\\ELDEN RING\\Game\\eldenring.exe", ""].join("\u0000");
        expect(parseCmdline(raw)).toEqual(["wine64-preloader", "eldenring.exe"]);
        expect(parseCmdline("")).toEqual([]);
    });
});

describe("matching a game", () => {
    it("knows a game by its program, whatever the case", () => {
        expect(matchGame(["explorer.exe", "EldenRing.exe"])).toEqual({ key: "eldenring.exe", name: "Elden Ring" });
        expect(matchGame(["explorer.exe", "code.exe"])).toBeNull();
    });

    it("lets somebody's own name for a program win", () => {
        expect(
            matchGame(["eldenring.exe"], [{ executable: "EldenRing.exe", name: "The one with the dragons" }])
        ).toEqual({ key: "eldenring.exe", name: "The one with the dragons" });
        expect(matchGame(["mygame"], [{ executable: "mygame", name: "My game" }])?.name).toBe("My game");
    });

    it("never treats a program many things share as a game", () => {
        const shared = ["java", "java.exe", "javaw.exe", "python", "python.exe", "node", "node.exe", "electron"];
        for (const game of KNOWN_GAMES) {
            for (const program of game.programs) {
                expect(shared).not.toContain(program);
                expect(program).toBe(program.toLowerCase());
                expect(program).not.toMatch(/[\\/]/);
            }
        }
    });
});

describe("watching for a game", () => {
    function watcher(lists: (string[] | Error)[]) {
        const said: (RunningGame | null)[] = [];
        let index = 0;
        const watch = new GameWatcher(
            (game) => said.push(game),
            async () => {
                const next = lists[Math.min(index++, lists.length - 1)]!;
                if (next instanceof Error) throw next;
                return next;
            }
        );
        return { watch, said };
    }

    it("says the game once when it starts, again only as a heartbeat, and once when it stops", async () => {
        const { watch, said } = watcher([["a.exe"], ["celeste.exe"], ["celeste.exe"], ["celeste.exe"], ["a.exe"]]);
        await watch.check(0);
        await watch.check(15_000);
        await watch.check(30_000);
        await watch.check(15_000 + REPEAT_MS);
        await watch.check(15_000 + REPEAT_MS + 15_000);
        expect(said.map((game) => game?.name ?? null)).toEqual([null, "Celeste", "Celeste", null]);
        expect(said[1]?.startedAt).toBe(new Date(15_000).toISOString());
    });

    it("changes nothing when it could not look", async () => {
        const { watch, said } = watcher([["celeste.exe"], new Error("no tasklist"), ["celeste.exe"]]);
        await watch.check(0);
        await watch.check(15_000);
        await watch.check(30_000);
        expect(said.map((game) => game?.name ?? null)).toEqual(["Celeste"]);
    });
});

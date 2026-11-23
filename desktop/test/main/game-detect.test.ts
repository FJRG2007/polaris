/**
 * Telling which game is running from the list of running programs.
 *
 * What is pinned: each platform's list is read down to bare lowercased program
 * names, so one key means the same game everywhere; a game under a compatibility
 * layer on Linux is found by its Windows program; somebody's own additions win
 * over the built-in names; nothing on the built-in list is a program many
 * things share; a program started from inside an installed store game's folder
 * is that game, by its store's name, unless it is the folder's crash reporter
 * or anti-cheat, or the folder is one that holds many games; and the watcher says a game once when it starts, again only as
 * the heartbeat, once when it stops - and nothing at all when it could not look.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { KNOWN_GAMES } from "@/main/known-games";
import {
    GameWatcher,
    matchGame,
    parseCmdline,
    parseProcessList,
    parsePs,
    parseTasklist,
    READER_SOURCE,
    REPEAT_MS,
    type RunningGame,
    type StoreGame,
    storeGameFolders,
    WindowsLister
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

describe("knowing a store game by its folder", () => {
    const folders = storeGameFolders([
        { name: "Hades II", folder: "D:/SteamLibrary/steamapps/common/Hades II/" },
        { name: "Satisfactory", folder: "C:\\Program Files\\Epic Games\\SatisfactoryEarlyAccess" },
        { name: "Mod kit", folder: "C:\\Program Files\\Epic Games\\SatisfactoryEarlyAccess\\ModKit" },
        { name: "Everything", folder: "C:\\Program Files" },
        { name: "A library", folder: "D:\\SteamLibrary\\steamapps\\common" },
        { name: "A drive", folder: "E:\\" },
        { name: "  ", folder: "C:\\Games\\Nameless" }
    ]);
    const at = (path: string) => ({ name: path.split("\\").at(-1)!.toLowerCase(), path });

    it("keeps only folders that hold one game, longest first", () => {
        expect(folders.map((game) => game.name)).toEqual(["Mod kit", "Satisfactory", "Hades II"]);
        expect(folders.find((game) => game.name === "Hades II")?.folder).toBe("d:\\steamlibrary\\steamapps\\common\\hades ii");
    });

    it("names a program from inside the folder the way its store does", () => {
        expect(matchGame([at("D:\\SteamLibrary\\steamapps\\common\\Hades II\\Ship\\Hades2.exe")], [], KNOWN_GAMES, folders)).toEqual({
            key: "hades2.exe",
            name: "Hades II"
        });
        expect(matchGame([at("C:\\Program Files\\Epic Games\\SatisfactoryEarlyAccess\\ModKit\\kit.exe")], [], KNOWN_GAMES, folders)?.name).toBe("Mod kit");
    });

    it("does not take a folder that only starts with the same letters, or a program anywhere else", () => {
        expect(matchGame([at("D:\\SteamLibrary\\steamapps\\common\\Hades II Demo\\Hades2.exe")], [], KNOWN_GAMES, folders)).toBeNull();
        expect(matchGame([at("C:\\Program Files\\Notepad++\\notepad++.exe")], [], KNOWN_GAMES, folders)).toBeNull();
        expect(matchGame(["hades2.exe"], [], KNOWN_GAMES, folders)).toBeNull();
    });

    it("never calls a crash reporter or anti-cheat left running in the folder the game", () => {
        for (const helper of ["UnityCrashHandler64.exe", "CrashReportClient.exe", "EasyAntiCheat.exe", "BEService.exe", "unins000.exe"]) {
            expect(matchGame([at(`D:\\SteamLibrary\\steamapps\\common\\Hades II\\${helper}`)], [], KNOWN_GAMES, folders)).toBeNull();
        }
    });

    it("lets somebody's own name and the built-in list come first", () => {
        const fortnite = at("C:\\Program Files\\Epic Games\\SatisfactoryEarlyAccess\\FortniteClient-Win64-Shipping.exe");
        expect(matchGame([fortnite], [], KNOWN_GAMES, folders)?.name).toBe("Fortnite");
        expect(matchGame([fortnite], [{ executable: "fortniteclient-win64-shipping.exe", name: "Mine" }], KNOWN_GAMES, folders)?.name).toBe("Mine");
    });
});

describe("watching for a game", () => {
    function watcher(lists: (readonly (string | { name: string; path?: string; })[] | Error)[], games?: () => readonly StoreGame[]) {
        const said: (RunningGame | null)[] = [];
        let index = 0;
        let looks = 0;
        const watch = new GameWatcher(
            (game) => said.push(game),
            async () => {
                looks += 1;
                const next = lists[Math.min(index++, lists.length - 1)]!;
                if (next instanceof Error) throw next;
                return next;
            },
            games
        );
        return { watch, said, looks: () => looks };
    }

    it("knows a store game from the listing it is handed, with one process read per look", async () => {
        let listing: readonly StoreGame[] = [];
        const asked = vi.fn(() => listing);
        const path = "C:\\Games\\Hades II\\Hades2.exe";
        const { watch, said, looks } = watcher([[{ name: "hades2.exe", path }]], asked);
        await watch.check(0);
        listing = [{ name: "Hades II", folder: "C:\\Games\\Hades II" }];
        await watch.check(15_000);
        await watch.check(30_000);
        expect(said.map((game) => game?.name ?? null)).toEqual([null, "Hades II"]);
        expect(said[1]?.key).toBe("hades2.exe");
        expect(looks()).toBe(3);
        expect(asked).toHaveBeenCalledTimes(3);
    });

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

    it("recognizes a game added while it is already running at once", async () => {
        const { watch, said } = watcher([["mygame.exe"]]);
        watch.start();
        await new Promise((resolve) => setTimeout(resolve, 10));
        watch.setCustomGames([{ executable: "mygame.exe", name: "My game" }]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        watch.stop();
        expect(said.map((game) => game?.name ?? null)).toEqual([null, "My game"]);
    });

    it("changes nothing when it could not look", async () => {
        const { watch, said } = watcher([["celeste.exe"], new Error("no tasklist"), ["celeste.exe"]]);
        await watch.check(0);
        await watch.check(15_000);
        await watch.check(30_000);
        expect(said.map((game) => game?.name ?? null)).toEqual(["Celeste"]);
    });
});

/** A stand-in PowerShell: answers each list command with `names` (lines as
 *  the reader prints them), or stays silent, or exits, or never stops
 *  printing, as the test says. */
function fakeShell(behavior: { names?: string[]; silent?: boolean; exitOnAsk?: boolean; flood?: boolean; }) {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        child.exitCode = 1;
        child.emit("exit", 1);
        return true;
    };
    const asked: string[] = [];
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (line: string) => {
        asked.push(line);
        const end = /'(<<[^']+>>)'/.exec(line)?.[1];
        if (!end) return;
        if (behavior.exitOnAsk) {
            child.exitCode = 1;
            child.emit("exit", 1);
            return;
        }
        if (behavior.silent) return;
        if (behavior.flood) {
            const line = `${"x".repeat(1023)}\n`;
            for (let at = 0; at < 4200; at++) child.stdout.write(line);
            return;
        }
        // Split across chunks, the way a pipe can hand it over.
        const text = `${(behavior.names ?? []).join("\r\n")}\r\n${end}\r\n`;
        const half = Math.floor(text.length / 2);
        child.stdout.write(text.slice(0, half));
        setTimeout(() => child.stdout.write(text.slice(half)), 0);
    });
    return { child: child as unknown as ChildProcessWithoutNullStreams, asked };
}

describe("listing programs on Windows", () => {
    it("reads each program's name and the file it was started from", () => {
        const text = "Hollow_Knight\tD:\\Games\\Hollow Knight\\hollow_knight.exe\r\nexplorer\t\r\n\r\n  steam  \r\nodd\trelative\\odd.exe\r\nSystem\t\r\n";
        expect(parseProcessList(text)).toEqual([
            { name: "hollow_knight.exe", path: "D:\\Games\\Hollow Knight\\hollow_knight.exe" },
            { name: "explorer.exe" },
            { name: "steam.exe" },
            { name: "odd.exe" },
            { name: "system.exe" }
        ]);
    });

    it("keeps a bounded list, and drops a path too long to be real", () => {
        expect(parseProcessList("a\n".repeat(6000))).toHaveLength(5000);
        expect(parseProcessList(`game\tC:\\${"x".repeat(1100)}.exe`)).toEqual([{ name: "game.exe" }]);
    });

    it("compiles its reader once per shell, from a source that fits in one quoted line", async () => {
        expect(READER_SOURCE).not.toMatch(/['\r\n]/);
        const shell = fakeShell({ names: ["Celeste\tC:\\Games\\Celeste\\Celeste.exe"] });
        const lister = new WindowsLister(() => shell.child, async () => []);
        expect(await lister.list()).toEqual([{ name: "celeste.exe", path: "C:\\Games\\Celeste\\Celeste.exe" }]);
        await lister.list();
        expect(shell.asked.filter((line) => line.includes("Add-Type"))).toHaveLength(1);
        expect(shell.asked.filter((line) => line.includes("PolarisProcessList]::Read()"))).toHaveLength(2);
    });

    it("gives up on a list too long to be real and asks tasklist instead", async () => {
        const shell = fakeShell({ flood: true });
        const lister = new WindowsLister(() => shell.child, async () => ["from-tasklist.exe"]);
        expect(await lister.list()).toEqual([{ name: "from-tasklist.exe" }]);
        expect(shell.child.killed).toBe(true);
    });

    it("keeps one shell open and asks it again", async () => {
        const shells: ReturnType<typeof fakeShell>[] = [];
        const lister = new WindowsLister(() => {
            const shell = fakeShell({ names: ["Celeste", "explorer"] });
            shells.push(shell);
            return shell.child;
        }, async () => ["tasklist.exe"]);
        expect(await lister.list()).toEqual([{ name: "celeste.exe" }, { name: "explorer.exe" }]);
        expect(await lister.list()).toEqual([{ name: "celeste.exe" }, { name: "explorer.exe" }]);
        expect(shells).toHaveLength(1);
        expect(matchGame(await lister.list())?.name).toBe("Celeste");
    });

    it("answers two looks asked at once with one list", async () => {
        const shell = fakeShell({ names: ["explorer"] });
        const lister = new WindowsLister(() => shell.child, async () => []);
        const [a, b] = await Promise.all([lister.list(), lister.list()]);
        expect(a).toEqual(b);
        expect(shell.asked.filter((line) => line.includes("Get-Process"))).toHaveLength(1);
    });

    it("falls back to tasklist when the shell goes away, and starts a new one next time", async () => {
        let started = 0;
        const lister = new WindowsLister(() => {
            started += 1;
            return fakeShell(started === 1 ? { exitOnAsk: true } : { names: ["explorer"] }).child;
        }, async () => ["from-tasklist.exe"]);
        expect(await lister.list()).toEqual([{ name: "from-tasklist.exe" }]);
        expect(await lister.list()).toEqual([{ name: "explorer.exe" }]);
        expect(started).toBe(2);
    });

    it("gives up on a shell that does not answer", async () => {
        vi.useFakeTimers();
        try {
            const shell = fakeShell({ silent: true });
            const lister = new WindowsLister(() => shell.child, async () => ["from-tasklist.exe"]);
            const look = lister.list();
            // A new shell is given longer, for the reader it compiles first.
            await vi.advanceTimersByTimeAsync(10_000);
            expect(shell.child.killed).toBe(false);
            await vi.advanceTimersByTimeAsync(20_000);
            expect(await look).toEqual([{ name: "from-tasklist.exe" }]);
            expect(shell.child.killed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

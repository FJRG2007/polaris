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

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { KNOWN_GAMES } from "@/main/known-games";
import {
    GameWatcher,
    matchGame,
    parseCmdline,
    parseProcessNames,
    parsePs,
    parseTasklist,
    REPEAT_MS,
    type RunningGame,
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

/** A stand-in PowerShell: answers each list command with `names`, or stays
 *  silent, or exits, as the test says. */
function fakeShell(behavior: { names?: string[]; silent?: boolean; exitOnAsk?: boolean; }) {
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
        // Split across chunks, the way a pipe can hand it over.
        const text = `${(behavior.names ?? []).join("\r\n")}\r\n${end}\r\n`;
        const half = Math.floor(text.length / 2);
        child.stdout.write(text.slice(0, half));
        setTimeout(() => child.stdout.write(text.slice(half)), 0);
    });
    return { child: child as unknown as ChildProcessWithoutNullStreams, asked };
}

describe("listing programs on Windows", () => {
    it("reads PowerShell's names back as program keys", () => {
        expect(parseProcessNames("Hollow_Knight\r\nexplorer\r\n\r\n  steam  \r\n")).toEqual(["hollow_knight.exe", "explorer.exe", "steam.exe"]);
    });

    it("keeps one shell open and asks it again", async () => {
        const shells: ReturnType<typeof fakeShell>[] = [];
        const lister = new WindowsLister(() => {
            const shell = fakeShell({ names: ["Celeste", "explorer"] });
            shells.push(shell);
            return shell.child;
        }, async () => ["tasklist.exe"]);
        expect(await lister.list()).toEqual(["celeste.exe", "explorer.exe"]);
        expect(await lister.list()).toEqual(["celeste.exe", "explorer.exe"]);
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
        expect(await lister.list()).toEqual(["from-tasklist.exe"]);
        expect(await lister.list()).toEqual(["explorer.exe"]);
        expect(started).toBe(2);
    });

    it("gives up on a shell that does not answer", async () => {
        vi.useFakeTimers();
        try {
            const shell = fakeShell({ silent: true });
            const lister = new WindowsLister(() => shell.child, async () => ["from-tasklist.exe"]);
            const look = lister.list();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await look).toEqual(["from-tasklist.exe"]);
            expect(shell.child.killed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

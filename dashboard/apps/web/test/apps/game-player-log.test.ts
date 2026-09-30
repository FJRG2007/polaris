/**
 * Reading arrivals and departures that RCON chatter cannot drown, without reading
 * a 125 MB log again every few seconds.
 *
 * On the operator's server the last 1500 lines of the container's log were all
 * "Thread RCON Client /0:0:0:0:0:0:0:1 started" and "shutting down" - two per
 * command Polaris sends - and not one join, while `logs/latest.log` had grown to
 * 125 MB. The lines about players are picked out of that file inside the container,
 * and a cursor per server makes each read take only what was written since the last.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { parseJoinAddresses } from "@polaris-app/game-servers/src/lib/minecraft/parse";
import { appendFileSync, mkdtempSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import {
    KEPT_LINES,
    NO_PLAYER_LOG,
    OVERLAP_BYTES,
    SCAN_BYTES,
    STEP_BYTES,
    nextPlayerLog,
    playerLogScript,
    type PlayerLogState
} from "@polaris-app/game-servers/src/lib/minecraft/player-log";
import { logConnection, parsePlayerSessions, sessionsByPlayer } from "@polaris-app/game-servers/src/lib/minecraft/sessions";

/** A NeoForge 1.21.4 `latest.log` line, as the operator's server writes them. */
function neo(stamp: string, logger: string, message: string, thread = "Server thread"): string {
    return `[${stamp}] [${thread}/INFO] [${logger}/]: ${message}`;
}

/** The chatter one `rcon-cli` call leaves, N times over. */
function chatter(count: number, stamp: string): string {
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
        lines.push(neo(stamp, "net.minecraft.server.rcon.thread.RconThread", "Thread RCON Client /0:0:0:0:0:0:0:1 started", "RCON Listener #1"));
        lines.push(neo(stamp, "net.minecraft.server.rcon.thread.RconClient", "Thread RCON Client /0:0:0:0:0:0:0:1 shutting down", `RCON Client /0:0:0:0:0:0:0:1 #${index}`));
    }
    return `${lines.join("\n")}\n`;
}

const JOIN = [
    neo("30Sep2026 20:26:05.000", "net.minecraft.server.players.PlayerList", "PICHURRINA[/203.0.113.9:51001] logged in with entity id 412 at (100.5, 64.0, -20.3)"),
    neo("30Sep2026 20:26:05.000", "net.minecraft.server.MinecraftServer", "PICHURRINA joined the game")
].join("\n");
const LEAVE = [
    neo("30Sep2026 21:00:00.000", "net.minecraft.server.network.ServerGamePacketListenerImpl", "PICHURRINA lost connection: Disconnected"),
    neo("30Sep2026 21:00:00.100", "net.minecraft.server.MinecraftServer", "PICHURRINA left the game")
].join("\n");

/** What the script prints, as the container would: its three header lines and
 *  the matching lines of the bytes it read. */
function output(inode: number, size: number, from: number, lines: string[], offset = "+0000"): string {
    return [`@clock ${offset} 2026-09-30`, `@stat ${inode} ${size} 2026-09-30`, `@from ${from}`, ...lines].join("\n");
}

function sessions(state: PlayerLogState) {
    return parsePlayerSessions(state.lines.join("\n"));
}

describe("the cursor", () => {
    it("finds the one join a tail of RCON chatter hides", () => {
        // What the container's own log hands back: its newest 1500 lines, all
        // chatter. Not one of them is about a player.
        const tail = chatter(2000, "30Sep2026 21:10:00.000")
            .split("\n")
            .filter(Boolean)
            .slice(-1500)
            .map((line) => `2026-09-30T21:10:00.000000000Z ${line}`)
            .join("\n");
        expect(parsePlayerSessions(tail)).toEqual([]);

        const state = nextPlayerLog(NO_PLAYER_LOG, output(7, 125_000_000, 125_000_000 - SCAN_BYTES, JOIN.split("\n")))!;
        expect(sessions(state)).toEqual([
            { name: "PICHURRINA", kind: "join", at: "2026-09-30T20:26:05.000Z", address: "203.0.113.9" }
        ]);
        expect(logConnection(sessionsByPlayer(sessions(state)).get("pichurrina") ?? []).since).toBe(
            "2026-09-30T20:26:05.000Z"
        );
        // The address guard and the chat relay read the same lines.
        expect(parseJoinAddresses(state.lines.join("\n")).get("pichurrina")).toBe("203.0.113.9");
        expect(state.cursor).toEqual({ inode: "7", offset: 125_000_000 });
    });

    it("moves on as the file grows, keeping what it found and never keeping a line twice", () => {
        const first = nextPlayerLog(NO_PLAYER_LOG, output(7, 5000, 0, JOIN.split("\n")))!;
        // The next read starts a little before the cursor and sees the join again.
        const second = nextPlayerLog(first, output(7, 9000, 5000 - OVERLAP_BYTES, [...JOIN.split("\n"), ...LEAVE.split("\n")]))!;
        expect(second.cursor).toEqual({ inode: "7", offset: 9000 });
        expect(sessions(second).map((event) => event.kind)).toEqual(["join", "leave"]);
        // A read that found nothing new still answers with what was kept.
        const third = nextPlayerLog(second, output(7, 9500, 9000 - OVERLAP_BYTES, []))!;
        expect(third.lines).toEqual(second.lines);
    });

    it("keeps a bounded number of lines", () => {
        const many = Array.from({ length: KEPT_LINES + 50 }, (_, index) =>
            neo(`30Sep2026 20:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000`, "net.minecraft.server.MinecraftServer", `P${index} joined the game`)
        );
        const state = nextPlayerLog(NO_PLAYER_LOG, output(7, 1, 0, many))!;
        expect(state.lines).toHaveLength(KEPT_LINES);
        expect(state.lines.at(-1)).toContain(`P${KEPT_LINES + 49} joined`);
    });

    it("leaves the state alone and says so when there is no file to read", () => {
        expect(nextPlayerLog(NO_PLAYER_LOG, "")).toBeNull();
        expect(nextPlayerLog(NO_PLAYER_LOG, "OCI runtime exec failed")).toBeNull();
    });

    it("dates vanilla's time-of-day stamps, across a midnight, from the file's last write", () => {
        const state = nextPlayerLog(
            NO_PLAYER_LOG,
            [
                "@clock +0200 2026-10-01",
                "@stat 7 300 2026-10-01",
                "@from 0",
                "[23:59:50] [Server thread/INFO]: FJRG2007 joined the game",
                "[00:00:10 INFO]: FJRG2007 lost connection: Disconnected",
                "[00:00:10 INFO]: FJRG2007 left the game",
                "07 joined the game"
            ].join("\n")
        )!;
        expect(sessions(state).map((event) => `${event.kind}@${event.at}`)).toEqual([
            "join@2026-09-30T21:59:50.000Z",
            "leave@2026-09-30T22:00:10.000Z"
        ]);
    });

    it("asks for the new bytes only, and for a bounded scan when it has no cursor", () => {
        const fresh = playerLogScript(null);
        expect(fresh).toContain('[ "$i" = "none" ]');
        expect(fresh).toContain(`from=$((s - ${SCAN_BYTES}))`);
        const next = playerLogScript({ inode: "7", offset: 9000 });
        expect(next).toContain('[ "$i" = "7" ] && [ "$s" -ge 9000 ]');
        // Nothing that did not come from a stat can reach the shell.
        expect(playerLogScript({ inode: "7; rm -rf /", offset: -5 })).toContain('[ "$i" = "none" ] && [ "$s" -ge 0 ]');
    });
});

/** The script itself, against a real file, through whatever `sh` this machine has. */
function shell(): string | null {
    for (const candidate of ["sh", "C:/Program Files/Git/bin/sh.exe"]) {
        try {
            execFileSync(candidate, ["-c", "stat -c %i . && true"], { stdio: "ignore" });
            return candidate;
        } catch {
            // Not here.
        }
    }
    return null;
}

describe("the script, run", () => {
    const sh = shell();
    const read = (file: string, state: PlayerLogState) => {
        const script = playerLogScript(state.cursor).replace("f=/data/logs/latest.log", `f='${file.replaceAll("\\", "/")}'`);
        const printed = execFileSync(sh!, ["-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TZ: "UTC" } });
        expect(Buffer.byteLength(printed)).toBeLessThan(16 * 1024);
        return { printed, next: nextPlayerLog(state, printed)! };
    };
    const from = (printed: string) => Number(/@from (\d+)/.exec(printed)?.[1]);

    it.runIf(sh)("reads only what was written since, through growth, truncation and rotation", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-player-log-"));
        const file = join(dir, "latest.log");
        writeFileSync(file, `${chatter(3000, "30Sep2026 20:00:00.000")}${JOIN}\n${chatter(3000, "30Sep2026 20:30:00.000")}`);

        const first = read(file, NO_PLAYER_LOG);
        expect(from(first.printed)).toBe(0);
        expect(sessions(first.next).map((event) => event.kind)).toEqual(["join"]);
        const size = first.next.cursor!.offset;

        // Growth: only the new bytes, from just before the cursor.
        appendFileSync(file, `${chatter(500, "30Sep2026 20:59:00.000")}${LEAVE}\n`);
        const grown = read(file, first.next);
        expect(from(grown.printed)).toBe(size - OVERLAP_BYTES);
        expect(sessions(grown.next).map((event) => event.kind)).toEqual(["join", "leave"]);

        // Truncation: the same file, now shorter than the cursor, is scanned again.
        truncateSync(file, 0);
        appendFileSync(file, `${JOIN.replaceAll("20:26:05", "22:00:00")}\n`);
        const cut = read(file, grown.next);
        expect(from(cut.printed)).toBe(0);
        expect(sessions(cut.next).map((event) => `${event.kind}@${event.at}`)).toEqual([
            "join@2026-09-30T20:26:05.000Z",
            "leave@2026-09-30T21:00:00.000Z",
            "join@2026-09-30T22:00:00.000Z"
        ]);

        // Rotation: a new file under the same name, longer than the cursor.
        const rotated = join(dir, "next.log");
        writeFileSync(rotated, `${chatter(6000, "01Oct2026 00:00:00.000")}${LEAVE.replaceAll("30Sep2026 21:00", "01Oct2026 00:30")}\n`);
        renameSync(rotated, file);
        const turned = read(file, cut.next);
        expect(turned.next.cursor!.inode).not.toBe(cut.next.cursor!.inode);
        expect(from(turned.printed)).toBe(0);
        expect(sessions(turned.next).at(-1)).toMatchObject({ kind: "leave", at: "2026-10-01T00:30:00.000Z" });
    });

    it.runIf(sh)("never takes more than a step's worth of a file that grew past it", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-player-log-"));
        const file = join(dir, "latest.log");
        writeFileSync(file, `${JOIN}\n`);
        const first = read(file, NO_PLAYER_LOG);
        appendFileSync(file, Buffer.alloc(STEP_BYTES + 4096, "x"));
        appendFileSync(file, `\n${LEAVE}\n`);
        const second = read(file, first.next);
        const size = second.next.cursor!.offset;
        expect(from(second.printed)).toBe(size - STEP_BYTES);
        // The leave at the end is still read; the join before the skipped bytes is kept.
        expect(sessions(second.next).map((event) => event.kind)).toEqual(["join", "leave"]);
    });
});

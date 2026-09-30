/**
 * Reading arrivals and departures that RCON chatter cannot drown.
 *
 * On the operator's server the last 1500 lines of the container's log were all
 * "Thread RCON Client /0:0:0:0:0:0:0:1 started" and "shutting down" - two per
 * command Polaris sends - and not one join. The lines about players are now picked
 * out inside the container before anything is cut, and their stamps turned into
 * the same instants the container's log carries.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { parseJoinAddresses } from "@polaris-app/game-servers/src/lib/minecraft/parse";
import { PLAYER_LOG_SCRIPT, playerLogLines } from "@polaris-app/game-servers/src/lib/minecraft/player-log";
import { logConnection, parsePlayerSessions, sessionsByPlayer } from "@polaris-app/game-servers/src/lib/minecraft/sessions";

/** A NeoForge 1.21.4 `latest.log` line. */
function neo(stamp: string, thread: string, logger: string, message: string): string {
    return `[${stamp}] [${thread}/INFO] [${logger}/]: ${message}`;
}

/** The chatter one `rcon-cli` call leaves, N times over. */
function chatter(count: number, stamp: string): string[] {
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
        lines.push(neo(stamp, "RCON Listener #1", "net.minecraft.server.rcon.thread.RconThread", "Thread RCON Client /0:0:0:0:0:0:0:1 started"));
        lines.push(neo(stamp, `RCON Client /0:0:0:0:0:0:0:1 #${index}`, "net.minecraft.server.rcon.thread.RconClient", "Thread RCON Client /0:0:0:0:0:0:0:1 shutting down"));
    }
    return lines;
}

const LATEST = [
    neo("30Sep2026 07:00:00.000", "Server thread", "net.minecraft.server.dedicated.DedicatedServer", "Starting minecraft server version 1.21.4"),
    ...chatter(400, "30Sep2026 08:00:00.000"),
    neo("30Sep2026 09:12:30.250", "Server thread", "net.minecraft.server.players.PlayerList", "FJRG2007[/203.0.113.9:51001] logged in with entity id 412 at (100.5, 64.0, -20.3)"),
    neo("30Sep2026 09:12:30.300", "Server thread", "net.minecraft.server.MinecraftServer", "FJRG2007 joined the game"),
    ...chatter(5000, "30Sep2026 10:00:00.000"),
    ""
].join("\n");

/** What the script prints for that file, in a container on UTC+2. */
function scriptOutput(latest: string): string {
    const picked = latest
        .split("\n")
        .filter((line) => /logged in with entity id|joined the game|left the game|lost connection: |Starting minecraft server version|Stopping server/.test(line));
    return ["@clock +0200 2026-09-30", "@file latest.log 2026-09-30", ...picked].join("\n");
}

describe("the player log", () => {
    it("finds the one join a tail of RCON chatter hides", () => {
        // What the container's own log hands back: its newest 1500 lines, with
        // docker's stamp in front. Not one of them is about a player.
        const tail = LATEST.split("\n")
            .filter(Boolean)
            .slice(-1500)
            .map((line) => `2026-09-30T08:00:00.000000000Z ${line}`)
            .join("\n");
        expect(parsePlayerSessions(tail)).toEqual([]);

        const lines = playerLogLines(scriptOutput(LATEST));
        expect(lines).not.toBeNull();
        const events = parsePlayerSessions(lines!);
        expect(events).toEqual([
            { name: "FJRG2007", kind: "join", at: "2026-09-30T07:12:30.250Z", address: "203.0.113.9" }
        ]);
        expect(logConnection(sessionsByPlayer(events).get("fjrg2007") ?? [])).toMatchObject({
            online: true,
            since: "2026-09-30T07:12:30.250Z"
        });
        // The address guard and the chat relay read the same lines.
        expect(parseJoinAddresses(lines!).get("fjrg2007")).toBe("203.0.113.9");
    });

    it("dates vanilla's time-of-day stamps, across a midnight, from the end of the file", () => {
        const output = [
            "@clock +0000 2026-09-30",
            "@file latest.log 2026-09-30",
            "[23:59:50] [Server thread/INFO]: FJRG2007 joined the game",
            "[00:00:10 INFO]: FJRG2007 lost connection: Disconnected",
            "[00:00:10 INFO]: FJRG2007 left the game"
        ].join("\n");
        expect(parsePlayerSessions(playerLogLines(output)!).map((event) => `${event.kind}@${event.at}`)).toEqual([
            "join@2026-09-29T23:59:50.000Z",
            "leave@2026-09-30T00:00:10.000Z"
        ]);
    });

    it("dates a rotated file by its name, and keeps it before the current one", () => {
        const output = [
            "@clock -0300 2026-09-30",
            "@file 2026-09-29-1.log.gz 2026-09-30",
            "[22:00:00] [Server thread/INFO]: PICHURRINA joined the game",
            "",
            "@file latest.log 2026-09-30",
            "[01:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4",
            "[01:05:00] [Server thread/INFO]: PICHURRINA joined the game"
        ].join("\n");
        const events = parsePlayerSessions(playerLogLines(output)!);
        expect(events.map((event) => `${event.kind}@${event.at}`)).toEqual([
            "join@2026-09-30T01:00:00.000Z",
            "leave@2026-09-30T04:00:00.000Z",
            "join@2026-09-30T04:05:00.000Z"
        ]);
    });

    it("drops a line the size cap cut in half", () => {
        const output = ["@clock +0000 2026-09-30", "@file latest.log 2026-09-30", "07 joined the game", "[10:00:00] [Server thread/INFO]: Alex joined the game"].join("\n");
        expect(parsePlayerSessions(playerLogLines(output)!).map((event) => event.name)).toEqual(["Alex"]);
    });

    it("says it found nothing to read, so the container's log is read instead", () => {
        // Bedrock writes no log files; neither does a container that answered with
        // something else entirely.
        expect(playerLogLines("@clock +0000 2026-09-30\n")).toBeNull();
        expect(playerLogLines("OCI runtime exec failed")).toBeNull();
        // A file with nobody in it is an answer, not a reason to fall back.
        expect(playerLogLines("@clock +0000 2026-09-30\n@file latest.log 2026-09-30\n")).toBe("");
    });

    it("runs as written, picking the lines out of the files a server keeps", () => {
        // The script itself, against a directory laid out like the image's.
        let shell: string | null = null;
        for (const candidate of ["sh", "C:/Program Files/Git/bin/sh.exe"]) {
            try {
                execFileSync(candidate, ["-c", "true"]);
                shell = candidate;
                break;
            } catch {
                // Not on this machine.
            }
        }
        if (!shell) return;
        const root = mkdtempSync(join(tmpdir(), "polaris-player-log-"));
        mkdirSync(join(root, "logs"));
        writeFileSync(join(root, "logs", "latest.log"), LATEST);
        const script = PLAYER_LOG_SCRIPT.replaceAll("/data/logs", `${root.replaceAll("\\", "/")}/logs`);
        const output = execFileSync(shell, ["-c", script], { encoding: "utf8" });
        // Under the 16 KiB one command can return, however much chatter there was.
        expect(Buffer.byteLength(output)).toBeLessThan(16 * 1024);
        const events = parsePlayerSessions(playerLogLines(output)!);
        expect(events.map((event) => `${event.name} ${event.kind}`)).toEqual(["FJRG2007 join"]);
    });
});

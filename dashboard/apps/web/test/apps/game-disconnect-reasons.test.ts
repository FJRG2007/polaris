/**
 * Why a Minecraft player went, or why the server would not let them in.
 *
 * The server prints its reason on the network layer's line - timed out, kicked
 * with a message, banned, not on the whitelist, an outdated client - and the
 * player history only ever said "Left". These pin that every reason the server
 * prints is read off the log with a label, the raw words kept, and that an
 * attempt turned away at the door is recorded as one rather than as a visit.
 */

import { describe, expect, it } from "vitest";
import {
    classifyDisconnect,
    parsePlayerSessions,
    playerActivity
} from "@polaris-app/game-servers/src/lib/minecraft/sessions";

const at = (minute: number, line: string) =>
    `2026-08-08T10:${String(minute).padStart(2, "0")}:00.000000000Z [10:${minute}:00] [Server thread/INFO]: ${line}`;

const join = (minute: number, name: string) => [
    at(minute, `${name}[/203.0.113.9:52344] logged in with entity id 231 at (1.5, 64.0, -8.5)`),
    at(minute, `${name} joined the game`)
];

describe("a departure's reason", () => {
    it("reads a timeout off the network line and keeps one event for the two lines", () => {
        const events = parsePlayerSessions(
            [...join(1, "Alice"), at(9, "Alice lost connection: Timed out"), at(9, "Alice left the game")].join("\n")
        );
        expect(events.filter((event) => event.kind === "leave")).toEqual([
            {
                name: "Alice",
                kind: "leave",
                at: "2026-08-08T10:09:00.000000000Z",
                address: null,
                reason: { kind: "timeout", raw: "Timed out" }
            }
        ]);
    });

    it("says a kick was a kick, with the operator's own message", () => {
        const events = parsePlayerSessions(
            [
                ...join(1, "Bob"),
                at(5, "Kicked Bob: Spamming the chat"),
                at(5, "Bob lost connection: Spamming the chat"),
                at(5, "Bob left the game")
            ].join("\n")
        );
        expect(events.at(-1)?.reason).toEqual({ kind: "kicked", raw: "Spamming the chat" });
    });

    it("tells a quit, a ban and a duplicate login apart", () => {
        const events = parsePlayerSessions(
            [
                ...join(1, "Ann"),
                at(2, "Ann lost connection: Disconnected"),
                ...join(3, "Ben"),
                at(4, "Ben lost connection: You are banned from this server."),
                ...join(5, "Cy"),
                at(6, "Cy lost connection: You logged in from another location")
            ].join("\n")
        );
        expect(events.filter((event) => event.kind === "leave").map((event) => event.reason?.kind)).toEqual([
            "quit",
            "banned",
            "duplicate"
        ]);
    });

    it("gives the server stopping as the reason for everybody still on", () => {
        const events = parsePlayerSessions(
            [...join(1, "Dee"), at(7, "Stopping server"), at(7, "Dee lost connection: Server closed")].join("\n")
        );
        expect(events.at(-1)).toMatchObject({ kind: "leave", reason: { kind: "shutdown" } });
        expect(events.filter((event) => event.kind === "refused")).toEqual([]);
    });

    it("leaves a departure with no reason as it always was", () => {
        const events = parsePlayerSessions([...join(1, "Eve"), at(2, "Eve left the game")].join("\n"));
        expect(events.at(-1)).toEqual({
            name: "Eve",
            kind: "leave",
            at: "2026-08-08T10:02:00.000000000Z",
            address: null
        });
    });
});

describe("an attempt the server turned away", () => {
    it("records the whitelist refusal of a newer server, by name", () => {
        const events = parsePlayerSessions(
            at(3, "Mallory (/198.51.100.4:41221) lost connection: You are not white-listed on this server!")
        );
        expect(events).toEqual([
            {
                name: "Mallory",
                kind: "refused",
                at: "2026-08-08T10:03:00.000000000Z",
                address: null,
                reason: { kind: "whitelist", raw: "You are not white-listed on this server!" }
            }
        ]);
    });

    it("reads the older wording, with the profile authlib logs", () => {
        const events = parsePlayerSessions(
            at(
                3,
                "Disconnecting com.mojang.authlib.GameProfile@1b2c3d[id=<null>,name=Oscar,properties={},legacy=false] (/192.0.2.7:5000): Outdated client! Please use 1.21.4"
            )
        );
        expect(events).toMatchObject([
            { name: "Oscar", kind: "refused", reason: { kind: "outdated", raw: "Outdated client! Please use 1.21.4" } }
        ]);
    });

    it("folds the two lines one refusal prints into one", () => {
        const events = parsePlayerSessions(
            [
                at(3, "Disconnecting Pat (/192.0.2.8:5001): The server is full!"),
                at(3, "Pat (/192.0.2.8:5001) lost connection: The server is full!")
            ].join("\n")
        );
        expect(events).toHaveLength(1);
        expect(events[0]?.reason?.kind).toBe("full");
    });

    it("ignores a dropped connection that never had a name", () => {
        expect(parsePlayerSessions(at(3, "/203.0.113.9:5555 lost connection: Disconnected"))).toEqual([]);
    });

    it("is never a visit: somebody only ever refused has not played", () => {
        const events = parsePlayerSessions(
            at(3, "Mallory (/198.51.100.4:41221) lost connection: You are not white-listed on this server!")
        );
        expect(playerActivity(events, false, Date.parse("2026-08-08T11:00:00Z"))).toEqual({
            presence: "never",
            lastSeen: null
        });
    });
});

describe("classifying the server's words", () => {
    it("labels every reason it prints, and keeps anything else as other", () => {
        const cases: [string, string][] = [
            ["Timed out", "timeout"],
            ["Internal Exception: io.netty.handler.timeout.ReadTimeoutException", "timeout"],
            ["Took too long to log in", "timeout"],
            ["Kicked by an operator", "kicked"],
            ["You have been idle for too long!", "idle"],
            ["Failed to verify username!", "auth"],
            ["Flying is not enabled on this server", "flying"],
            ["Internal Exception: java.io.IOException: Connection reset", "network"],
            ["Incompatible client! Please use 1.21.4", "outdated"],
            ["§cYou are banned §rfrom this server", "banned"],
            ["See you on the lobby server", "other"]
        ];
        for (const [raw, kind] of cases) expect(classifyDisconnect(raw).kind, raw).toBe(kind);
        expect(classifyDisconnect("§cYou are banned").raw).toBe("You are banned");
    });
});

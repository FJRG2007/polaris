import { describe, expect, it } from "vitest";
import { parsePlayerSessions, playerActivity, sessionsByPlayer } from "@/lib/apps/minecraft/sessions";

/** A Java server's log, as docker hands it back: RFC3339 stamp, then the line. */
const JAVA_LOG = [
    "2026-08-08T10:00:00.000000000Z [10:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4",
    "2026-08-08T10:01:00.000000000Z [10:01:00] [User Authenticator #1/INFO]: UUID of player Alice is 0000",
    "2026-08-08T10:01:01.000000000Z [10:01:01] [Server thread/INFO]: Alice[/203.0.113.9:52344] logged in with entity id 231 at (1.5, 64.0, -8.5)",
    "2026-08-08T10:01:01.500000000Z [10:01:01] [Server thread/INFO]: Alice joined the game",
    "2026-08-08T10:20:00.000000000Z [10:20:00] [Server thread/INFO]: Bob[/198.51.100.4:41221] logged in with entity id 244 at (2.5, 64.0, -1.5)",
    "2026-08-08T10:20:00.500000000Z [10:20:00] [Server thread/INFO]: Bob joined the game",
    "2026-08-08T10:35:00.000000000Z [10:35:00] [Server thread/INFO]: Alice left the game",
    ""
].join("\n");

const BEDROCK_LOG = [
    "2026-08-08T10:02:00.000000000Z [2026-08-08 10:02:00 INFO] Player connected: Gamer Tag, xuid: 2535",
    "2026-08-08T10:40:00.000000000Z [2026-08-08 10:40:00 INFO] Player disconnected: Gamer Tag, xuid: 2535",
    ""
].join("\n");

describe("parsePlayerSessions", () => {
    it("folds a Java login and its join line into one arrival, keeping the address", () => {
        const events = parsePlayerSessions(JAVA_LOG);
        const alice = events.filter((event) => event.name === "Alice");
        expect(alice).toEqual([
            { name: "Alice", kind: "join", at: "2026-08-08T10:01:01.000000000Z", address: "203.0.113.9" },
            { name: "Alice", kind: "leave", at: "2026-08-08T10:35:00.000000000Z", address: null }
        ]);
    });

    it("reads Bedrock's own wording, and the gamertags with a space in them", () => {
        expect(parsePlayerSessions(BEDROCK_LOG)).toEqual([
            { name: "Gamer Tag", kind: "join", at: "2026-08-08T10:02:00.000000000Z", address: null },
            { name: "Gamer Tag", kind: "leave", at: "2026-08-08T10:40:00.000000000Z", address: null }
        ]);
    });

    it("reports no time rather than an invented one when the log carries none", () => {
        const events = parsePlayerSessions("[10:01:01] [Server thread/INFO]: Alice joined the game");
        expect(events).toEqual([{ name: "Alice", kind: "join", at: null, address: null }]);
    });

    it("keeps two arrivals apart when a leave came between them", () => {
        const log = [
            "2026-08-08T10:00:00Z Alice joined the game",
            "2026-08-08T10:05:00Z Alice left the game",
            "2026-08-08T10:06:00Z Alice joined the game"
        ].join("\n");
        expect(parsePlayerSessions(log).map((event) => event.kind)).toEqual(["join", "leave", "join"]);
    });

    it("has nothing to say about a log with no joins in it", () => {
        expect(parsePlayerSessions("2026-08-08T10:00:00Z [Server thread/INFO]: Done (12.3s)!")).toEqual([]);
    });
});

describe("playerActivity", () => {
    const events = parsePlayerSessions(JAVA_LOG);
    const byPlayer = sessionsByPlayer(events);
    const now = Date.parse("2026-08-08T10:45:00Z");

    it("takes the server's own answer over the log", () => {
        // Bob's leave never reached the log, and the server says he is on.
        expect(playerActivity(byPlayer.get("bob") ?? [], true, now)).toEqual({
            presence: "playing",
            lastSeen: "2026-08-08T10:20:00.000000000Z"
        });
    });

    it("reports a player the server has stopped listing as gone, with when", () => {
        expect(playerActivity(byPlayer.get("alice") ?? [], false, now)).toEqual({
            presence: "offline",
            lastSeen: "2026-08-08T10:35:00.000000000Z"
        });
    });

    it("treats a join the server has not caught up with as still arriving", () => {
        const justNow = Date.parse("2026-08-08T10:20:30Z");
        expect(playerActivity(byPlayer.get("bob") ?? [], false, justNow).presence).toBe("connecting");
    });

    it("stops calling it arriving once the server has had long enough to say so", () => {
        expect(playerActivity(byPlayer.get("bob") ?? [], false, now).presence).toBe("offline");
    });

    it("separates somebody registered but never seen from somebody who has left", () => {
        expect(playerActivity([], false, now)).toEqual({ presence: "never", lastSeen: null });
    });
});

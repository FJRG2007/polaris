/**
 * "Playing - since 21h ago" for somebody who had reconnected all day.
 *
 * Three things drew it. The log parser folded any join that followed a join into
 * the first one, so a leave it did not read - a crash, a restart, a reconnect whose
 * only trace was the network layer's "lost connection" - glued every later
 * connection onto the morning's. The players table, when the log no longer reached
 * back to somebody, filled "since" with the record's newest DEPARTURE. And the
 * record itself only compared rosters a minute apart, so a reconnect inside that
 * minute never ended a visit.
 *
 * The logs below are in the NeoForge 1.21.4 console format as docker hands it back:
 * docker's RFC3339 stamp, then `[HH:mm:ss] [thread/LEVEL] [logger]: message`.
 */

import { describe, expect, it } from "vitest";
import {
    historyOf,
    presenceLine,
    rosterChange,
    seenKey,
    sessionWrites,
    withLiveSince,
    type LoggedConnection
} from "@polaris-app/game-servers/src/lib/games-activity";
import { foldPlayers } from "@polaris-app/game-servers/src/lib/minecraft/players";
import type { MinecraftStatus } from "@polaris-app/game-servers/src/lib/minecraft/service";
import {
    logConnection,
    parsePlayerSessions,
    playerActivity,
    sessionsByPlayer
} from "@polaris-app/game-servers/src/lib/minecraft/sessions";

/** One console line as docker returns it. */
function line(stamp: string, thread: string, logger: string, message: string): string {
    const clock = stamp.slice(11, 19);
    return `${stamp} [${clock}] [${thread}/INFO] [${logger}]: ${message}`;
}

const MAIN = "Server thread";

function login(stamp: string, name: string, port: number): string[] {
    return [
        line(
            stamp.replace(/\.\d+Z$/, ".100000000Z"),
            "User Authenticator #1",
            "minecraft/ServerLoginPacketListenerImpl",
            `UUID of player ${name} is 0f0e0d0c-0b0a-4908-8706-050403020100`
        ),
        line(
            stamp,
            MAIN,
            "minecraft/PlayerList",
            `${name}[/203.0.113.9:${port}] logged in with entity id 412 at (100.5, 64.0, -20.3)`
        ),
        line(
            stamp.replace(/\.\d+Z$/, ".600000000Z"),
            MAIN,
            "minecraft/MinecraftServer",
            `${name} joined the game`
        )
    ];
}

function leave(stamp: string, name: string, reason: string): string[] {
    return [
        line(
            stamp,
            MAIN,
            "minecraft/ServerGamePacketListenerImpl",
            `${name} lost connection: ${reason}`
        ),
        line(
            stamp.replace(/\.\d+Z$/, ".200000000Z"),
            MAIN,
            "minecraft/MinecraftServer",
            `${name} left the game`
        )
    ];
}

/** Noise the server prints in between, including the RCON chatter every
 *  `rcon-cli` call leaves behind. */
const RCON = [
    line(
        "2026-09-29T09:30:00.000000000Z",
        "RCON Listener #1",
        "minecraft/RconThread",
        "Thread RCON Client /127.0.0.1 started"
    ),
    line(
        "2026-09-29T09:30:00.100000000Z",
        "RCON Client /127.0.0.1 #3",
        "minecraft/RconClient",
        "Thread RCON Client /127.0.0.1 shutting down"
    )
];

/** A day of PlayerOne dropping and coming back: disconnect, time out, get kicked,
 *  log in from another client, and one crash that printed no leave at all. */
const DAY = [
    line(
        "2026-09-29T07:00:00.000000000Z",
        MAIN,
        "minecraft/DedicatedServer",
        "Starting minecraft server version 1.21.4"
    ),
    line(
        "2026-09-29T07:00:40.000000000Z",
        MAIN,
        "minecraft/DedicatedServer",
        'Done (38.211s)! For help, type "help"'
    ),
    ...login("2026-09-29T08:00:00.000000000Z", "PlayerOne", 51001),
    ...login("2026-09-29T08:05:00.000000000Z", "DINNERBONE", 51002),
    ...RCON,
    ...leave("2026-09-29T10:00:00.000000000Z", "PlayerOne", "Disconnected"),
    ...login("2026-09-29T10:00:25.000000000Z", "PlayerOne", 51003),
    ...leave("2026-09-29T12:00:00.000000000Z", "PlayerOne", "Timed out"),
    ...login("2026-09-29T12:00:40.000000000Z", "PlayerOne", 51004),
    ...leave("2026-09-29T13:00:00.000000000Z", "PlayerOne", "Kicked by an operator"),
    ...login("2026-09-29T13:00:10.000000000Z", "PlayerOne", 51005),
    // A second client: the server drops the first connection and prints both.
    ...leave("2026-09-29T14:00:00.000000000Z", "PlayerOne", "You logged in from another location"),
    ...login("2026-09-29T14:00:00.500000000Z", "PlayerOne", 51006),
    // The server dies: no leave for anybody, and the next thing printed is a
    // new server starting.
    line(
        "2026-09-29T15:00:00.000000000Z",
        "Server Watchdog",
        "minecraft/ServerWatchdog",
        "A single server tick took 60.00 seconds (should be max 0.05)"
    ),
    line(
        "2026-09-29T15:01:30.000000000Z",
        MAIN,
        "minecraft/DedicatedServer",
        "Starting minecraft server version 1.21.4"
    ),
    ...login("2026-09-29T15:03:00.000000000Z", "DINNERBONE", 51007),
    ...login("2026-09-29T15:04:00.000000000Z", "PlayerOne", 51008),
    ""
].join("\n");

const NOW_MS = Date.parse("2026-09-29T16:00:00.000Z");

describe("the log, read as connections", () => {
    const events = parsePlayerSessions(DAY);
    const byPlayer = sessionsByPlayer(events);

    it("keeps every reconnect as its own arrival", () => {
        const fj = byPlayer.get("playerone") ?? [];
        expect(fj.map((event) => `${event.kind}@${event.at?.slice(11, 19)}`)).toEqual([
            "join@08:00:00",
            "leave@10:00:00",
            "join@10:00:25",
            "leave@12:00:00",
            "join@12:00:40",
            "leave@13:00:00",
            "join@13:00:10",
            "leave@14:00:00",
            "join@14:00:00",
            // The crash: nobody left in the log, the restart ended it anyway.
            "leave@15:01:30",
            "join@15:04:00"
        ]);
    });

    it("prints one departure for the two lines Java writes, not two", () => {
        const leaves = (byPlayer.get("playerone") ?? []).filter((event) => event.kind === "leave");
        expect(leaves).toHaveLength(5);
    });

    it("says the current connection began at the last arrival", () => {
        expect(logConnection(byPlayer.get("playerone") ?? [])).toEqual({
            online: true,
            since: "2026-09-29T15:04:00.000000000Z",
            lastLeft: "2026-09-29T15:01:30.000000000Z"
        });
        // Nothing was printed for DINNERBONE leaving before the crash; her visit
        // since the morning ended with the server, and the one she is on began
        // after it.
        expect(logConnection(byPlayer.get("dinnerbone") ?? [])).toMatchObject({
            online: true,
            since: "2026-09-29T15:03:00.000000000Z"
        });
    });

    it("answers 'playing since' with the current connection, not the first of the day", () => {
        expect(playerActivity(byPlayer.get("playerone") ?? [], true, NOW_MS)).toEqual({
            presence: "playing",
            lastSeen: "2026-09-29T15:04:00.000000000Z"
        });
    });

    it("does not glue a second login onto the first when no leave was printed", () => {
        // A server whose join and leave messages a mod rewrote: only the login
        // line and the network layer's line are left.
        const log = [
            line(
                "2026-09-29T08:00:00.000000000Z",
                MAIN,
                "minecraft/PlayerList",
                "PlayerOne[/203.0.113.9:51001] logged in with entity id 1 at (0.5, 64.0, 0.5)"
            ),
            line(
                "2026-09-29T09:00:00.000000000Z",
                MAIN,
                "minecraft/ServerGamePacketListenerImpl",
                "PlayerOne lost connection: Disconnected"
            ),
            line(
                "2026-09-29T09:00:30.000000000Z",
                MAIN,
                "minecraft/PlayerList",
                "PlayerOne[/203.0.113.9:51002] logged in with entity id 2 at (0.5, 64.0, 0.5)"
            ),
            line(
                "2026-09-29T11:00:00.000000000Z",
                MAIN,
                "minecraft/PlayerList",
                "PlayerOne[/203.0.113.9:51003] logged in with entity id 3 at (0.5, 64.0, 0.5)"
            )
        ].join("\n");
        const events = parsePlayerSessions(log);
        expect(events.map((event) => event.kind)).toEqual(["join", "leave", "join", "join"]);
        expect(logConnection(events).since).toBe("2026-09-29T11:00:00.000000000Z");
    });

    it("ends every visit at a clean stop, and prints the leaves after it once", () => {
        const log = [
            ...login("2026-09-29T08:00:00.000000000Z", "PlayerOne", 51001),
            line(
                "2026-09-29T09:00:00.000000000Z",
                MAIN,
                "minecraft/DedicatedServer",
                "Stopping the server"
            ),
            line(
                "2026-09-29T09:00:00.100000000Z",
                MAIN,
                "minecraft/MinecraftServer",
                "Stopping server"
            ),
            ...leave("2026-09-29T09:00:00.300000000Z", "PlayerOne", "Server closed"),
            line(
                "2026-09-29T09:05:00.000000000Z",
                MAIN,
                "minecraft/DedicatedServer",
                "Starting minecraft server version 1.21.4"
            )
        ].join("\n");
        expect(
            parsePlayerSessions(log).map((event) => `${event.kind}@${event.at?.slice(11, 23)}`)
        ).toEqual(["join@08:00:00.000", "leave@09:00:00.100"]);
    });

    it("does not take a connection dropped before it had a player for one leaving", () => {
        const log = [
            line(
                "2026-09-29T08:00:00.000000000Z",
                MAIN,
                "minecraft/ServerLoginPacketListenerImpl",
                "/203.0.113.9:51001 lost connection: Disconnected"
            ),
            line(
                "2026-09-29T08:00:01.000000000Z",
                MAIN,
                "minecraft/ServerConfigurationPacketListenerImpl",
                "PlayerOne lost connection: Disconnected"
            )
        ].join("\n");
        expect(parsePlayerSessions(log)).toEqual([]);
    });

    it("reads the lines the same through a terminal, which ends each with a return", () => {
        const events = parsePlayerSessions(DAY.replaceAll("\n", "\r\n"));
        expect(logConnection(sessionsByPlayer(events).get("playerone") ?? []).since).toBe(
            "2026-09-29T15:04:00.000000000Z"
        );
    });
});

/** The log's view of each player, as the recorder receives it. */
function logged(log: string): Map<string, LoggedConnection> {
    const found = new Map<string, LoggedConnection>();
    for (const [key, own] of sessionsByPlayer(parsePlayerSessions(log))) {
        const connection = logConnection(own);
        found.set(key, {
            online: connection.online,
            since: connection.since ? new Date(connection.since) : null,
            lastLeft: connection.lastLeft ? new Date(connection.lastLeft) : null
        });
    }
    return found;
}

describe("the record, kept true to the log", () => {
    const at = (iso: string) => new Date(iso);

    it("splits a visit when the player dropped and came back between two looks", () => {
        // The minute's look saw PlayerOne at 09:59 and again at 10:01: never absent.
        const open = [
            { id: "v1", name: "PlayerOne", playerId: null, joinedAt: at("2026-09-29T08:00:00.000Z") }
        ];
        const roster = [{ name: "PlayerOne", id: null }];
        const change = rosterChange(open, roster);
        expect(change).toEqual({ arrived: [], left: [], adopted: [] });

        const log = [
            ...login("2026-09-29T08:00:00.000000000Z", "PlayerOne", 51001),
            ...leave("2026-09-29T10:00:00.000000000Z", "PlayerOne", "Disconnected"),
            ...login("2026-09-29T10:00:25.000000000Z", "PlayerOne", 51003)
        ].join("\n");
        const writes = sessionWrites(
            open,
            change,
            roster,
            logged(log),
            at("2026-09-29T10:01:00.000Z")
        );
        expect(writes.close).toEqual([{ id: "v1", leftAt: at("2026-09-29T10:00:00.000Z") }]);
        expect(writes.open).toEqual([
            { player: { name: "PlayerOne", id: null }, joinedAt: at("2026-09-29T10:00:25.000Z") }
        ]);
    });

    it("leaves a visit alone when the log's arrival is the one that opened it", () => {
        // Opened by the look a few seconds after the join line: the same connection.
        const open = [
            { id: "v1", name: "PlayerOne", playerId: null, joinedAt: at("2026-09-29T08:00:03.000Z") }
        ];
        const roster = [{ name: "PlayerOne", id: null }];
        const log = login("2026-09-29T08:00:00.000000000Z", "PlayerOne", 51001).join("\n");
        const writes = sessionWrites(
            open,
            rosterChange(open, roster),
            roster,
            logged(log),
            at("2026-09-29T08:01:00.000Z")
        );
        expect(writes).toEqual({ close: [], open: [] });
    });

    it("splits a visit that ran through a restart with nobody leaving", () => {
        const open = [
            {
                id: "v1",
                name: "DINNERBONE",
                playerId: null,
                joinedAt: at("2026-09-29T08:05:00.000Z")
            }
        ];
        const roster = [{ name: "DINNERBONE", id: null }];
        const writes = sessionWrites(
            open,
            rosterChange(open, roster),
            roster,
            logged(DAY),
            at("2026-09-29T16:00:00.000Z")
        );
        expect(writes.close).toEqual([{ id: "v1", leftAt: at("2026-09-29T15:01:30.000Z") }]);
        expect(writes.open[0]?.joinedAt).toEqual(at("2026-09-29T15:03:00.000Z"));
    });

    it("stamps arrivals and departures with the log's moment, not the look's", () => {
        const open = [
            {
                id: "v1",
                name: "DINNERBONE",
                playerId: null,
                joinedAt: at("2026-09-29T08:05:00.000Z")
            }
        ];
        const roster = [{ name: "PlayerOne", id: null }];
        const log = [
            ...login("2026-09-29T08:05:00.000000000Z", "DINNERBONE", 51002),
            ...leave("2026-09-29T08:40:10.000000000Z", "DINNERBONE", "Disconnected"),
            ...login("2026-09-29T08:40:20.000000000Z", "PlayerOne", 51001)
        ].join("\n");
        const writes = sessionWrites(
            open,
            rosterChange(open, roster),
            roster,
            logged(log),
            at("2026-09-29T08:41:00.000Z")
        );
        expect(writes.close).toEqual([{ id: "v1", leftAt: at("2026-09-29T08:40:10.000Z") }]);
        expect(writes.open).toEqual([
            { player: { name: "PlayerOne", id: null }, joinedAt: at("2026-09-29T08:40:20.000Z") }
        ]);
    });

    it("closes a visit the roster no longer holds even when the log never said so", () => {
        // A leave line lost to the tail, a crash, a log that could not be read:
        // the server's own answer to who is on is what ends it.
        const open = [
            { id: "v1", name: "PlayerOne", playerId: null, joinedAt: at("2026-09-29T08:00:00.000Z") }
        ];
        const now = at("2026-09-29T09:00:00.000Z");
        const change = rosterChange(open, []);
        expect(sessionWrites(open, change, [], null, now).close).toEqual([
            { id: "v1", leftAt: now }
        ]);
        const stillOn = logged(
            login("2026-09-29T08:00:00.000000000Z", "PlayerOne", 51001).join("\n")
        );
        expect(sessionWrites(open, change, [], stillOn, now).close).toEqual([
            { id: "v1", leftAt: now }
        ]);
    });

    it("stamps with the look when there is no log, as ARK's record always has", () => {
        const now = at("2026-09-29T09:00:00.000Z");
        const roster = [{ name: "Survivor", id: "76561198000000001" }];
        expect(sessionWrites([], rosterChange([], roster), roster, null, now)).toEqual({
            close: [],
            open: [{ player: roster[0], joinedAt: now }]
        });
    });

    it("does not split a visit on a log clock running ahead, with no departure inside it", () => {
        // The server's machine is 30s ahead: the arrival was opened at the look,
        // and once the look's clock passes the logged join it sits past the start.
        const open = [
            { id: "v1", name: "PlayerOne", playerId: null, joinedAt: at("2026-09-29T08:00:00.000Z") }
        ];
        const roster = [{ name: "PlayerOne", id: null }];
        const log = [
            ...leave("2026-09-29T07:00:00.000000000Z", "PlayerOne", "Disconnected"),
            ...login("2026-09-29T08:00:30.000000000Z", "PlayerOne", 51001)
        ].join("\n");
        const writes = sessionWrites(
            open,
            rosterChange(open, roster),
            roster,
            logged(log),
            at("2026-09-29T08:01:00.000Z")
        );
        expect(writes).toEqual({ close: [], open: [] });
    });

    it("never dates an arrival after the look that saw it", () => {
        const now = at("2026-09-29T08:00:00.000Z");
        const roster = [{ name: "PlayerOne", id: null }];
        const ahead = logged(login("2026-09-29T08:00:05.000000000Z", "PlayerOne", 51001).join("\n"));
        expect(
            sessionWrites([], rosterChange([], roster), roster, ahead, now).open[0]?.joinedAt
        ).toEqual(now);
    });
});

function status(players: string[]): MinecraftStatus {
    return {
        edition: "java",
        running: true,
        answering: true,
        players: { online: players.length, max: 20, players },
        address: "mc.example.com",
        message: null,
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null
    };
}

describe("the players table", () => {
    const key = seenKey({ name: "PlayerOne", id: null });

    it("never says 'playing since' the end of the last visit", () => {
        // The log's tail no longer reaches PlayerOne - RCON chatter filled it - and
        // the record's newest departure was last night. That is when he left, not
        // when he arrived.
        const seen = {
            [key]: {
                since: "2026-09-29T15:04:00.000Z",
                lastSeen: "2026-09-28T19:00:00.000Z",
                open: "2026-09-29T15:04:00.000Z"
            }
        };
        const tail = parsePlayerSessions(RCON.join("\n"));
        expect(tail).toEqual([]);
        const [row] = foldPlayers(status(["PlayerOne"]), null, null, tail, NOW_MS, seen);
        expect(row).toMatchObject({ presence: "playing", lastSeen: "2026-09-29T15:04:00.000Z" });
    });

    it("says nothing rather than a departure when no visit is known to be open", () => {
        const seen = {
            [key]: {
                since: "2026-09-28T18:00:00.000Z",
                lastSeen: "2026-09-28T19:00:00.000Z",
                open: null
            }
        };
        const [row] = foldPlayers(status(["PlayerOne"]), null, null, [], NOW_MS, seen);
        expect(row).toMatchObject({ presence: "playing", lastSeen: null });
    });

    it("takes the log's arrival, and the record's when it saw a later one", () => {
        const events = parsePlayerSessions(DAY);
        const later = {
            [key]: {
                since: "2026-09-29T15:30:00.000Z",
                lastSeen: "2026-09-29T15:29:00.000Z",
                open: "2026-09-29T15:30:00.000Z"
            }
        };
        const earlier = {
            [key]: {
                since: "2026-09-29T08:00:00.000Z",
                lastSeen: null,
                open: "2026-09-29T08:00:00.000Z"
            }
        };
        const pick = (seen: typeof later | typeof earlier) =>
            foldPlayers(status(["PlayerOne", "DINNERBONE"]), null, null, events, NOW_MS, seen).find(
                (row) => row.name === "PlayerOne"
            )?.lastSeen;
        expect(pick(earlier)).toBe("2026-09-29T15:04:00.000000000Z");
        expect(pick(later)).toBe("2026-09-29T15:30:00.000Z");
    });

    it("moves 'since' on the moment the live feed has a newer visit", () => {
        const seen = {
            [key]: {
                since: "2026-09-29T08:00:00.000Z",
                lastSeen: null,
                open: "2026-09-29T08:00:00.000Z"
            }
        };
        const live = withLiveSince(seen, [
            { name: "PlayerOne", id: null, since: "2026-09-29T15:59:30.000Z" }
        ]);
        const [row] = foldPlayers(status(["PlayerOne"]), null, null, [], NOW_MS, live);
        expect(row?.lastSeen).toBe("2026-09-29T15:59:30.000Z");
        // A frame with nothing new hands the same object back, so nothing redraws.
        expect(
            withLiveSince(live, [{ name: "PlayerOne", id: null, since: "2026-09-29T15:59:30.000Z" }])
        ).toBe(live);
        expect(withLiveSince(seen, [{ name: "PlayerOne", id: null }])).toBe(seen);
    });
});

describe("every other place a visit is shown", () => {
    const at = (iso: string) => new Date(iso);

    it("history says 'on since' the visit in progress began, not now", () => {
        const history = historyOf(
            [
                {
                    joinedAt: at("2026-09-29T08:00:00.000Z"),
                    leftAt: at("2026-09-29T10:00:00.000Z")
                },
                { joinedAt: at("2026-09-29T10:00:25.000Z"), leftAt: null }
            ],
            at("2026-09-29T11:00:25.000Z")
        );
        expect(history).toMatchObject({
            visits: 2,
            online: true,
            onSince: at("2026-09-29T10:00:25.000Z"),
            playedMs: 3 * 60 * 60 * 1000,
            longestMs: 2 * 60 * 60 * 1000
        });
    });

    it("ARK and FiveM rows say since the open visit, not since the newest of any", () => {
        expect(
            presenceLine({
                online: true,
                seen: {
                    since: "2026-09-29T10:00:00.000Z",
                    lastSeen: "2026-09-29T09:00:00.000Z",
                    open: "2026-09-29T10:00:00.000Z"
                },
                addedAt: null
            })
        ).toEqual({ kind: "since", iso: "2026-09-29T10:00:00.000Z" });
        // On, but no visit is open in the record yet: no "since" at all.
        expect(
            presenceLine({
                online: true,
                seen: {
                    since: "2026-09-28T10:00:00.000Z",
                    lastSeen: "2026-09-28T12:00:00.000Z",
                    open: null
                },
                addedAt: null
            })
        ).toBeNull();
    });
});

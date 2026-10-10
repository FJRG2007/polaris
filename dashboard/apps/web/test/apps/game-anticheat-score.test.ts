/**
 * The likelihood a player is cheating, and the movement rules behind half of it.
 *
 * Like the honeypots, the cost of a mistake is somebody accused of something they
 * did not do - so what must never lift a score is pinned as carefully as what
 * must: a cave explorer's diamond rate, a single lucky honeypot, a fall, a
 * dropped connection, an operator's /tp.
 */

import { describe, expect, it } from "vitest";
import { CONFIRM_HITS, readXray } from "@polaris-app/game-servers/src/lib/minecraft/xray";
import {
    AIRBORNE_COMMAND,
    HOVER_SAMPLES,
    JOIN_GRACE_MS,
    MAX_INCIDENTS,
    MOVEMENT_WINDOW_MS,
    NEW_TRACK,
    RESPAWN_GRACE_MS,
    alreadyReported,
    countingIncidents,
    explainedByLog,
    incidentAt,
    isTeleport,
    joining,
    nextHover,
    readLogAdmin,
    resetCommands,
    respawnAfter,
    withIncident,
    type Sample,
    type Track
} from "@polaris-app/game-servers/src/lib/minecraft/movement";
import {
    MINING_WEIGHT_MAX,
    buildSuspects,
    levelOf,
    movementScore,
    xrayScore
} from "@polaris-app/game-servers/src/lib/minecraft/suspicion";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const figures = (diamonds: number, deepRock: number, debris = 0, netherRock = 0) => ({
    diamonds,
    deepRock,
    debris,
    netherRock
});

describe("the X-Ray score", () => {
    it("is Unlikely for a clean player", () => {
        expect(xrayScore(0, null)).toEqual({ value: 0, level: "unlikely", reasons: [], why: [] });
    });

    it("never goes past Unlikely on the mining rate alone, however fast", () => {
        // The owner who explores caves: a diamond for every few blocks of rock.
        const score = xrayScore(0, figures(40, 300));
        expect(score.level).toBe("unlikely");
        expect(score.value).toBeLessThan(20);
        expect(score.reasons).toHaveLength(1);
    });

    it("says nothing about a rate with too little mined", () => {
        expect(xrayScore(0, figures(2, 10)).reasons).toEqual([]);
    });

    it("reads one honeypot as possible chance", () => {
        const score = xrayScore(1, null);
        expect(score.level).toBe("possible");
        expect(score.reasons[0]).toMatch(/one can be chance/);
    });

    it("lets a fast rate move one honeypot to Likely, and never to Confirmed", () => {
        const score = xrayScore(1, figures(40, 300));
        expect(score.level).toBe("likely");
        expect(score.value).toBeLessThan(90);
    });

    it("confirms at the same number of honeypots the notifications do", () => {
        expect(xrayScore(CONFIRM_HITS - 1, figures(40, 300)).level).not.toBe("confirmed");
        expect(xrayScore(CONFIRM_HITS, null).level).toBe("confirmed");
        expect(xrayScore(20, null).value).toBe(100);
    });

    it("caps what the figures can add", () => {
        expect(xrayScore(1, figures(100, 200)).value - xrayScore(1, null).value).toBe(
            MINING_WEIGHT_MAX
        );
    });
});

describe("the movement score", () => {
    it("tops out at Likely, never Confirmed", () => {
        const score = movementScore(10, 10);
        expect(score.level).toBe("likely");
        expect(levelOf(score.value)).toBe("likely");
    });

    it("reads one flight as possible and a teleport as weaker than a flight", () => {
        expect(movementScore(1, 0).level).toBe("possible");
        expect(movementScore(0, 1).value).toBeLessThan(movementScore(1, 0).value);
        expect(movementScore(0, 0)).toEqual({ value: 0, level: "unlikely", reasons: [], why: [] });
    });
});

const sample = (y: number, x = 0, at = NOW, dimension = "minecraft:overworld"): Sample => ({
    dimension,
    x,
    y,
    z: 0,
    at
});

/** Feed a run of looks through the hover rule and count the incidents. */
function flights(looks: (Sample | null)[]): number {
    let track: Track = NEW_TRACK;
    let found = 0;
    for (const look of looks) {
        const next = nextHover(track, look);
        track = next.track;
        if (next.flying) found += 1;
    }
    return found;
}

describe("hovering", () => {
    it("is an incident after enough looks in the air, and one flight is one incident", () => {
        const looks = Array.from({ length: HOVER_SAMPLES + 5 }, (_, index) =>
            sample(100, index * 3, NOW + index * 4000)
        );
        expect(flights(looks)).toBe(1);
    });

    it("starts again after the player lands", () => {
        const air = (index: number) => sample(100, index * 3, NOW + index * 4000);
        expect(flights([air(0), air(1), air(2), null, air(4), air(5), air(6)])).toBe(2);
    });

    it("is not a fall", () => {
        const falling = [0, 1, 2, 3].map((index) =>
            sample(300 - index * 60, 0, NOW + index * 4000)
        );
        expect(flights(falling)).toBe(0);
    });

    it("is not a player frozen by a lost connection", () => {
        const frozen = [0, 1, 2, 3].map((index) => sample(100, 0, NOW + index * 4000));
        expect(flights(frozen)).toBe(0);
    });

    it("is not looks too far apart to say anything", () => {
        const stalled = [0, 1, 2].map((index) => sample(100, index * 3, NOW + index * 60_000));
        expect(flights(stalled)).toBe(0);
    });

    it("rules out, in the command itself, everything that legitimately keeps somebody up", () => {
        for (const reason of [
            "gamemode=!creative",
            "gamemode=!spectator",
            "FallFlying:1b",
            "mayfly:1b",
            "RootVehicle",
            "minecraft:levitation",
            "minecraft:slow_falling"
        ]) {
            expect(AIRBORNE_COMMAND).toContain(reason);
        }
    });

    it("needs air under every corner, so somebody sneaking at an edge is standing", () => {
        for (const corner of [
            "~0.3 ~-1 ~0.3",
            "~-0.3 ~-1 ~0.3",
            "~0.3 ~-1 ~-0.3",
            "~-0.3 ~-1 ~-0.3"
        ]) {
            expect(AIRBORNE_COMMAND).toContain(`if block ${corner} minecraft:air`);
        }
    });

    it("needs air where the feet are, so somebody on a slab or a bed is standing", () => {
        for (const spot of [
            "~ ~ ~",
            "~0.3 ~ ~0.3",
            "~-0.3 ~ ~0.3",
            "~0.3 ~ ~-0.3",
            "~-0.3 ~ ~-0.3"
        ]) {
            expect(AIRBORNE_COMMAND).toContain(`if block ${spot} minecraft:air`);
        }
    });
});

describe("teleporting", () => {
    it("is a jump further than anybody can go between two looks", () => {
        expect(isTeleport(sample(64, 0), sample(64, 1000, NOW + 4000))).toBe(true);
    });

    it("is not sprinting, a pearl, or a portal", () => {
        expect(isTeleport(sample(64, 0), sample(64, 60, NOW + 4000))).toBe(false);
        expect(
            isTeleport(sample(64, 0), sample(64, 1000, NOW + 4000, "minecraft:the_nether"))
        ).toBe(false);
    });

    it("is not judged in the End, where gateways move you a thousand blocks", () => {
        const end = "minecraft:the_end";
        expect(isTeleport(sample(64, 0, NOW, end), sample(64, 1000, NOW + 4000, end))).toBe(false);
    });

    it("is explained by an operator's or the console's /tp in the log", () => {
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [Admin: Teleported Steve to 1.0, 64.0, 2.0]",
                "Steve"
            )
        ).toBe(true);
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [Rcon: Teleported Steve to Alex]",
                "steve"
            )
        ).toBe(true);
    });

    it("is explained by a teleport command somebody ran through a plugin", () => {
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: Alex issued server command: /tpaccept",
                "Steve"
            )
        ).toBe(true);
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: Steve issued server command: /essentials:home base",
                "Steve"
            )
        ).toBe(true);
    });

    it("is not explained by somebody else being teleported, or by chat", () => {
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [Admin: Teleported Alex to 1.0, 64.0, 2.0]",
                "Steve"
            )
        ).toBe(false);
        expect(
            explainedByLog("[12:00:01] [Server thread/INFO]: <Steve> tp me please", "Steve")
        ).toBe(false);
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [Admin: Teleported Admin to Steve]",
                "Steve"
            )
        ).toBe(false);
    });

    it("is explained by an operator's /tp on a name a team decorates, or on several players", () => {
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [Admin: Teleported [VIP] Steve to 1.0, 64.0, 2.0]",
                "Steve"
            )
        ).toBe(true);
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [Admin: Teleported 3 entities to Admin]",
                "Steve"
            )
        ).toBe(true);
    });

    it("is not explained by the same words typed in chat or said", () => {
        for (const line of [
            "[12:00:01] [Server thread/INFO]: <Cheater> Teleported 5 entities to x",
            "[12:00:01] [Server thread/INFO]: <Cheater> [Admin: Teleported 5 entities to x]",
            "[12:00:01] [Server thread/INFO]: [Cheater] Teleported 5 entities to x",
            "[12:00:01] [Server thread/INFO]: <Steve> Teleported Steve to 0.0, 64.0, 0.0",
            "[12:00:01] [Server thread/INFO]: [Steve] [Admin: Teleported Steve to Alex]"
        ]) {
            expect(explainedByLog(line, "Steve")).toBe(false);
        }
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: Teleported 3 entities to Admin",
                "Steve"
            )
        ).toBe(true);
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [[Mod] Admin: Teleported 3 entities to Admin]",
                "Steve"
            )
        ).toBe(true);
    });

    it("is not explained by a count a command block wrote", () => {
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [@: Teleported 12 entities to 0.0, 64.0, 0.0]",
                "Steve"
            )
        ).toBe(false);
        expect(
            explainedByLog(
                "[12:00:01] [Server thread/INFO]: [@: Teleported Steve to 0.0, 64.0, 0.0]",
                "Steve"
            )
        ).toBe(true);
    });

    it("is explained by the lines a NeoForge server wrote for its own operators and events", () => {
        // Copied from a real NeoForge 1.21.4 server's log: Polaris over RCON, an
        // event's `execute as <player> run tp @s ...`, an operator pulling a
        // player to them, a command block and a spread.
        const neo =
            "[10Oct2026 20:35:56.539] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: ";
        for (const [line, name] of [
            [
                `${neo}[Rcon: Teleported ErMigue04 to -5385.500000, 152.000000, -2545.500000]`,
                "ErMigue04"
            ],
            [
                `${neo}[PICHURRINA: Teleported PICHURRINA to -5188.917219, 143.528720, -2513.849984]`,
                "PICHURRINA"
            ],
            [`${neo}[FJRG2007: Teleported Reckmy to FJRG2007]`, "Reckmy"],
            [`${neo}[FJRG2007: Teleported ErMigue04 to -5644.5, 125.0, -2403.5]`, "ErMigue04"],
            [`${neo}[@: Teleported Reckmy to 10.5, 70.0, 10.5]`, "Reckmy"],
            [
                `${neo}[Rcon: Spread 3 entity/entities around -5487.5, -2544.5 with an average distance of 25.11 block(s) apart]`,
                "Reckmy"
            ]
        ] as const) {
            expect(explainedByLog(line, name), line).toBe(true);
        }
        expect(explainedByLog(`${neo}[FJRG2007: Teleported FJRG2007 to Reckmy]`, "Reckmy")).toBe(
            false
        );
    });

    it("reads whether the game logs operators' commands", () => {
        expect(readLogAdmin("Gamerule logAdminCommands is currently set to: true")).toBe(true);
        expect(readLogAdmin("Gamerule logAdminCommands is currently set to: false")).toBe(false);
        expect(readLogAdmin("Unknown or incomplete command")).toBeNull();
    });
});

describe("respawning and joining", () => {
    const track = (last: Sample | null, diedAt: number | null, joinedAt: number | null = null) =>
        ({ ...NEW_TRACK, last, diedAt, joinedAt }) satisfies Track;

    it("holds a death until the player is seen moving on a look after the one that saw it", () => {
        // The look that saw the death: they may still have been running then.
        expect(respawnAfter(track(sample(64, 0), null), sample(64, 5, NOW + 4000), true)).toBe(
            NOW + 4000
        );
        const died = NOW + 4000;
        // On the death screen: the body does not move, however long they wait.
        expect(
            respawnAfter(
                track(sample(64, 5, died + 4000), died),
                sample(64, 5, died + 60_000),
                false
            )
        ).toBe(died);
        // Respawned far away, or beside where they fell: either ends it.
        expect(
            respawnAfter(
                track(sample(64, 5, died + 4000), died),
                sample(64, 5000, died + 64_000),
                false
            )
        ).toBeNull();
        expect(
            respawnAfter(
                track(sample(64, 5, died + 4000), died),
                sample(64, 9, died + 64_000),
                false
            )
        ).toBeNull();
        expect(
            respawnAfter(
                track(sample(64, 5, died + 4000), died),
                sample(64, 5, died + 64_000, "minecraft:the_nether"),
                false
            )
        ).toBeNull();
    });

    it("excuses the respawn jump once, and not a player who stood still long after", () => {
        const died = NOW + 4000;
        expect(
            respawnAfter(track(sample(64, 0, died), died), sample(64, 5000, died + 4000), false)
        ).toBeNull();
        expect(
            respawnAfter(
                track(sample(64, 5, died + 4000), died),
                sample(64, 5, died + RESPAWN_GRACE_MS + 4000),
                false
            )
        ).toBeNull();
    });

    it("does not end a death on the look that saw it", () => {
        const died = NOW + 4000;
        expect(
            respawnAfter(track(sample(64, 0, died), died), sample(64, 30, died + 4000), false)
        ).toBe(died);
    });

    it("is nothing for a player who did not die", () => {
        expect(
            respawnAfter(track(sample(64, 0), null), sample(64, 5000, NOW + 4000), false)
        ).toBeNull();
    });

    it("excuses the server moving somebody only for a while after they join", () => {
        expect(joining(track(null, null, NOW), NOW + JOIN_GRACE_MS)).toBe(true);
        expect(joining(track(null, null, NOW), NOW + JOIN_GRACE_MS + 1)).toBe(false);
        expect(joining(track(null, null, null), NOW)).toBe(false);
    });

    it("resets only the players whose counts were read", () => {
        expect(resetCommands("polaris_mv_death", ["Steve", "odd name"])).toEqual([
            "scoreboard players reset Steve polaris_mv_death",
            "scoreboard players reset @a[scores={polaris_mv_death=1..}] polaris_mv_death"
        ]);
        expect(resetCommands("polaris_mv_death", ["odd name", "other one"])).toEqual([
            "scoreboard players reset @a[scores={polaris_mv_death=1..}] polaris_mv_death"
        ]);
        expect(resetCommands("polaris_mv_death", [])).toEqual([]);
    });
});

describe("keeping incidents", () => {
    it("keeps the newest and counts only the last fortnight", () => {
        let evidence = withIncident(undefined, "Steve", incidentAt("flying", sample(100), null));
        for (let index = 0; index < MAX_INCIDENTS + 5; index += 1) {
            evidence = withIncident(
                evidence,
                "Steve",
                incidentAt("teleport", sample(64, index, NOW - index), 500)
            );
        }
        expect(evidence.incidents).toHaveLength(MAX_INCIDENTS);
        const old = withIncident(
            undefined,
            "Steve",
            incidentAt("flying", sample(100, 0, NOW - MOVEMENT_WINDOW_MS - 1), null)
        );
        expect(countingIncidents(old, NOW)).toEqual([]);
    });

    it("tells the owner again only once what was reported has left the window", () => {
        const reported = {
            ...withIncident(
                undefined,
                "Steve",
                incidentAt("flying", sample(100, 0, NOW - 1000), null)
            ),
            reportedAt: NOW - 500
        };
        expect(alreadyReported(reported, NOW)).toBe(true);
        expect(
            alreadyReported(
                withIncident(reported, "Steve", incidentAt("flying", sample(100), null)),
                NOW
            )
        ).toBe(true);
        const later = NOW + MOVEMENT_WINDOW_MS;
        const fresh = withIncident(
            reported,
            "Steve",
            incidentAt("flying", sample(100, 0, later), null)
        );
        expect(alreadyReported(fresh, later)).toBe(false);
        expect(
            alreadyReported(
                withIncident(undefined, "Steve", incidentAt("flying", sample(100), null)),
                NOW
            )
        ).toBe(false);
    });

    it("reads settings and evidence saved before movement existed", () => {
        const state = readXray({
            xrayTraps: {
                settings: {
                    enabled: true,
                    perDimension: 20,
                    action: "notify",
                    banHits: 3,
                    banHours: 24,
                    warning: "x",
                    nether: false
                },
                honeypots: [],
                evidence: {},
                cleanup: []
            }
        });
        expect(state.settings).toMatchObject({ enabled: true, perDimension: 20, movement: false });
        expect(state.movement).toEqual({});
        expect(state.teleportCheck).toBeNull();
    });
});

describe("the players list", () => {
    it("merges both kinds of evidence and the figures into one row per player, worst first", () => {
        const { suspects, incidents } = buildSuspects({
            honeypots: [
                {
                    name: "Steve",
                    hits: [
                        { dimension: "minecraft:overworld", x: 1, y: -50, z: 1, at: NOW - 1000 },
                        { dimension: "minecraft:overworld", x: 9, y: -50, z: 9, at: NOW }
                    ],
                    warnedAt: null,
                    bannedAt: null
                }
            ],
            movement: [
                {
                    name: "alex",
                    incidents: [{ ...incidentAt("flying", sample(100), null), kind: "flying" }]
                }
            ],
            mining: [
                { name: "Alex", figures: figures(4, 300) },
                { name: "Nobody", figures: figures(0, 0) }
            ]
        });
        // Somebody with nothing against them is still a row - not missing.
        expect(suspects.map((one) => one.name)).toEqual(["Steve", "alex", "Nobody"]);
        expect(suspects[0]?.xray.level).toBe("confirmed");
        expect(suspects[1]).toMatchObject({ flights: 1, mining: figures(4, 300) });
        expect(suspects[2]).toMatchObject({ hits: 0, flights: 0, teleports: 0, mining: null });
        expect(incidents.map((one) => one.kind)).toEqual(["honeypot", "flying", "honeypot"]);
    });

    it("holds the engine's movement and block checks to Possible on a modded server", () => {
        const engine = [
            {
                name: "Reckmy",
                checks: [{ check: "Simulation", alerts: 38, lastAt: NOW }]
            }
        ];
        const plain = buildSuspects({ honeypots: [], movement: [], mining: [], engine });
        const modded = buildSuspects({
            honeypots: [],
            movement: [],
            mining: [],
            engine,
            modded: true
        });
        expect(plain.suspects[0]?.engine.level).toBe("confirmed");
        expect(modded.suspects[0]?.engine.level).toBe("possible");
        expect(modded.suspects[0]?.engine.reasons.at(-1)).toMatch(/^Modded server/);
    });

    it("lists whoever is online, even before the game has written their counts", () => {
        // Grumm was mining and not in the table: nothing found yet, and the
        // server had not saved the stats that would have put him there.
        const { suspects } = buildSuspects({
            honeypots: [],
            movement: [],
            mining: [{ name: "Notch", figures: figures(4, 129) }],
            players: ["Grumm", "notch"]
        });
        expect(suspects.map((one) => one.name).sort()).toEqual(["Grumm", "Notch"]);
        expect(suspects.find((one) => one.name === "Grumm")).toMatchObject({
            xray: { level: "unlikely" },
            movement: { level: "unlikely" },
            mining: null,
            lastAt: null
        });
    });
});

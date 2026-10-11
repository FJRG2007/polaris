/**
 * The impostor game (`kinds/impostor`): its station checked against its rules
 * over many runs, and the roles, kills, votes, wins and points it decides with
 * no server at all.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as im from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/impostor";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/impostor-messages";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const SITE = { x: 300, z: -120 };
const Y = 100;
const SEEDS = 40;

const names = (count: number) => Array.from({ length: count }, (_, n) => `Player_${n}`);
const bare = (id: string) => id.replace(/\[.*$/, "");

function stateWith(overrides: Partial<im.ImpostorState>): im.ImpostorState {
    return { ...im.stateSchema.parse({}), started: true, ...overrides };
}

describe("the station", () => {
    for (const players of [4, 8, 9, 15]) {
        it(`is built only into its own box, every block once, for ${players}`, () => {
            const box = im.stationBox(SITE, Y, players);
            expect(im.rowsOf(box)).toBe(im.rowsFor(players));
            expect(Math.ceil((box.x2 - box.x1 + 1) / 2)).toBeLessThanOrEqual(im.reachOf(players));
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const layout = im.layoutFor(`run-${seed}`, box);
                const fills = im.stationFills(layout);
                const seen = new Set<string>();
                for (const fill of fills) {
                    const f = fill.box;
                    expect(f.x1).toBeGreaterThanOrEqual(box.x1);
                    expect(f.x2).toBeLessThanOrEqual(box.x2);
                    expect(f.z1).toBeGreaterThanOrEqual(box.z1);
                    expect(f.z2).toBeLessThanOrEqual(box.z2);
                    expect(f.y1).toBeGreaterThanOrEqual(box.y1);
                    expect(f.y2).toBeLessThanOrEqual(box.y2);
                    expect(im.STATION_BLOCKS).toContain(bare(fill.block));
                    for (let x = f.x1; x <= f.x2; x += 1)
                        for (let y = f.y1; y <= f.y2; y += 1)
                            for (let z = f.z1; z <= f.z2; z += 1) {
                                const key = `${x},${y},${z}`;
                                expect(seen.has(key), key).toBe(false);
                                seen.add(key);
                            }
                }
                // The last fill is the proof: floor, nothing standing on it.
                const proof = fills[fills.length - 1]!;
                expect(proof.block).toBe("minecraft:gray_concrete");
                expect(proof.box.y1).toBe(box.y1);
            }
        });
    }

    it("lists every block it puts down, what stands on something first", () => {
        const layout = im.layoutFor("run", im.stationBox(SITE, Y, 15));
        const placed = new Set(im.stationFills(layout).map((fill) => bare(fill.block)));
        expect([...placed].every((id) => im.stationBlocks().includes(id))).toBe(true);
        const order = im.stationBlocks();
        for (const top of ["minecraft:lever", "minecraft:oak_button", "minecraft:stone_button"])
            expect(order.indexOf(top)).toBeLessThan(order.indexOf("minecraft:polished_diorite"));
    });

    it("joins every room, the meeting room in the middle, every seat and station inside", () => {
        for (const players of [4, 12])
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const layout = im.layoutFor(`run-${seed}`, im.stationBox(SITE, Y, players));
                const plan = im.planOf(layout);
                // Walk the floor from the table: every room reached.
                const table = im.tableAt(layout);
                const start = [table.x - layout.box.x1 + 3, table.z - layout.box.z1];
                const reached = new Set<string>([start.join(",")]);
                const queue = [start];
                while (queue.length > 0) {
                    const [x, z] = queue.pop()!;
                    for (const [dx, dz] of [
                        [1, 0],
                        [-1, 0],
                        [0, 1],
                        [0, -1]
                    ]) {
                        const key = `${x! + dx!},${z! + dz!}`;
                        if (reached.has(key) || !im.walkable(plan[x! + dx!]?.[z! + dz!])) continue;
                        reached.add(key);
                        queue.push([x! + dx!, z! + dz!]);
                    }
                }
                const rooms = new Set<number>();
                for (const key of reached) {
                    const [x, z] = key.split(",").map(Number);
                    const cell = plan[x!]![z!]!;
                    if (typeof cell === "number") rooms.add(cell);
                }
                expect(rooms.size).toBe(layout.rooms.length);
                expect(layout.meeting.col).toBe(1);
                expect(layout.meeting.row).toBe(1);
                for (let seat = 0; seat < players; seat += 1) {
                    const spot = im.seatSpot(layout, seat, players);
                    expect(im.inside(layout, spot, plan)).toBe(true);
                }
                for (const station of layout.stations)
                    expect(plan[station.x - layout.box.x1]![station.z - layout.box.z1]).toBe(
                        station.room
                    );
                for (const vent of layout.vents) {
                    expect(layout.vents[vent.to]!.to).toBe(layout.vents.indexOf(vent));
                    expect(vent.room).not.toBe(layout.meeting.index);
                    expect(im.inside(layout, im.ventExit(layout, vent), plan)).toBe(true);
                    expect(im.ventUnder(layout, im.ventExit(layout, vent))).toBeNull();
                }
            }
    });

    it("gives every seat its own place round the table", () => {
        const layout = im.layoutFor("run", im.stationBox(SITE, Y, 15));
        const seats = new Set(
            Array.from({ length: 15 }, (_, n) => {
                const spot = im.seatSpot(layout, n, 15);
                return `${spot.x},${spot.z}`;
            })
        );
        expect(seats.size).toBe(15);
    });
});

describe("the roles", () => {
    it("is never more impostors than one for every three, never fewer than one", () => {
        for (let players = im.FLOOR; players <= im.MOST; players += 1)
            for (let wanted = 1; wanted <= 3; wanted += 1) {
                const count = im.impostorCount(players, wanted);
                expect(count).toBeGreaterThanOrEqual(1);
                expect(count).toBeLessThanOrEqual(Math.min(wanted, Math.floor(players / 3)));
                const drawn = im.impostorsFor("run", names(players), wanted);
                expect(drawn).toHaveLength(count);
                expect(new Set(drawn).size).toBe(count);
            }
        expect(im.impostorCount(4, 3)).toBe(1);
        expect(im.impostorCount(6, 3)).toBe(2);
        expect(im.impostorCount(15, 3)).toBe(3);
    });

    it("draws the same impostors whatever order the players joined in", () => {
        const joined = names(9);
        expect(im.impostorsFor("run", joined, 2)).toEqual(
            im.impostorsFor("run", [...joined].reverse(), 2)
        );
    });

    it("gives tasks in different rooms first", () => {
        const layout = im.layoutFor("run", im.stationBox(SITE, Y, 4));
        const tasks = im.tasksFor("run", "Ana", layout, 4);
        expect(new Set(tasks).size).toBe(4);
        const rooms = tasks.map((id) => layout.stations[id]!.room);
        expect(new Set(rooms).size).toBe(4);
        expect(im.tasksFor("run", "Ana", layout, 8)).toHaveLength(8);
    });

    it("refuses an impostor game below four, in the editor's schema too", () => {
        expect(catalog.playersFloor("impostor")).toBe(4);
        expect(catalog.defaultMinPlayers("impostor")).toBe(4);
        const preset = catalog.newPreset("impostor", "imp");
        expect(catalog.presetSchema.safeParse(preset).success).toBe(true);
        expect(catalog.presetSchema.safeParse({ ...preset, minPlayers: 3 }).success).toBe(false);
        expect(catalog.joinersNeeded({ ...preset, minPlayers: undefined }, 1)).toBe(4);
    });
});

describe("who wins", () => {
    const players = ["Ana", "Bo", "Cy", "Di", "Ed"];
    const tasks = { Bo: [0, 1], Cy: [2, 3], Di: [4, 5], Ed: [6, 7] };

    it("is nobody while the game is open", () => {
        expect(im.verdict(stateWith({ impostors: ["Ana"], tasks }), players)).toBeNull();
    });

    it("is the crew when every impostor is voted out", () => {
        const state = stateWith({
            impostors: ["Ana"],
            tasks,
            dead: [{ name: "Ana", at: 1, how: "voted", by: null }]
        });
        expect(im.verdict(state, players)).toEqual({ winner: "crew", why: "voted" });
    });

    it("is the crew when every task is done, a dead one's undone ones dropped", () => {
        const state = stateWith({
            impostors: ["Ana"],
            tasks,
            done: { Bo: [0, 1], Cy: [2, 3], Di: [4, 5], Ed: [6] },
            dead: [{ name: "Ed", at: 1, how: "killed", by: "Ana" }]
        });
        expect(im.progressOf(state, players)).toEqual({ done: 7, total: 7 });
        expect(im.verdict(state, players)).toEqual({ winner: "crew", why: "tasks" });
    });

    it("is the impostors once they are as many as the crew", () => {
        const state = stateWith({
            impostors: ["Ana"],
            tasks,
            dead: [
                { name: "Bo", at: 1, how: "killed", by: "Ana" },
                { name: "Cy", at: 2, how: "killed", by: "Ana" },
                { name: "Di", at: 3, how: "voted", by: null }
            ]
        });
        expect(im.verdict(state, players)).toEqual({ winner: "impostors", why: "outnumbered" });
    });

    it("puts the winning side on top of the podium, dead or alive", () => {
        const crewWon = stateWith({
            impostors: ["Ana"],
            winner: "crew",
            why: "voted",
            kills: { Ana: im.MOST - 1 },
            done: { Bo: [] }
        });
        const crew = im.scoresOf(crewWon, players);
        expect(crew.get("Bo")).toBe(im.WIN_POINTS);
        expect(crew.get("Bo")!).toBeGreaterThan(crew.get("Ana")!);
        const impostorsWon = stateWith({
            impostors: ["Ana"],
            winner: "impostors",
            why: "outnumbered",
            done: { Bo: [0, 1, 2, 3, 4, 5, 6, 7] }
        });
        const imp = im.scoresOf(impostorsWon, players);
        expect(imp.get("Ana")!).toBeGreaterThan(imp.get("Bo")!);
        expect(imp.get("Bo")).toBe(8 * im.TASK_POINTS);
    });

    it("counts nothing while the game is open, so no kill shows who made it", () => {
        const open = stateWith({ impostors: ["Ana"], kills: { Ana: 2 }, done: { Bo: [0] } });
        expect([...im.scoresOf(open, players).values()]).toEqual(players.map(() => 0));
    });
});

describe("kills", () => {
    it("waits out the cooldown, and none in a meeting", () => {
        const state = stateWith({ impostors: ["Ana"], ready: { Ana: 30_000 } });
        expect(im.canKill(state, "Ana", 29_999)).toBe(false);
        expect(im.canKill(state, "Ana", 30_000)).toBe(true);
        expect(im.canKill(state, "Bo", 30_000)).toBe(false);
        const meeting = {
            reason: "emergency" as const,
            by: "Bo",
            body: null,
            startedAt: 0,
            voteAt: 1,
            endsAt: 2,
            ballots: false,
            votes: {}
        };
        expect(im.canKill({ ...state, meeting }, "Ana", 40_000)).toBe(false);
        const dead = { ...state, dead: [{ name: "Ana", at: 1, how: "voted" as const, by: null }] };
        expect(im.canKill(dead, "Ana", 40_000)).toBe(false);
    });

    it("credits the attacker the game names, else the nearest striker in reach", () => {
        const victim = { x: 0, z: 0 };
        const strikers = [
            { name: "Ana", x: 4, z: 0 },
            { name: "Bo", x: 2, z: 0 }
        ];
        expect(im.killerOf(victim, strikers, "ana")).toBe("Ana");
        expect(im.killerOf(victim, strikers, "Cy")).toBeNull();
        expect(im.killerOf(victim, strikers, null)).toBeNull();
        expect(im.killerOf(victim, strikers, undefined)).toBe("Bo");
        expect(im.killerOf(victim, [{ name: "Ana", x: 9, z: 0 }], undefined)).toBeNull();
    });
});

describe("votes", () => {
    const alive = ["Ana", "Bo", "Cy", "Di"];

    it("puts out the one with the most votes", () => {
        expect(im.voteOutcome({ Ana: "Bo", Cy: "Bo", Di: "Ana", Bo: im.SKIP }, alive)).toEqual({
            out: "Bo",
            skipped: false
        });
    });

    it("puts out nobody on a tie", () => {
        expect(im.voteOutcome({ Ana: "Bo", Bo: "Ana" }, alive)).toEqual({
            out: null,
            skipped: false
        });
        expect(im.tally({ Ana: "Bo", Bo: im.SKIP }, alive)).toBeNull();
    });

    it("puts out nobody when skipping has the most, or nobody voted", () => {
        expect(im.voteOutcome({ Ana: im.SKIP, Bo: im.SKIP, Cy: "Di" }, alive)).toEqual({
            out: null,
            skipped: true
        });
        expect(im.voteOutcome({}, alive)).toEqual({ out: null, skipped: true });
    });

    it("counts only votes from and for players still in", () => {
        expect(im.tally({ Ed: "Bo", Ana: "Cy" }, alive)).toBe("Cy");
        expect(im.tally({ Ana: "Ed" }, alive)).toBeNull();
    });

    it("reads a vote and a report typed in chat", () => {
        expect(im.voteSaid("vote bo", alive)).toBe("Bo");
        expect(im.voteSaid("votar Cy", alive)).toBe("Cy");
        expect(im.voteSaid("skip", alive)).toBe(im.SKIP);
        expect(im.voteSaid("saltar", alive)).toBe(im.SKIP);
        expect(im.voteSaid("vote Ed", alive)).toBeNull();
        expect(im.voteSaid("hello", alive)).toBeNull();
        expect(im.reportSaid(" Report ")).toBe(true);
        expect(im.reportSaid("reportar")).toBe(true);
        expect(im.reportSaid("I report nothing")).toBe(false);
    });

    it("reads every button back as what it was", () => {
        expect(im.pressOf(0)).toBeNull();
        expect(im.pressOf(im.PRESSED_SKIP)).toEqual({ kind: "skip" });
        expect(im.pressOf(im.PRESSED_EMERGENCY)).toEqual({ kind: "emergency" });
        expect(im.pressOf(im.VOTE_BASE + 14)).toEqual({ kind: "vote", entrant: 14 });
        expect(im.pressOf(im.TASK_BASE + 23)).toEqual({ kind: "task", station: 23 });
        expect(im.pressOf(im.REPORT_BASE + 3)).toEqual({ kind: "report", body: 3 });
    });

    it("takes a press only from beside what it names", () => {
        const layout = im.layoutFor("reach", im.stationBox(SITE, Y, 8));
        const y = layout.box.y1 + 1;
        const far = { x: layout.meeting.x + 5, y, z: layout.meeting.z + 5 };
        const lever = layout.stations.find((one) => one.kind !== "scan")!;
        const plate = layout.stations.find((one) => one.kind === "scan")!;
        const task = { kind: "task", station: lever.id } as const;
        const besideLever = { x: lever.x + 1.5, y, z: lever.z + 0.5 };
        expect(im.pressReaches(layout, [], task, besideLever)).toBe(true);
        expect(im.pressReaches(layout, [], task, { x: lever.x + 40, y, z: lever.z })).toBe(false);
        expect(im.pressReaches(layout, [], task, undefined)).toBe(false);
        expect(
            im.pressReaches(
                layout,
                [],
                { kind: "task", station: plate.id },
                {
                    x: plate.x + 0.5,
                    y,
                    z: plate.z + 0.5
                }
            )
        ).toBe(false);
        expect(im.pressReaches(layout, [], { kind: "task", station: 9999 }, far)).toBe(false);
        const body = { name: "Bo", x: lever.x + 0.5, y, z: lever.z + 0.5, gone: false };
        expect(im.pressReaches(layout, [body], { kind: "report", body: 0 }, besideLever)).toBe(
            true
        );
        expect(
            im.pressReaches(
                layout,
                [body],
                { kind: "report", body: 0 },
                { ...body, x: body.x + 40 }
            )
        ).toBe(false);
        expect(im.pressReaches(layout, [], { kind: "report", body: 0 }, besideLever)).toBe(false);
        expect(im.pressReaches(layout, [], { kind: "emergency" }, far)).toBe(true);
        expect(im.pressReaches(layout, [], { kind: "emergency" }, { ...far, x: far.x + 40 })).toBe(
            false
        );
        expect(im.pressReaches(layout, [], { kind: "skip" }, undefined)).toBe(true);
    });
});

describe("the commands", () => {
    const era: im.Era = {
        interaction: true,
        components: true,
        itemCommand: true,
        modernText: true
    };

    it("fits a full ballot line with sixteen-letter names in one command", () => {
        const long = Array.from({ length: im.BALLOT_PER_LINE }, (_, n) => ({
            label: `Abcdefghijklmn_${n}`,
            color: "yellow",
            value: im.VOTE_BASE + n
        }));
        for (const language of ["en", "es"] as const) {
            const line = im.buttonsLine(
                "Abcdefghijklmnop",
                messages.tag(language) + said.ballotLead(30, language),
                long
            );
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            expect(line).toContain(`/trigger ${im.PRESS} set ${im.VOTE_BASE}`);
            expect(line).toContain("click_event");
            expect(line).toContain("clickEvent");
        }
    });

    it("leaves a body that can be reported and taken away, on old and new servers", () => {
        const body = { name: "Ana", x: 10.3, y: 101, z: -5.7, gone: false };
        const modern = im.bodyLines(body, 0, era);
        expect(modern.some((line) => line.includes("minecraft:interaction"))).toBe(true);
        expect(modern.some((line) => line.includes("minecraft:profile"))).toBe(true);
        const old = im.bodyLines(body, 0, im.OLDEST);
        expect(old.some((line) => line.includes("minecraft:interaction"))).toBe(false);
        expect(old.some((line) => line.startsWith("replaceitem "))).toBe(true);
        expect(im.reportLines([body], era).join("\n")).toContain(`${im.PRESS} ${im.REPORT_BASE}`);
        expect(im.reportLines([body], im.OLDEST)).toEqual([]);
        expect(im.reportLines([{ ...body, gone: true }], era)).toEqual([]);
        for (const line of im.entitiesOff()) expect(line).toMatch(/pe_im_(body|label)/);
    });

    it("reads every switch and button, and the emergency button, from one count", () => {
        const layout = im.layoutFor("run", im.stationBox(SITE, Y, 8));
        const lines = im.pressLines(layout);
        const pressed = layout.stations.filter((one) => one.kind !== "scan");
        for (const station of pressed)
            expect(
                lines.some((line) => line.endsWith(`${im.PRESS} ${im.TASK_BASE + station.id}`))
            ).toBe(true);
        expect(lines.some((line) => line.endsWith(`${im.PRESS} ${im.PRESSED_EMERGENCY}`))).toBe(
            true
        );
    });

    it("takes everything it set up away at the end", () => {
        const setup = im.setupLines().join("\n");
        for (const objective of [im.PRESS, im.DEALT, im.TAKEN]) {
            expect(setup).toContain(`scoreboard objectives add ${objective}`);
            expect(im.TEARDOWN).toContain(`scoreboard objectives remove ${objective}`);
        }
        expect(im.TEARDOWN).toContain(`team remove ${im.TEAM}`);
        for (const tag of [im.LIVE_TAG, im.GHOST_TAG, im.IMPOSTOR_TAG])
            expect(im.TEARDOWN).toContain(`tag @a[tag=${tag}] remove ${tag}`);
    });

    it("says every line in both languages within one command", () => {
        const task = { room: "engine" as const, kind: "switch" as const };
        for (const language of ["en", "es"] as const) {
            const lines = [
                said.crewTitle(language),
                said.crewSubtitle(3, language),
                said.impostorTitle(language),
                said.impostorSubtitle(language),
                said.partners(["Abcdefghijklmnop", "Bcdefghijklmnopq"], language),
                said.taskList(
                    Array.from({ length: 8 }, () => task),
                    false,
                    language
                ),
                said.howTo(30, language),
                said.crewBar(7, 32, task, language),
                said.reported("Abcdefghijklmnop", "Bcdefghijklmnopq", language),
                said.ejected("Abcdefghijklmnop", true, language),
                said.ejected("Abcdefghijklmnop", null, language),
                said.nobodyEjected(true, language),
                said.crewWon("tasks", language),
                said.impostorsWon("time", language),
                said.impostorsWere(
                    ["Abcdefghijklmnop", "Bcdefghijklmnopq", "Cdefghijklmnopqr"],
                    language
                )
            ];
            for (const line of lines) {
                expect(line.length).toBeGreaterThan(0);
                expect(commandBytes(`tellraw Abcdefghijklmnop ${line}`)).toBeLessThanOrEqual(
                    COMMAND_BYTES_MAX
                );
            }
            expect(said.taskName(task, language)).not.toBe(
                said.taskName(task, language === "en" ? "es" : "en")
            );
        }
    });
});

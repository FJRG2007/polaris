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
    for (const design of [1, im.FURNISHED_SINCE, im.DESIGN])
        for (const players of [4, 8, 9, 15]) {
            it(`is built only into its own box, every block once, for ${players} on design ${design}`, () => {
                const box = im.stationBox(SITE, Y, players, design);
                expect(im.rowsOf(box, design)).toBe(im.rowsFor(players));
                expect(Math.ceil((box.x2 - box.x1 + 1) / 2)).toBeLessThanOrEqual(
                    im.reachOf(players, design)
                );
                for (let seed = 0; seed < SEEDS; seed += 1) {
                    const layout = im.layoutFor(`run-${seed}`, box, design);
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
        for (const design of [1, im.FURNISHED_SINCE, im.DESIGN])
            for (const players of [4, 12])
                for (let seed = 0; seed < SEEDS; seed += 1) {
                    const layout = im.layoutFor(
                        `run-${seed}`,
                        im.stationBox(SITE, Y, players, design),
                        design
                    );
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
                            if (reached.has(key) || !im.walkable(plan[x! + dx!]?.[z! + dz!]))
                                continue;
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
                    if (design < im.SHIP_SINCE) {
                        expect(layout.meeting.col).toBe(1);
                        expect(layout.meeting.row).toBe(1);
                    } else expect(layout.meeting.name).toBe("cafeteria");
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

    it("keeps a station built on the first design as it was: no bridge, no dark room, nothing furnished", () => {
        const box = im.stationBox(SITE, Y, 9, 1);
        expect(box.x2 - box.x1 + 1).toBe(41);
        expect(box.y2 - box.y1).toBe(5);
        const layout = im.layoutFor("run", box, 1);
        expect(layout.rooms.map((room) => room.name)).not.toContain("bridge");
        expect(layout.rooms.some((room) => room.dark)).toBe(false);
        expect(layout.props).toEqual([]);
        expect(layout.stations.slice(0, 2).map((one) => [one.x - box.x1, one.z - box.z1])).toEqual([
            [2, 2],
            [8, 8]
        ]);
        expect(im.tableAt(layout)).toEqual({ x: box.x1 + 20, z: box.z1 + 20 });
    });

    it("has a bridge looking out on space, one dark room, and every other room furnished", () => {
        const design = im.FURNISHED_SINCE;
        for (const players of [4, 12])
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const box = im.stationBox(SITE, Y, players, design);
                const layout = im.layoutFor(`run-${seed}`, box, design);
                const plan = im.planOf(layout);
                const bridge = layout.rooms.find((room) => room.name === "bridge")!;
                expect([bridge.col, bridge.row]).toEqual([1, 0]);
                expect(layout.vents.some((vent) => vent.room === bridge.index)).toBe(false);
                const dark = layout.rooms.filter((room) => room.dark);
                expect(dark).toHaveLength(1);
                expect(["meeting", "bridge"]).not.toContain(dark[0]!.name);
                const at = new Map<string, string>();
                for (const fill of im.stationFills(layout))
                    for (let x = fill.box.x1; x <= fill.box.x2; x += 1)
                        for (let y = fill.box.y1; y <= fill.box.y2; y += 1)
                            for (let z = fill.box.z1; z <= fill.box.z2; z += 1)
                                at.set(`${x},${y},${z}`, bare(fill.block));
                // The window across the bridge, the dark and the stars behind it.
                for (let x = bridge.x + 1; x < bridge.x + im.ROOM - 1; x += 1) {
                    expect(at.get(`${x},${Y + 2},${bridge.z + 3}`)).toBe("minecraft:glass");
                    expect(at.get(`${x},${Y + 2},${bridge.z + 2}`)).toBeUndefined();
                    expect(at.get(`${x},${Y + 2},${bridge.z + 1}`)).toMatch(
                        /black_concrete|sea_lantern/
                    );
                }
                // No light over the dark room.
                const room = dark[0]!;
                for (let dx = 1; dx < im.ROOM - 1; dx += 1)
                    for (let dz = 1; dz < im.ROOM - 1; dz += 1)
                        expect(at.get(`${room.x + dx},${box.y2},${room.z + dz}`)).toBe(
                            "minecraft:quartz_block"
                        );
                // Every room but the meeting room furnished, never by a station,
                // a vent or its way out.
                for (const one of layout.rooms) {
                    const props = layout.props.filter(
                        (prop) => plan[prop.x - box.x1]![prop.z - box.z1] === one.index
                    );
                    if (one.name === "meeting") expect(props).toEqual([]);
                    else expect(props.length, one.name).toBeGreaterThan(0);
                }
                const kept = [
                    ...layout.stations,
                    ...layout.vents,
                    ...layout.vents.map((vent) => ({ x: vent.outX, z: vent.outZ }))
                ];
                for (const prop of layout.props)
                    for (const one of kept)
                        expect(
                            Math.max(Math.abs(one.x - prop.x), Math.abs(one.z - prop.z)),
                            `${seed} ${prop.x},${prop.z}`
                        ).toBeGreaterThan(1);
                // Walked round the furnishing: every station, vent and seat reached.
                const blocked = new Set(layout.props.map((prop) => `${prop.x},${prop.z}`));
                for (const station of layout.stations)
                    if (station.kind !== "scan") blocked.add(`${station.x},${station.z}`);
                const table = im.tableAt(layout);
                const start = `${table.x + 2},${table.z}`;
                const reached = new Set([start]);
                const queue = [start];
                const steps = [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ] as const;
                while (queue.length > 0) {
                    const [x, z] = queue.pop()!.split(",").map(Number) as [number, number];
                    for (const [dx, dz] of steps) {
                        const next = `${x + dx},${z + dz}`;
                        if (reached.has(next) || blocked.has(next)) continue;
                        if (!im.walkable(plan[x + dx - box.x1]?.[z + dz - box.z1])) continue;
                        reached.add(next);
                        queue.push(next);
                    }
                }
                const near = (x: number, z: number) =>
                    reached.has(`${x},${z}`) ||
                    steps.some(([dx, dz]) => reached.has(`${x + dx},${z + dz}`));
                for (const station of layout.stations)
                    expect(near(station.x, station.z), `${seed} station ${station.id}`).toBe(true);
                for (const vent of layout.vents) {
                    expect(reached.has(`${vent.x},${vent.z}`)).toBe(true);
                    expect(reached.has(`${vent.outX},${vent.outZ}`)).toBe(true);
                }
                for (let seat = 0; seat < players; seat += 1) {
                    const spot = im.seatSpot(layout, seat, players);
                    expect(reached.has(`${spot.x},${spot.z}`)).toBe(true);
                }
            }
    });

    it("names the bridge in both languages", () => {
        expect(said.roomName("bridge", "en")).toBe("Bridge");
        expect(said.roomName("bridge", "es")).toBe("Puente de mando");
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

/** A string's FNV-1a hash: a station's blocks pinned without a page of them. */
function digest(text: string): string {
    let hash = 0x811c9dc5;
    for (let at = 0; at < text.length; at += 1)
        hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0;
    return hash.toString(16);
}

/** Every block a station puts down, by `x,y,z`. */
function blocksOf(layout: im.Layout): Map<string, string> {
    const at = new Map<string, string>();
    for (const fill of im.stationFills(layout))
        for (let x = fill.box.x1; x <= fill.box.x2; x += 1)
            for (let y = fill.box.y1; y <= fill.box.y2; y += 1)
                for (let z = fill.box.z1; z <= fill.box.z2; z += 1)
                    at.set(`${x},${y},${z}`, fill.block);
    return at;
}

describe("the ship", () => {
    const SHIP = ["cafeteria", "medbay", "electrical", "admin", "storage", "weapons", "o2"];
    const WING = ["reactor", "upperEngine", "lowerEngine", "security"];

    it("keeps a run built on an older design block for block as it was", () => {
        const pinned: Record<string, string> = {
            "1,6": "df49eb8a",
            "1,12": "cd0624cd",
            "2,6": "56a0965d",
            "2,12": "235ba457"
        };
        for (const [key, hash] of Object.entries(pinned)) {
            const [design, players] = key.split(",").map(Number) as [number, number];
            const layout = im.layoutFor(
                "run-7",
                im.stationBox({ x: 300, z: -120 }, 100, players, design),
                design
            );
            expect(digest(JSON.stringify(im.stationFills(layout))), key).toBe(hash);
            expect(layout.pieces).toEqual([]);
        }
        const box = im.stationBox(SITE, Y, 8, im.FURNISHED_SINCE);
        expect(box.x2 - box.x1 + 1).toBe(55);
        expect(im.rowsOf(box, im.FURNISHED_SINCE)).toBe(3);
    });

    it("is bigger than the grid, with the engine wing past eight players", () => {
        const small = im.stationBox(SITE, Y, 8);
        const full = im.stationBox(SITE, Y, 9);
        expect([small.x2 - small.x1 + 1, small.z2 - small.z1 + 1]).toEqual([100, 60]);
        expect([full.x2 - full.x1 + 1, full.z2 - full.z1 + 1]).toEqual([140, 60]);
        expect(im.rowsOf(small)).toBe(3);
        expect(im.rowsOf(full)).toBe(4);
        expect(im.reachOf(9)).toBeGreaterThan(im.reachOf(9, im.FURNISHED_SINCE));
        const names = (box: typeof small) =>
            im.layoutFor("run", box).rooms.map((room) => room.name);
        expect(names(small)).toEqual(
            expect.arrayContaining([...SHIP, "navigation", "shields", "communications"])
        );
        expect(names(small)).not.toEqual(expect.arrayContaining(WING.slice(0, 1)));
        expect(names(full)).toEqual(expect.arrayContaining([...SHIP, ...WING]));
        expect(names(full)).toHaveLength(14);
    });

    it("lays out the same ship for the same run", () => {
        const box = im.stationBox(SITE, Y, 12);
        expect(digest(JSON.stringify(im.stationFills(im.layoutFor("again", box))))).toBe(
            digest(JSON.stringify(im.stationFills(im.layoutFor("again", box))))
        );
    });

    it("meets in the cafeteria, gives every room its tasks, furnishing and a way round it", () => {
        for (const players of [4, 8, 9, 15])
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const box = im.stationBox(SITE, Y, players);
                const layout = im.layoutFor(`run-${seed}`, box);
                const plan = im.planOf(layout);
                const cafeteria = layout.meeting;
                expect(cafeteria.name).toBe("cafeteria");
                expect(im.tableAt(layout)).toEqual({
                    x: cafeteria.x + (cafeteria.w! - 1) / 2,
                    z: cafeteria.z + (cafeteria.d! - 1) / 2
                });
                // Vents: three pairs on the small ship, four on the full one,
                // never in the cafeteria.
                expect(layout.vents).toHaveLength(players <= 8 ? 6 : 8);
                // Never in the cafeteria, and never beside a console a switch
                // or button powers, which would open it.
                for (const vent of layout.vents) {
                    expect(layout.rooms[vent.room]!.name).not.toBe("cafeteria");
                    for (const station of layout.stations)
                        if (station.kind !== "scan")
                            expect(
                                Math.max(Math.abs(station.x - vent.x), Math.abs(station.z - vent.z))
                            ).toBeGreaterThan(1);
                }
                const at = blocksOf(layout);
                const cellOf = (x: number, z: number) => plan[x - box.x1]?.[z - box.z1];
                for (const room of layout.rooms) {
                    const stations = layout.stations.filter((one) => one.room === room.index);
                    if (room.name === "cafeteria") expect(stations).toEqual([]);
                    else expect(stations.length, room.name).toBeGreaterThanOrEqual(2);
                    const pieces = layout.pieces.filter(
                        (piece) => cellOf(piece.box.x1, piece.box.z1) === room.index
                    );
                    expect(pieces.length, room.name).toBeGreaterThan(2);
                }
                // Navigation looks out on space through a window.
                const navigation = layout.rooms.find((room) => room.name === "navigation")!;
                const window = navigation.x + navigation.w! - 4;
                for (let z = navigation.z + 1; z < navigation.z + navigation.d! - 1; z += 1) {
                    expect(at.get(`${window},${Y + 2},${z}`)).toBe("minecraft:glass");
                    expect(at.get(`${window + 1},${Y + 2},${z}`)).toBeUndefined();
                    expect(at.get(`${window + 2},${Y + 2},${z}`)).toMatch(
                        /black_concrete|sea_lantern/
                    );
                }
                // Nothing in the way where somebody stands or sits.
                const kept = [
                    ...layout.stations,
                    ...layout.vents,
                    ...layout.vents.map((vent) => ({ x: vent.outX, z: vent.outZ })),
                    ...Array.from({ length: players }, (_, n) => im.seatSpot(layout, n, players))
                ];
                for (const spot of kept) {
                    const y = Y + 2;
                    const here = at.get(`${spot.x},${y},${spot.z}`);
                    if (here !== undefined) expect(here).toMatch(/lever|button/);
                }
                // Walked round everything that stands on the floor.
                const blocked = (x: number, z: number) => {
                    const low = at.get(`${x},${Y + 1},${z}`);
                    const high = at.get(`${x},${Y + 2},${z}`);
                    const solid = (block: string | undefined) =>
                        block !== undefined &&
                        !/carpet|pressure_plate|iron_trapdoor|_slab\[type=bottom\]/.test(block);
                    return solid(low) || solid(high);
                };
                const table = im.tableAt(layout);
                const start = `${table.x + 3},${table.z}`;
                const reached = new Set([start]);
                const queue = [start];
                const steps = [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ] as const;
                while (queue.length > 0) {
                    const [x, z] = queue.pop()!.split(",").map(Number) as [number, number];
                    for (const [dx, dz] of steps) {
                        const next = `${x + dx},${z + dz}`;
                        if (reached.has(next) || blocked(x + dx, z + dz)) continue;
                        if (!im.walkable(cellOf(x + dx, z + dz))) continue;
                        reached.add(next);
                        queue.push(next);
                    }
                }
                const rooms = new Set<number>();
                for (const key of reached) {
                    const [x, z] = key.split(",").map(Number) as [number, number];
                    const cell = cellOf(x, z);
                    if (typeof cell === "number") rooms.add(cell);
                }
                expect(rooms.size, `${seed}`).toBe(layout.rooms.length);
                const near = (x: number, z: number) =>
                    reached.has(`${x},${z}`) ||
                    steps.some(([dx, dz]) => reached.has(`${x + dx},${z + dz}`));
                for (const station of layout.stations)
                    expect(near(station.x, station.z), `${seed} station ${station.id}`).toBe(true);
                for (const vent of layout.vents) {
                    expect(reached.has(`${vent.x},${vent.z}`), `${seed} vent`).toBe(true);
                    expect(reached.has(`${vent.outX},${vent.outZ}`), `${seed} out`).toBe(true);
                }
                for (let seat = 0; seat < players; seat += 1) {
                    const spot = im.seatSpot(layout, seat, players);
                    expect(reached.has(`${spot.x},${spot.z}`)).toBe(true);
                }
            }
    });

    it("comes down completely, what stands or hangs on something before it", () => {
        const order = im.stationBlocks();
        const STANDS =
            /carpet|fern|lever|button|pressure_plate|minecraft:lantern\[hanging=false|brewing_stand/;
        for (const players of [4, 15])
            for (let seed = 0; seed < 5; seed += 1) {
                const at = blocksOf(im.layoutFor(`run-${seed}`, im.stationBox(SITE, Y, players)));
                const left = new Map(at);
                for (const id of order)
                    for (const [key, block] of left) if (bare(block) === id) left.delete(key);
                expect(left.size).toBe(0);
                for (const [key, block] of at) {
                    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
                    const hanging = block.includes("hanging=true");
                    if (!hanging && !STANDS.test(block)) continue;
                    const holder = at.get(`${x},${hanging ? y + 1 : y - 1},${z}`);
                    expect(holder, `${block} at ${key}`).toBeDefined();
                    if (holder === undefined) continue;
                    expect(order.indexOf(bare(block)), `${block} on ${holder}`).toBeLessThan(
                        order.indexOf(bare(holder))
                    );
                }
            }
    });

    it("names every room of the ship in both languages", () => {
        for (const room of [...SHIP, ...WING, "navigation", "shields", "communications"] as const) {
            expect(said.roomName(room, "en")).toMatch(/\w/);
            expect(said.roomName(room, "es")).toMatch(/\w/);
        }
        expect(said.roomName("cafeteria", "es")).toBe("Cafetería");
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
        const table = im.tableAt(layout);
        const far = { x: table.x - 2, y, z: table.z - 2 };
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
    it("owes a player offline at the end every tag the teardown took off the rest", () => {
        const off = im.tagsOff("Steve");
        for (const line of im.TEARDOWN) {
            const tag = /^tag @a(?:\[tag=[\w]+\])? remove (\w+)$/.exec(line)?.[1];
            if (tag) expect(off).toContain(`tag Steve remove ${tag}`);
        }
        expect(off).toContain(`tag Steve remove ${im.GHOST_TAG}`);
    });

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

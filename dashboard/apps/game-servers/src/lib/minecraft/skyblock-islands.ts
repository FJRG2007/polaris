/**
 * More islands for the Skyblock 2.1 map, put into the sky by Polaris.
 *
 * The map ships two: the start island and the sand island west of it. Everything
 * else in its overworld is void, which is a short game. These are ten more, each
 * small and themed - snow, jungle, mushrooms, ore, a beach, the nether, a meadow
 * with bees, a farm, ruins with two chests and a desert - spread around the start
 * at a swim-less but bridgeable distance.
 *
 * Original content, written here as code: every island is a few shapes and a few
 * blocks placed by hand, built into a grid of blocks and turned into console
 * lines. Nothing is random at run time, so the same lines come out every time.
 *
 * Every line is a `fill ... keep` or a `setblock ... keep`, which only ever puts a
 * block where there is air: a server whose players have built out there already
 * loses nothing, and sending the same lines twice changes nothing the first time
 * did not. The block list is held to what exists in 1.16, the oldest release the
 * map runs on, and the chests are filled from the game's own loot tables rather
 * than from item data, whose format has changed twice since.
 *
 * Pure: the islands and their lines. Reaching the server is
 * `skyblock-islands-service.ts`.
 */

/** The map this belongs to (`WORLD_MAPS` in `maps.ts`). */
export const SKYBLOCK_MAP_ID = "skyblock-2-1";

/** Install config key recording that the islands are in this level's sky, so the
 *  walk stops opening the server to look. A reset onto a new world clears it. */
export const SKYBLOCK_ISLANDS_KEY = "skyblockIslands";

/** Install config key counting the passes that tried, so a world that never takes
 *  them stops being visited. */
export const SKYBLOCK_ISLANDS_TRIES_KEY = "skyblockIslandsTries";

/** Passes before giving up on a world that does not take the islands. */
export const MAX_TRIES = 5;

/** The console prefix that pins a line to the overworld, whoever runs it. */
const IN_OVERWORLD = "execute in minecraft:overworld run";

/** A block position. */
export interface Point {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** A column-aligned area, both corners inclusive. */
export interface Area {
    readonly x1: number;
    readonly z1: number;
    readonly x2: number;
    readonly z2: number;
}

/**
 * What the map already has and the players have added, which nothing here may
 * reach: the start island (x -16..15, z -16..15), the sand island (x -80..-65,
 * z -16..15) and the bridge between them, with room to spare around all three.
 */
export const PROTECTED_AREA: Area = { x1: -96, z1: -32, x2: 32, z2: 32 };

/** The start island's own box, for telling this map's world from another. */
const START_BOX = { from: { x: -16, y: 64, z: -16 }, to: { x: 15, y: 73, z: 15 } } as const;

/** An empty box of the same size the start island is compared against: if the two
 *  match, the start island is not there. High enough that nobody builds there,
 *  low enough for the 1.16 build limit. */
const EMPTY_BOX_FROM = { x: -16, y: 230, z: -16 } as const;

/**
 * The line that says whether this is the map's world: `Test passed` when the
 * start island is there, `Test failed` when that box is as empty as the sky.
 */
export const START_PRESENT = `execute in minecraft:overworld unless blocks ${START_BOX.from.x} ${START_BOX.from.y} ${START_BOX.from.z} ${START_BOX.to.x} ${START_BOX.to.y} ${START_BOX.to.z} ${EMPTY_BOX_FROM.x} ${EMPTY_BOX_FROM.y} ${EMPTY_BOX_FROM.z} all`;

/** Blocks that fall when nothing holds them up. */
const FALLING = new Set(["minecraft:sand", "minecraft:red_sand", "minecraft:gravel"]);

/** Blocks that flow. */
const FLUIDS = new Set(["minecraft:water", "minecraft:lava"]);

/** One placed block. `attached` ones go in after every solid one, since they sit
 *  on or hang from something: plants, fluids, cocoa. */
export interface Cell extends Point {
    readonly block: string;
    readonly attached: boolean;
}

/** One island as it will stand. */
export interface Island {
    readonly id: string;
    /** The middle of its top layer. */
    readonly center: Point;
    readonly cells: readonly Cell[];
    /** The block whose presence says the island is there: the last one placed. */
    readonly anchor: Point;
    /** Lines run once, right after the island is first seen standing. */
    readonly extras: readonly string[];
}

/** A small deterministic generator, seeded from the island's name. */
function seeded(seed: string): () => number {
    let state = 2166136261;
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    return () => {
        state = Math.imul(state ^ (state >>> 15), 2246822507);
        state = Math.imul(state ^ (state >>> 13), 3266489909);
        state ^= state >>> 16;
        return (state >>> 0) / 4294967296;
    };
}

/** Whether a column sits inside a rounded disc of `radius`. */
function inDisc(dx: number, dz: number, radius: number): boolean {
    return radius >= 0 && dx * dx + dz * dz <= radius * radius + radius;
}

/** The grid an island is drawn into, in offsets from its top center. */
class Builder {
    readonly cells = new Map<string, Cell>();
    readonly extras: string[] = [];
    readonly random: () => number;

    constructor(
        readonly id: string,
        readonly center: Point
    ) {
        this.random = seeded(id);
    }

    private key(dx: number, dy: number, dz: number): string {
        return `${dx},${dy},${dz}`;
    }

    at(dx: number, dy: number, dz: number): Point {
        return { x: this.center.x + dx, y: this.center.y + dy, z: this.center.z + dz };
    }

    has(dx: number, dy: number, dz: number): boolean {
        return this.cells.has(this.key(dx, dy, dz));
    }

    /** Put a block, replacing whatever was drawn there. */
    put(dx: number, dy: number, dz: number, block: string, attached = false): void {
        this.cells.set(this.key(dx, dy, dz), { ...this.at(dx, dy, dz), block, attached });
    }

    /** Put a block only where nothing is drawn yet. */
    add(dx: number, dy: number, dz: number, block: string): void {
        if (!this.has(dx, dy, dz)) this.put(dx, dy, dz, block);
    }

    /** Something that rests on, or hangs from, a block already drawn. */
    attach(dx: number, dy: number, dz: number, block: string): void {
        this.put(dx, dy, dz, block, true);
    }

    /**
     * The island itself: a top layer, a layer of soil the same width under it so
     * whatever falls is held, and a core that narrows to a point below.
     */
    body(radius: number, depth: number, surface: string, soil: string, core: string): void {
        for (let dy = 0; dy > -depth; dy -= 1) {
            const down = -dy;
            const reach =
                down <= 1
                    ? radius
                    : Math.round((radius - 1) * (1 - (down - 2) / Math.max(1, depth - 2)));
            const block = down === 0 ? surface : down <= 2 ? soil : core;
            for (let dx = -radius; dx <= radius; dx += 1) {
                for (let dz = -radius; dz <= radius; dz += 1) {
                    if (inDisc(dx, dz, Math.max(0, reach))) this.put(dx, dy, dz, block);
                }
            }
        }
    }

    /** Swap `count` of the cells below the top for `block`, the same ones every time. */
    scatter(block: string, count: number, deepest = -1): void {
        const candidates = [...this.cells.entries()]
            .filter(([key, cell]) => {
                const dy = cell.y - this.center.y;
                return dy <= deepest && key !== this.key(0, -1, 0) && !cell.attached;
            })
            .map(([key]) => key)
            .sort();
        for (let placed = 0; placed < count && candidates.length > 0; placed += 1) {
            const [key] = candidates.splice(Math.floor(this.random() * candidates.length), 1);
            const [dx, dy, dz] = (key as string).split(",").map(Number) as [
                number,
                number,
                number
            ];
            this.put(dx, dy, dz, block);
        }
    }

    /** A tree standing on the top layer: a trunk and a rounded crown of leaves that
     *  never decay. */
    tree(dx: number, dz: number, log: string, leaves: string, height: number): void {
        const leaf = `${leaves}[persistent=true]`;
        for (let dy = 1; dy <= height; dy += 1) this.put(dx, dy, dz, log);
        for (let dy = height - 2; dy <= height + 1; dy += 1) {
            const reach = dy >= height ? 1 : 2;
            for (let ox = -reach; ox <= reach; ox += 1) {
                for (let oz = -reach; oz <= reach; oz += 1) {
                    const corner = Math.abs(ox) === reach && Math.abs(oz) === reach;
                    if (corner && (reach === 2 || dy === height + 1)) continue;
                    this.add(dx + ox, dy, dz + oz, leaf);
                }
            }
        }
    }

    /** Plants on top, one per spot picked from the open top layer. */
    plants(
        blocks: readonly string[],
        count: number,
        avoid: (dx: number, dz: number) => boolean
    ): void {
        const spots: [number, number][] = [];
        for (const cell of this.cells.values()) {
            const dx = cell.x - this.center.x;
            const dz = cell.z - this.center.z;
            if (cell.y !== this.center.y || cell.attached || avoid(dx, dz)) continue;
            if (!/grass_block|mycelium|sand|podzol/.test(cell.block)) continue;
            if (this.has(dx, 1, dz)) continue;
            spots.push([dx, dz]);
        }
        spots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (let placed = 0; placed < count && spots.length > 0; placed += 1) {
            const [spot] = spots.splice(Math.floor(this.random() * spots.length), 1);
            const [dx, dz] = spot as [number, number];
            this.attach(dx, 1, dz, blocks[placed % blocks.length] as string);
        }
    }

    /**
     * The block that goes in after every other one, so finding it means the whole
     * island was sent: the lowest solid one nearest the middle, with nothing that
     * falls resting on it.
     */
    private anchor(): Point {
        const cell = [...this.cells.values()]
            .filter((one) => {
                if (one.attached) return false;
                const above = this.cells.get(
                    this.key(one.x - this.center.x, one.y - this.center.y + 1, one.z - this.center.z)
                );
                return !above || (!FALLING.has(above.block) && !above.attached);
            })
            .sort(
                (a, b) =>
                    a.y - b.y ||
                    Math.abs(a.x - this.center.x) + Math.abs(a.z - this.center.z) -
                        (Math.abs(b.x - this.center.x) + Math.abs(b.z - this.center.z)) ||
                    a.x - b.x ||
                    a.z - b.z
            )[0];
        return cell ? { x: cell.x, y: cell.y, z: cell.z } : this.at(0, -1, 0);
    }

    build(): Island {
        return {
            id: this.id,
            center: this.center,
            cells: [...this.cells.values()],
            anchor: this.anchor(),
            extras: this.extras
        };
    }
}

/** Snow and ice, with a spruce. */
function frost(): Island {
    const b = new Builder("frost", { x: 0, y: 72, z: -90 });
    b.body(5, 5, "minecraft:snow_block", "minecraft:snow_block", "minecraft:packed_ice");
    b.scatter("minecraft:blue_ice", 2, -3);
    for (const [dx, dz] of [[2, 1], [3, 1], [2, 2], [3, 2]] as const)
        b.put(dx, 0, dz, "minecraft:ice");
    b.tree(-2, -1, "minecraft:spruce_log", "minecraft:spruce_leaves", 5);
    for (const [dx, dz] of [[1, -3], [-3, 2], [0, 3], [3, -1]] as const)
        b.attach(dx, 1, dz, "minecraft:snow[layers=1]");
    return b.build();
}

/** A jungle tree with ripe cocoa, a melon and a sapling to take home. */
function jungle(): Island {
    const b = new Builder("jungle", { x: 80, y: 66, z: -60 });
    b.body(6, 6, "minecraft:grass_block", "minecraft:dirt", "minecraft:dirt");
    b.scatter("minecraft:stone", 6, -3);
    b.tree(-1, -1, "minecraft:jungle_log", "minecraft:jungle_leaves", 7);
    for (const dy of [2, 3]) {
        b.attach(0, dy, -1, "minecraft:cocoa[age=2,facing=west]");
        b.attach(-2, dy, -1, "minecraft:cocoa[age=2,facing=east]");
        b.attach(-1, dy, 0, "minecraft:cocoa[age=2,facing=north]");
    }
    b.put(3, 1, 2, "minecraft:melon");
    b.attach(3, 1, -2, "minecraft:jungle_sapling");
    b.plants(["minecraft:fern"], 5, (dx, dz) => Math.abs(dx + 1) <= 2 && Math.abs(dz + 1) <= 2);
    return b.build();
}

/** Mycelium under a red mushroom the size of a tree. */
function mushroom(): Island {
    const b = new Builder("mushroom", { x: 100, y: 70, z: 30 });
    b.body(5, 5, "minecraft:mycelium", "minecraft:dirt", "minecraft:stone");
    for (let dy = 1; dy <= 4; dy += 1) b.put(0, dy, 0, "minecraft:mushroom_stem");
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) b.put(dx, 5, dz, "minecraft:red_mushroom_block");
    }
    for (const dy of [3, 4]) {
        for (let dx = -2; dx <= 2; dx += 1) {
            for (let dz = -2; dz <= 2; dz += 1) {
                const ring = Math.abs(dx) === 2 || Math.abs(dz) === 2;
                const corner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
                if (ring && !corner) b.put(dx, dy, dz, "minecraft:red_mushroom_block");
            }
        }
    }
    b.plants(
        ["minecraft:red_mushroom", "minecraft:brown_mushroom"],
        6,
        (dx, dz) => Math.abs(dx) <= 2 && Math.abs(dz) <= 2
    );
    return b.build();
}

/** Bare stone full of ore, one diamond at the bottom. */
function ore(): Island {
    const b = new Builder("ore", { x: 60, y: 62, z: 90 });
    b.body(5, 6, "minecraft:stone", "minecraft:stone", "minecraft:stone");
    b.scatter("minecraft:coal_ore", 8);
    b.scatter("minecraft:iron_ore", 6, -2);
    b.scatter("minecraft:gold_ore", 2, -3);
    b.scatter("minecraft:redstone_ore", 2, -3);
    b.scatter("minecraft:lapis_ore", 2, -3);
    b.put(0, -5, 0, "minecraft:diamond_ore");
    b.put(2, 0, -1, "minecraft:coal_ore");
    b.put(-1, 0, 3, "minecraft:coal_ore");
    return b.build();
}

/** Sand, gravel and clay, with a pool and sugar cane beside it. */
function beach(): Island {
    const b = new Builder("beach", { x: -20, y: 64, z: 100 });
    b.body(6, 5, "minecraft:sand", "minecraft:sandstone", "minecraft:stone");
    b.scatter("minecraft:clay", 6, -2);
    for (const [dx, dz] of [[3, 2], [4, 2], [3, 3]] as const) b.put(dx, 0, dz, "minecraft:gravel");
    for (const [dx, dz] of [[2, -3], [3, -3]] as const) b.put(dx, 0, dz, "minecraft:clay");
    b.attach(-2, 0, 1, "minecraft:water");
    b.attach(-1, 1, 1, "minecraft:sugar_cane");
    b.attach(-1, 2, 1, "minecraft:sugar_cane");
    b.attach(-3, 1, 1, "minecraft:sugar_cane");
    b.attach(1, 1, -1, "minecraft:dead_bush");
    return b.build();
}

/** Netherrack with quartz, glowstone, nether wart and a lava pit set into rock. */
function nether(): Island {
    const b = new Builder("nether", { x: -110, y: 68, z: 85 });
    b.body(5, 5, "minecraft:netherrack", "minecraft:netherrack", "minecraft:netherrack");
    b.scatter("minecraft:nether_quartz_ore", 6, -1);
    b.scatter("minecraft:glowstone", 2, -2);
    b.scatter("minecraft:shroomlight", 1, -2);
    b.put(-3, 0, 1, "minecraft:magma_block");
    for (const [dx, dz] of [[-2, -2], [-1, -2]] as const) {
        b.put(dx, 0, dz, "minecraft:soul_sand");
        b.attach(dx, 1, dz, "minecraft:nether_wart[age=3]");
    }
    for (const [dx, dz] of [[1, -3], [2, -3], [1, -2]] as const)
        b.put(dx, 0, dz, "minecraft:crimson_nylium");
    b.attach(1, 1, -3, "minecraft:crimson_fungus");
    b.attach(2, 0, 2, "minecraft:lava");
    return b.build();
}

/** Grass and flowers around a birch with a bee nest, and two bees for it. */
function meadow(): Island {
    const b = new Builder("meadow", { x: -160, y: 70, z: 10 });
    b.body(6, 5, "minecraft:grass_block", "minecraft:dirt", "minecraft:stone");
    b.tree(2, -2, "minecraft:birch_log", "minecraft:birch_leaves", 5);
    b.put(2, 2, -1, "minecraft:bee_nest[facing=south]");
    b.plants(
        [
            "minecraft:poppy",
            "minecraft:dandelion",
            "minecraft:cornflower",
            "minecraft:oxeye_daisy",
            "minecraft:allium",
            "minecraft:azure_bluet",
            "minecraft:red_tulip",
            "minecraft:orange_tulip",
            "minecraft:lily_of_the_valley"
        ],
        14,
        (dx, dz) => Math.abs(dx - 2) <= 2 && Math.abs(dz + 2) <= 2
    );
    const nest = b.at(2, 2, 0);
    for (let bee = 0; bee < 2; bee += 1)
        b.extras.push(`${IN_OVERWORLD} summon minecraft:bee ${nest.x} ${nest.y} ${nest.z}`);
    return b.build();
}

/** Watered farmland already sown, a pumpkin, a composter and an oak for saplings. */
function farm(): Island {
    const b = new Builder("farm", { x: -130, y: 66, z: -70 });
    b.body(6, 5, "minecraft:grass_block", "minecraft:dirt", "minecraft:dirt");
    const crops = [
        "minecraft:wheat[age=0]",
        "minecraft:carrots[age=0]",
        "minecraft:potatoes[age=0]"
    ];
    for (let dx = -2; dx <= 2; dx += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
            if (dx === 0 && dz === 0) continue;
            b.put(dx, 0, dz, "minecraft:farmland[moisture=7]");
            b.attach(dx, 1, dz, crops[(dx + 2) % crops.length] as string);
        }
    }
    b.attach(0, 0, 0, "minecraft:water");
    b.put(4, 1, 0, "minecraft:pumpkin");
    b.put(3, 1, -3, "minecraft:composter");
    b.tree(-4, -3, "minecraft:oak_log", "minecraft:oak_leaves", 4);
    return b.build();
}

/** A broken stone floor with walls half standing, and two chests of starting loot. */
function ruins(): Island {
    const b = new Builder("ruins", { x: -50, y: 76, z: -110 });
    b.body(5, 5, "minecraft:grass_block", "minecraft:dirt", "minecraft:stone");
    const floor = [
        "minecraft:stone_bricks",
        "minecraft:mossy_stone_bricks",
        "minecraft:cracked_stone_bricks"
    ];
    for (let dx = -2; dx <= 2; dx += 1) {
        for (let dz = -2; dz <= 2; dz += 1)
            b.put(dx, 0, dz, floor[Math.floor(b.random() * floor.length)] as string);
    }
    const walls: [number, number, number][] = [
        [-3, -3, 3], [-2, -3, 2], [-1, -3, 1], [1, -3, 1], [3, -3, 2],
        [-3, -2, 2], [-3, 0, 1], [-3, 2, 2], [3, -1, 1], [3, 2, 3], [2, 3, 1]
    ];
    for (const [dx, dz, height] of walls) {
        for (let dy = 1; dy <= height; dy += 1)
            b.put(dx, dy, dz, dy === height ? "minecraft:mossy_cobblestone" : "minecraft:stone_bricks");
    }
    b.put(0, 1, 0, "minecraft:chest[facing=south]");
    b.put(-2, 1, 1, "minecraft:chest[facing=east]");
    b.attach(1, 1, 1, "minecraft:torch");
    const first = b.at(0, 1, 0);
    const second = b.at(-2, 1, 1);
    b.extras.push(
        `${IN_OVERWORLD} loot insert ${first.x} ${first.y} ${first.z} loot minecraft:chests/spawn_bonus_chest`,
        `${IN_OVERWORLD} loot insert ${second.x} ${second.y} ${second.z} loot minecraft:chests/village/village_plains_house`
    );
    return b.build();
}

/** Red sand over terracotta, a cactus and a small oasis. */
function desert(): Island {
    const b = new Builder("desert", { x: 150, y: 64, z: -20 });
    b.body(5, 5, "minecraft:red_sand", "minecraft:terracotta", "minecraft:red_sandstone");
    b.scatter("minecraft:gold_ore", 2, -3);
    b.attach(2, 1, 2, "minecraft:cactus");
    b.attach(2, 2, 2, "minecraft:cactus");
    b.attach(-2, 0, -1, "minecraft:water");
    b.attach(-1, 1, -1, "minecraft:sugar_cane");
    b.attach(-3, 1, -1, "minecraft:sugar_cane");
    b.attach(1, 1, -3, "minecraft:dead_bush");
    b.attach(-3, 1, 3, "minecraft:dead_bush");
    return b.build();
}

/** Every extra island, in the order they go up. */
export const ISLANDS: readonly Island[] = [
    frost(),
    jungle(),
    mushroom(),
    ore(),
    beach(),
    nether(),
    meadow(),
    farm(),
    ruins(),
    desert()
];

/** The columns an island covers. */
export function areaOf(island: Island): Area {
    const xs = island.cells.map((cell) => cell.x);
    const zs = island.cells.map((cell) => cell.z);
    return { x1: Math.min(...xs), z1: Math.min(...zs), x2: Math.max(...xs), z2: Math.max(...zs) };
}

/** Whether two areas share a column. */
export function overlaps(a: Area, b: Area): boolean {
    return a.x1 <= b.x2 && b.x1 <= a.x2 && a.z1 <= b.z2 && b.z1 <= a.z2;
}

/**
 * The lines that put an island up: the solid blocks bottom layer first, then
 * whatever rests on them, each layer as few rectangles of one block as it takes,
 * and the anchor on its own at the very end.
 */
export function placeLines(island: Island): string[] {
    const { anchor } = island;
    const isAnchor = (cell: Cell) => cell.x === anchor.x && cell.y === anchor.y && cell.z === anchor.z;
    const lines: string[] = [];
    for (const attached of [false, true]) {
        const cells = island.cells.filter((cell) => cell.attached === attached && !isAnchor(cell));
        const layers = [...new Set(cells.map((cell) => cell.y))].sort((a, b) => a - b);
        for (const y of layers) lines.push(...layerLines(cells.filter((cell) => cell.y === y)));
    }
    lines.push(...layerLines(island.cells.filter(isAnchor)));
    return lines;
}

/** One layer's cells as rectangles: runs along x, merged across z when equal. */
function layerLines(cells: readonly Cell[]): string[] {
    const byRow = new Map<number, Cell[]>();
    for (const cell of cells) byRow.set(cell.z, [...(byRow.get(cell.z) ?? []), cell]);
    const runs: { x1: number; x2: number; z: number; y: number; block: string }[] = [];
    for (const [z, row] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
        row.sort((a, b) => a.x - b.x);
        for (let at = 0; at < row.length; ) {
            let end = at;
            while (
                end + 1 < row.length &&
                row[end + 1]!.x === row[end]!.x + 1 &&
                row[end + 1]!.block === row[at]!.block
            )
                end += 1;
            runs.push({ x1: row[at]!.x, x2: row[end]!.x, z, y: row[at]!.y, block: row[at]!.block });
            at = end + 1;
        }
    }
    const lines: string[] = [];
    type Box = { x1: number; x2: number; z1: number; z2: number; y: number; block: string };
    const open = new Map<string, Box>();
    const flush = (key: string) => {
        const box = open.get(key)!;
        open.delete(key);
        lines.push(
            box.x1 === box.x2 && box.z1 === box.z2
                ? `${IN_OVERWORLD} setblock ${box.x1} ${box.y} ${box.z1} ${box.block} keep`
                : `${IN_OVERWORLD} fill ${box.x1} ${box.y} ${box.z1} ${box.x2} ${box.y} ${box.z2} ${box.block} keep`
        );
    };
    for (const run of runs) {
        const key = `${run.x1},${run.x2},${run.block}`;
        const box = open.get(key);
        if (box && box.z2 === run.z - 1) {
            box.z2 = run.z;
            continue;
        }
        if (box) flush(key);
        open.set(key, { x1: run.x1, x2: run.x2, z1: run.z, z2: run.z, y: run.y, block: run.block });
    }
    for (const key of [...open.keys()]) flush(key);
    return lines;
}

/** The line that answers `Test passed` when the island is standing. */
export function presentLine(island: Island): string {
    const { x, y, z } = island.anchor;
    return `execute in minecraft:overworld unless block ${x} ${y} ${z} minecraft:air`;
}

/** The line that holds an island's chunks loaded, or lets them go. */
export function forceloadLine(island: Island, add: boolean): string {
    const area = areaOf(island);
    const corners = `${area.x1} ${area.z1} ${area.x2} ${area.z2}`;
    return `${IN_OVERWORLD} forceload ${add ? "add" : "remove"} ${corners}`;
}

/** Whether a block falls when nothing holds it (exported for the tests). */
export function isFalling(block: string): boolean {
    return FALLING.has(block);
}

/** Whether a block flows (exported for the tests). */
export function isFluid(block: string): boolean {
    return FLUIDS.has(block);
}

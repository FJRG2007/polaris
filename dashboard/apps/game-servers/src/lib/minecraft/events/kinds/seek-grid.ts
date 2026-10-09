/**
 * The block model hide and seek's manor (`seek-manor.ts`) is drawn into and
 * checked against: every block of the house in its own terms, how a player
 * meets each one, and the two searches the rules run over it - where a player
 * can get to, and how much light reaches each place.
 *
 * Levels count from the floor (0): the rooms stand on it, the cellars and the
 * pond go down under it to `DEEP`, and the roof is at `ROOF`. A block written
 * with a leading `~` is only in the model - the water a waterfall pours, which
 * the game makes from its source - and is never built.
 *
 * Pure.
 */

/** How thick every wall is, outer and inner: a face, two of core, a face. */
export const WALL = 4;
/** A room's floor, wall to wall. */
export const ROOM = 14;
/** The roof's level, over the rooms' ten. */
export const ROOF = 11;
/** The lowest level the house fills: the cellars go down to here. */
export const DEEP = -6;
/** Levels from the box's bottom (its barrier) up to the floor. */
export const BASE = -DEEP + 1;

/** What a server can show: scaffolding (1.14), powder snow (1.17) and display
 *  entities (1.19.4). A house is drawn for one, so nothing it builds is
 *  refused. */
export interface Era {
    readonly scaffold: boolean;
    readonly snow: boolean;
    readonly display: boolean;
}

export const OLDEST: Era = { scaffold: false, snow: false, display: false };
export const NEWEST: Era = { scaffold: true, snow: true, display: true };

/** How a player meets a block. */
export type Cell =
    | "air"
    | "solid"
    | "tall"
    | "climb"
    | "door"
    | "hatch"
    | "water"
    | "lava"
    | "snow";

const CELL_OF: Readonly<Record<string, Cell>> = {
    "minecraft:ladder": "climb",
    "minecraft:scaffolding": "climb",
    "minecraft:vine": "climb",
    "minecraft:oak_door": "door",
    "minecraft:spruce_door": "door",
    "minecraft:dark_oak_door": "door",
    "minecraft:spruce_trapdoor": "hatch",
    "minecraft:dark_oak_trapdoor": "hatch",
    "minecraft:oak_trapdoor": "hatch",
    "minecraft:birch_trapdoor": "hatch",
    "minecraft:water": "water",
    "~water": "water",
    "minecraft:lava": "lava",
    "minecraft:powder_snow": "snow",
    "minecraft:oak_fence": "tall",
    "minecraft:spruce_fence": "tall",
    "minecraft:dark_oak_fence": "tall",
    "minecraft:cobblestone_wall": "tall",
    "minecraft:iron_bars": "tall"
};

/** Blocks with no collision at all: a body fits in them. */
const NO_COLLISION = /(_button|_carpet|_banner|_wall_banner|torch|poppy|dandelion|cornflower|azure_bluet|oxeye_daisy|allium|fern|grass$|short_grass|_sapling|tall_grass|_pressure_plate|_sign)$/;

/** Whole blocks light does not go through. Everything else lets it by. */
const LIT_THROUGH = /(_button|_carpet|_banner|torch|poppy|dandelion|cornflower|azure_bluet|oxeye_daisy|allium|fern|grass$|_sapling|_pressure_plate|_sign|ladder|_door|_trapdoor|_fence|_wall$|iron_bars|glass|glass_pane|leaves|water|lava|scaffolding|_slab|_stairs|anvil|cauldron|_bed|_head|lantern|vine|lectern)$/;
/** Blocks that take more of the light than air: leaves and water. */
const DIMMING = /(leaves|water)$/;
/** What gives light, and how much. */
const LIGHT: Readonly<Record<string, number>> = {
    "minecraft:sea_lantern": 15,
    "minecraft:glowstone": 15,
    "minecraft:lava": 15,
    "minecraft:jack_o_lantern": 15,
    "minecraft:lantern": 15,
    "minecraft:torch": 14,
    "minecraft:wall_torch": 14
};

export const bare = (block: string): string => block.replace(/\[.*$/, "");

/** A panel's cell: shut it is its block, open it is air (`wall`) or a ladder
 *  (`floor`) - what the events data pack sets (`secret-panels.ts`). */
export interface PanelCell {
    readonly shape: "wall" | "floor";
}

export interface Merged {
    readonly block: string;
    readonly x1: number;
    readonly l1: number;
    readonly z1: number;
    readonly x2: number;
    readonly l2: number;
    readonly z2: number;
}

/** The inside of a house `size` across, outer walls included. */
export class Grid {
    readonly size: number;
    private readonly cells: (string | null)[];
    readonly panels = new Map<number, PanelCell>();
    static readonly LEVELS = ROOF - DEEP;

    constructor(size: number) {
        this.size = size;
        this.cells = new Array(size * size * Grid.LEVELS).fill(null);
    }

    index(x: number, level: number, z: number): number {
        return ((level - DEEP) * this.size + x) * this.size + z;
    }

    inside(x: number, level: number, z: number): boolean {
        return x >= 0 && z >= 0 && x < this.size && z < this.size && level >= DEEP && level < ROOF;
    }

    get(x: number, level: number, z: number): string | null {
        return this.inside(x, level, z) ? this.cells[this.index(x, level, z)]! : "minecraft:stone";
    }

    /** Whether nothing was set there yet: reserved air counts as set. */
    free(x: number, level: number, z: number): boolean {
        return this.inside(x, level, z) && this.cells[this.index(x, level, z)] === null;
    }

    /** Sets a box, never over a block already set: what is set first wins. */
    set(block: string, x1: number, l1: number, z1: number, x2 = x1, l2 = l1, z2 = z1): void {
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1)
            for (let level = Math.min(l1, l2); level <= Math.max(l1, l2); level += 1)
                for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += 1)
                    if (this.free(x, level, z)) this.cells[this.index(x, level, z)] = block;
    }

    /** Reserves a box as air: nothing set later fills it. */
    clear(x1: number, l1: number, z1: number, x2 = x1, l2 = l1, z2 = z1): void {
        this.set("", x1, l1, z1, x2, l2, z2);
    }

    /** Marks a set cell as a panel the data pack opens and shuts. */
    panel(x: number, level: number, z: number, shape: PanelCell["shape"]): void {
        if (this.inside(x, level, z)) this.panels.set(this.index(x, level, z), { shape });
    }

    panelAt(x: number, level: number, z: number): PanelCell | null {
        return this.inside(x, level, z) ? (this.panels.get(this.index(x, level, z)) ?? null) : null;
    }

    cell(x: number, level: number, z: number): Cell {
        const block = this.get(x, level, z);
        if (!block) return "air";
        const id = bare(block);
        const known = CELL_OF[id];
        if (known) return known;
        return NO_COLLISION.test(id) ? "air" : "solid";
    }

    /** Light: what it gives, and what it costs going through. */
    emits(x: number, level: number, z: number): number {
        const block = this.get(x, level, z);
        return block ? (LIGHT[bare(block)] ?? 0) : 0;
    }

    /** How much light is lost going into a block, or null where it stops. */
    lightCost(x: number, level: number, z: number): number | null {
        if (!this.inside(x, level, z)) return null;
        const block = this.get(x, level, z);
        if (!block) return 1;
        const id = bare(block);
        if (this.panelAt(x, level, z)) return null;
        if (!LIT_THROUGH.test(id) && !(id in CELL_OF && CELL_OF[id] !== "solid")) return null;
        return DIMMING.test(id) ? 2 : 1;
    }

    /** Every block that is built, merged into as few boxes as it takes, by kind. */
    boxes(): Merged[] {
        const out: Merged[] = [];
        const done = new Uint8Array(this.cells.length);
        const same = (block: string, x: number, level: number, z: number) =>
            this.inside(x, level, z) &&
            !done[this.index(x, level, z)] &&
            this.cells[this.index(x, level, z)] === block;
        for (let level = DEEP; level < ROOF; level += 1)
            for (let z = 0; z < this.size; z += 1)
                for (let x = 0; x < this.size; x += 1) {
                    const block = this.cells[this.index(x, level, z)];
                    if (!block || block.startsWith("~") || done[this.index(x, level, z)]) continue;
                    let x2 = x;
                    while (same(block, x2 + 1, level, z)) x2 += 1;
                    const row = (zz: number, ll: number) => {
                        for (let xx = x; xx <= x2; xx += 1)
                            if (!same(block, xx, ll, zz)) return false;
                        return true;
                    };
                    let z2 = z;
                    while (row(z2 + 1, level)) z2 += 1;
                    const slab = (ll: number) => {
                        for (let zz = z; zz <= z2; zz += 1) if (!row(zz, ll)) return false;
                        return true;
                    };
                    let l2 = level;
                    while (l2 + 1 < ROOF && slab(l2 + 1)) l2 += 1;
                    for (let ll = level; ll <= l2; ll += 1)
                        for (let zz = z; zz <= z2; zz += 1)
                            for (let xx = x; xx <= x2; xx += 1) done[this.index(xx, ll, zz)] = 1;
                    out.push({ block, x1: x, l1: level, z1: z, x2, l2, z2 });
                }
        return out;
    }
}

/** Who is walking: a hider walks through lava (their fire resistance), a
 *  seeker is sent back from it. */
export type Walker = "hider" | "seeker";

/** How a player moves through one house. */
export function moves(grid: Grid, walker: Walker) {
    const at = (x: number, level: number, z: number) => grid.cell(x, level, z);
    const fluid = (x: number, level: number, z: number) => {
        const cell = at(x, level, z);
        return cell === "water" || (cell === "lava" && walker === "hider");
    };
    /** Room for a body: anything with no collision, or that opens. */
    const open = (x: number, level: number, z: number) => {
        if (!grid.inside(x, level, z)) return false;
        if (grid.panelAt(x, level, z)) return true;
        const cell = at(x, level, z);
        return (
            cell === "air" ||
            cell === "climb" ||
            cell === "door" ||
            cell === "hatch" ||
            cell === "water" ||
            cell === "snow" ||
            (cell === "lava" && walker === "hider")
        );
    };
    /** A hatch, or a floor panel, over a ladder climbs like the ladder. */
    const climb = (x: number, level: number, z: number) => {
        const cell = at(x, level, z);
        if (cell === "climb") return true;
        if (cell === "hatch" || grid.panelAt(x, level, z)?.shape === "floor")
            return at(x, level - 1, z) === "climb";
        return false;
    };
    /** Something to stand on: whole, or a shut hatch or panel. */
    const floor = (x: number, level: number, z: number) => {
        const cell = at(x, level, z);
        return cell === "solid" || cell === "hatch" || Boolean(grid.panelAt(x, level, z));
    };
    const fits = (x: number, feet: number, z: number) =>
        open(x, feet, z) && open(x, feet + 1, z);
    const held = (x: number, feet: number, z: number) =>
        fits(x, feet, z) &&
        (floor(x, feet - 1, z) || climb(x, feet, z) || fluid(x, feet, z)) &&
        at(x, feet, z) !== "snow";
    /** Where a body put at `feet` comes to rest: down three at most, or into
     *  water from any height; null where it would fall further. */
    const land = (x: number, feet: number, z: number): number | null => {
        for (let level = feet; level > DEEP; level -= 1) {
            if (!open(x, level, z)) return null;
            if (held(x, level, z)) return feet - level <= 3 || fluid(x, level, z) ? level : null;
        }
        return null;
    };
    return { at, open, fits, held, land, climb, fluid, floor };
}

/**
 * Every place a walker reaches from `start` the way a player moves: level, a
 * block up with room to jump it, down three at most (or into water), up and
 * down ladders and scaffolding, swimming, through doors, hatches and panels
 * (anyone can open them), down through powder snow and never up it. Answers
 * how many moves each place took, -1 where it was never reached.
 */
export function walk(
    grid: Grid,
    start: { x: number; feet: number; z: number },
    walker: Walker
): Int32Array {
    const m = moves(grid, walker);
    const steps = new Int32Array(grid.size * grid.size * Grid.LEVELS).fill(-1);
    const queue: number[] = [];
    const visit = (x: number, feet: number, z: number, from: number) => {
        if (!grid.inside(x, feet, z)) return;
        const index = grid.index(x, feet, z);
        if (steps[index]! >= 0) return;
        steps[index] = from + 1;
        queue.push(x, feet, z);
    };
    visit(start.x, start.feet, start.z, -1);
    for (let head = 0; head < queue.length; head += 3) {
        const x = queue[head]!;
        const feet = queue[head + 1]!;
        const z = queue[head + 2]!;
        const here = steps[grid.index(x, feet, z)]!;
        const swims = m.fluid(x, feet, z);
        const climbs = m.climb(x, feet, z);
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            const nx = x + dx;
            const nz = z + dz;
            if (m.fits(nx, feet, nz)) {
                const rest = m.land(nx, feet, nz);
                if (rest !== null) visit(nx, rest, nz, here);
            }
            if (m.fits(nx, feet + 1, nz) && m.open(x, feet + 2, z) && m.at(nx, feet + 1, nz) !== "snow") {
                const rest = m.land(nx, feet + 1, nz);
                if (rest !== null) visit(nx, rest, nz, here);
            }
        }
        if ((swims || climbs) && m.held(x, feet + 1, z)) visit(x, feet + 1, z, here);
        // Down: off a ladder, in water, or through what opens in the floor.
        const under = feet - 1;
        if (
            m.fits(x, under, z) &&
            (climbs ||
                swims ||
                m.at(x, under, z) === "hatch" ||
                m.at(x, under, z) === "snow" ||
                grid.panelAt(x, under, z)?.shape === "floor")
        ) {
            const rest = m.land(x, under, z);
            if (rest !== null) visit(x, rest, z, here);
        }
    }
    return steps;
}

/** The block light each place gets, as the game spreads it: a level less a
 *  block, two through leaves and water, none through anything whole. */
export function lightOf(grid: Grid): Uint8Array {
    const light = new Uint8Array(grid.size * grid.size * Grid.LEVELS);
    const queue: number[] = [];
    for (let level = DEEP; level < ROOF; level += 1)
        for (let x = 0; x < grid.size; x += 1)
            for (let z = 0; z < grid.size; z += 1) {
                const emits = grid.emits(x, level, z);
                if (emits > 0) {
                    light[grid.index(x, level, z)] = emits;
                    queue.push(x, level, z);
                }
            }
    for (let head = 0; head < queue.length; head += 3) {
        const x = queue[head]!;
        const level = queue[head + 1]!;
        const z = queue[head + 2]!;
        const here = light[grid.index(x, level, z)]!;
        for (const [dx, dl, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1]
        ] as const) {
            const nx = x + dx;
            const nl = level + dl;
            const nz = z + dz;
            const cost = grid.lightCost(nx, nl, nz);
            if (cost === null || here - cost <= 0) continue;
            const index = grid.index(nx, nl, nz);
            if (light[index]! >= here - cost) continue;
            light[index] = here - cost;
            queue.push(nx, nl, nz);
        }
    }
    return light;
}

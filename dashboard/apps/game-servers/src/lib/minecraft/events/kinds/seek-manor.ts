/**
 * Hide and seek's manor: the house from design 4 on (`hide-and-seek.ts` keeps
 * designs 2 and 3, so a run built by one still plays in its own).
 *
 * A square of rooms - three by three for up to eight players, four by four for
 * up to sixteen, five by five beyond, or the size the event asks for - each
 * 14 by 14 and ten high, every wall between them and round them four blocks
 * thick: a face, two of core, a face. The rooms are joined by doorways two
 * wide through the walls, along a spanning tree of the grid of rooms (a random
 * depth-first walk) with a few more doorways for loops, so every room is
 * reached and there is more than one way round. Each room is a template from
 * the library (`seek-rooms.ts`), turned and mirrored, drawn from the run's id;
 * the middle one is the foyer with the seekers' cage.
 *
 * Nothing gives a hiding place away by its size. Every wall is four thick
 * whether it is solid or hides a nook in its core; every nook opens through
 * the wall's own face - a painting hung over a gap held up by banners, a panel
 * of the face's own blocks a key opens, a door, a waterfall, or (from 1.19.4)
 * a face that is only a picture of one - and the same paintings and doors hang
 * on solid wall elsewhere. Nooks run four to seven blocks along the wall, three
 * high or two storeys of three with a ladder between them.
 *
 * A panel's keys stand well away from it, in the same room, among the
 * furniture (`holdTicks`): a button, a rug to crouch on, a tile to look up
 * from, a head to stare at (`secret-panels.ts`). It stays open long enough to
 * walk from the key to it, worked out from the walk itself.
 *
 * A house is checked before it is used (`manorProblems`): every place a hider
 * can get to a seeker can too (lava aside, which a seeker is sent back from),
 * every floor and every hiding place reached, every key far enough from its
 * panel and its panel open long enough for the walk, no lava within reach of
 * anything that burns, the cage and the hiders' ring clear, and nowhere to
 * stand dark enough for a monster. A house that breaks a rule is drawn again;
 * after `DRAWS` tries the rooms are left plain, which keeps every rule.
 *
 * Pure.
 */

import type { Box } from "../state";
import type { HOUSE_SIZES } from "../catalog";
import type { Spot } from "./arena";
import * as rooms from "./seek-rooms";
import type { Fill } from "./arena-game";
import * as panels from "./secret-panels";
import { seeded, shuffled } from "../trivia-bank";
import * as model from "./seek-grid";

/** The layout's version, written into the run when it is built. */
export const DESIGN = 4;
/** The most who can play, in the largest house. */
export const MOST = 24;
/** Times a house is drawn again before its rooms are left plain. */
const DRAWS = 12;
/** How far a key stands from its panel at the least, in blocks. */
export const KEY_DISTANCE = 6;
/** Blocks a second a player walks (4.317), and the margin a door is held
 *  open past the walk to it. */
const WALK_SPEED = 4.317;
const MARGIN_TICKS = 60;
/** The least a panel is held open, and the most. */
export const HOLD_MIN = 70;
const HOLD_MAX = 600;
/** How long an inside button holds its panel: it is right beside it. */
const INSIDE_HOLD = 60;

/** The house sizes the event's options offer (`catalog.HOUSE_SIZES`). */
export type HouseSize = (typeof HOUSE_SIZES)[number];

/** Rooms along a side: by the size asked for, or by how many play. */
export function roomsFor(players: number, size: HouseSize = "auto"): number {
    if (size === "small") return 3;
    if (size === "medium") return 4;
    if (size === "large") return 5;
    return players <= 8 ? 3 : players <= 16 ? 4 : 5;
}

/** A house's width, walls included: 58, 76 or 94. */
export function sizeOf(count: number): number {
    return count * model.ROOM + (count + 1) * model.WALL;
}

export function reachOf(count: number): number {
    return Math.ceil(sizeOf(count) / 2);
}

/** Its box over the ground: the barrier under it, the roof on top. */
export function hallBox(center: { x: number; z: number }, floorY: number, count: number): Box {
    const size = sizeOf(count);
    const half = Math.floor(size / 2);
    return {
        x1: center.x - half,
        y1: floorY,
        z1: center.z - half,
        x2: center.x - half + size - 1,
        y2: floorY + model.BASE + model.ROOF,
        z2: center.z - half + size - 1
    };
}

/** Rooms along a side of a house built in `box`. */
export function countOf(box: Box): number {
    return Math.round((box.x2 - box.x1 + 1 - model.WALL) / (model.ROOM + model.WALL));
}

// ------------------------------------------------------------------ the plan

type Side = rooms.Side;
const OUTER = "minecraft:stone_bricks";
const CORE = "minecraft:stone";
const FOUNDATION = "minecraft:stone";
const LAMP = "minecraft:sea_lantern";
const BARRIER = "minecraft:barrier";
const ROOF_BLOCK = "minecraft:dark_oak_planks";
const BOARDS = "minecraft:spruce_planks";
const BANNER = "minecraft:white_wall_banner";
const PAINTINGS = ["minecraft:wanderer", "minecraft:graham"] as const;

/** A secret panel: its lower block, in the house's own terms. */
export interface Panel {
    readonly id: number;
    readonly x: number;
    readonly level: number;
    readonly z: number;
    readonly shape: "wall" | "floor";
    readonly material: panels.Material;
    readonly facing?: Side;
    /** Where somebody stands in front of it, to go through. */
    readonly front: { readonly x: number; readonly feet: number; readonly z: number };
    readonly room: number;
}

export interface Key {
    readonly id: number;
    readonly kind: panels.KeyKind;
    readonly x: number;
    readonly level: number;
    readonly z: number;
    readonly from: { readonly x: number; readonly z: number };
    /** Ticks its panel stays open. */
    readonly hold: number;
    readonly inside: boolean;
}

export interface Painting {
    readonly x: number;
    readonly level: number;
    readonly z: number;
    readonly facing: Side;
    readonly variant: string;
    /** Over a gap in the wall, or on solid wall. */
    readonly door: boolean;
}

export interface Shown {
    readonly x: number;
    readonly level: number;
    readonly z: number;
    readonly block: string;
}

export interface RoomPlan {
    readonly template: string;
    readonly i: number;
    readonly j: number;
    readonly turn: number;
    readonly mirror: boolean;
}

export interface Link {
    readonly a: number;
    readonly b: number;
    readonly at: number;
}

export interface Manor {
    readonly design: number;
    readonly count: number;
    readonly size: number;
    readonly era: model.Era;
    readonly rooms: readonly RoomPlan[];
    readonly links: readonly Link[];
    readonly grid: model.Grid;
    readonly panels: readonly Panel[];
    readonly keys: readonly Key[];
    readonly paintings: readonly Painting[];
    readonly shown: readonly Shown[];
    /** A place to stand in each hiding place, by room. */
    readonly spots: readonly {
        readonly room: number;
        readonly x: number;
        readonly feet: number;
        readonly z: number;
    }[];
    /** Nooks in the walls, by how they open. */
    readonly nooks: readonly {
        readonly room: number;
        readonly entrance: rooms.Entrance;
        readonly tall: boolean;
        readonly length: number;
    }[];
    /** The middle of the cage. */
    readonly middle: { readonly x: number; readonly z: number };
    readonly bare: boolean;
}

const origin = (index: number) => model.WALL + index * (model.ROOM + model.WALL);

/** The way a world side steps. */
const STEP = rooms.STEP;
const SIDE_OF = (dx: number, dz: number): Side =>
    dx === 1 ? "east" : dx === -1 ? "west" : dz === 1 ? "south" : "north";

/** A room's local terms in the house's: turned `turn` quarters clockwise after
 *  a mirror across its width. */
function placer(i: number, j: number, turn: number, mirror: boolean) {
    const x0 = origin(i);
    const z0 = origin(j);
    const L = rooms.LAST;
    const local = (u: number, v: number): [number, number] => {
        const a = mirror ? L - u : u;
        switch (turn) {
            case 1:
                return [L - v, a];
            case 2:
                return [L - a, L - v];
            case 3:
                return [v, L - a];
            default:
                return [a, v];
        }
    };
    const at = (u: number, v: number) => {
        const [a, b] = local(u, v);
        return { x: x0 + a, z: z0 + b };
    };
    const side = (one: Side): Side => {
        let [du, dv] = STEP[one];
        if (mirror) du = -du;
        for (let quarter = 0; quarter < turn; quarter += 1) [du, dv] = [-dv, du];
        return SIDE_OF(du, dv);
    };
    const block = (state: string): string => {
        let out = state.replace(
            /facing=(north|south|east|west)/,
            (_, way: Side) => `facing=${side(way)}`
        );
        if (turn % 2 === 1)
            out = out.replace(
                /axis=(x|z)/,
                (_, axis: string) => `axis=${axis === "x" ? "z" : "x"}`
            );
        if (mirror)
            out = out.replace(
                /hinge=(left|right)/,
                (_, hinge: string) => `hinge=${hinge === "left" ? "right" : "left"}`
            );
        out = out.replace(/rotation=(\d+)/, (_, value: string) => {
            let rotation = Number(value);
            if (mirror) rotation = (16 - rotation) % 16;
            return `rotation=${(rotation + 4 * turn) % 16}`;
        });
        return out;
    };
    return { x0, z0, at, side, block };
}

/** A room's wall on one side: `along` 0..13 the way x or z grows, `depth` 0
 *  the face toward the room to 3 the far face; `in` steps into the room. */
function wallOf(x0: number, z0: number, side: Side) {
    const L = rooms.LAST;
    const cell = (along: number, depth: number) => {
        switch (side) {
            case "north":
                return { x: x0 + along, z: z0 - 1 - depth };
            case "south":
                return { x: x0 + along, z: z0 + L + 1 + depth };
            case "west":
                return { x: x0 - 1 - depth, z: z0 + along };
            default:
                return { x: x0 + L + 1 + depth, z: z0 + along };
        }
    };
    /** The room's cell `depth` in from the wall. */
    const room = (along: number, depth: number) => {
        switch (side) {
            case "north":
                return { x: x0 + along, z: z0 + depth };
            case "south":
                return { x: x0 + along, z: z0 + L - depth };
            case "west":
                return { x: x0 + depth, z: z0 + along };
            default:
                return { x: x0 + L - depth, z: z0 + along };
        }
    };
    /** The way `along` grows, as a side, and the way into the room. */
    const grows: Side = side === "north" || side === "south" ? "east" : "south";
    const inward = rooms.opposite(side);
    return { cell, room, grows, inward };
}

interface Draft {
    grid: model.Grid;
    panels: Panel[];
    hooks: { room: number; hook: rooms.Hook; x: number; z: number; fromX: number; fromZ: number }[];
    insideKeys: { panel: number; x: number; level: number; z: number }[];
    paintings: Painting[];
    shown: Shown[];
    spots: Manor["spots"][number][];
    nooks: Manor["nooks"][number][];
    nextPanel: number;
}

/** The doorways: a random depth-first walk over the grid of rooms, which
 *  reaches every room, and a few more for loops. */
function drawLinks(
    count: number,
    random: () => number,
    pick: (list: readonly number[]) => number
): Link[] {
    const links: Link[] = [];
    const id = (i: number, j: number) => j * count + i;
    const seen = new Set<number>();
    const stack: [number, number][] = [[Math.floor(count / 2), Math.floor(count / 2)]];
    seen.add(id(...stack[0]!));
    const has = (a: number, b: number) =>
        links.some((one) => (one.a === a && one.b === b) || (one.a === b && one.b === a));
    while (stack.length > 0) {
        const [i, j] = stack.at(-1)!;
        const next = (
            [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ] as const
        )
            .map(([di, dj]) => [i + di, j + dj] as [number, number])
            .filter(
                ([ni, nj]) =>
                    ni >= 0 && nj >= 0 && ni < count && nj < count && !seen.has(id(ni, nj))
            );
        if (next.length === 0) {
            stack.pop();
            continue;
        }
        const [ni, nj] = next[Math.floor(random() * next.length)]!;
        seen.add(id(ni, nj));
        links.push({
            a: Math.min(id(i, j), id(ni, nj)),
            b: Math.max(id(i, j), id(ni, nj)),
            at: pick(rooms.SLOTS)
        });
        stack.push([ni, nj]);
    }
    for (let j = 0; j < count; j += 1)
        for (let i = 0; i < count; i += 1)
            for (const [ni, nj] of [
                [i + 1, j],
                [i, j + 1]
            ] as const)
                if (ni < count && nj < count && !has(id(i, j), id(ni, nj)) && random() < 0.3)
                    links.push({ a: id(i, j), b: id(ni, nj), at: pick(rooms.SLOTS) });
    return links;
}

/** The side of room `a` a link to `b` leaves by. */
function linkSide(count: number, a: number, b: number): Side {
    const [ai, aj] = [a % count, Math.floor(a / count)];
    const [bi, bj] = [b % count, Math.floor(b / count)];
    return SIDE_OF(Math.sign(bi - ai), Math.sign(bj - aj));
}

/** One draw of a house, unchecked: what `manorFor` tries in turn. */
export function drawManor(
    seed: string,
    count: number,
    era: model.Era,
    draw: number,
    plain = false
): Manor {
    const random = seeded(`${seed}-manor-${draw}`);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const size = sizeOf(count);
    const grid = new model.Grid(size);
    const middle = { i: Math.floor(count / 2), j: Math.floor(count / 2) };
    const cageRoom = middle.j * count + middle.i;
    const links = drawLinks(count, random, pick);
    const draft: Draft = {
        grid,
        panels: [],
        hooks: [],
        insideKeys: [],
        paintings: [],
        shown: [],
        spots: [],
        nooks: [],
        nextPanel: 1
    };
    const deck: rooms.Template[] = [];
    const usable = rooms.TEMPLATES.filter((one) => !one.fits || one.fits(era));
    const plans: RoomPlan[] = [];
    const templates: rooms.Template[] = [];
    for (let room = 0; room < count * count; room += 1) {
        const i = room % count;
        const j = Math.floor(room / count);
        let template: rooms.Template;
        if (plain) template = rooms.PLAIN;
        else if (room === cageRoom) template = rooms.FOYER;
        else {
            if (deck.length === 0) deck.push(...shuffled(usable, random));
            template = deck.pop()!;
        }
        const fixed = room === cageRoom || plain;
        plans.push({
            template: template.name,
            i,
            j,
            turn: fixed ? 0 : Math.floor(random() * 4),
            mirror: fixed ? false : random() < 0.5
        });
        templates.push(template);
    }
    const doorsOf = (room: number) =>
        links
            .filter((one) => one.a === room || one.b === room)
            .map((one) => ({
                side: linkSide(count, room, one.a === room ? one.b : one.a),
                at: one.at
            }));

    // The doorways first: through the wall, and clear in front on both sides.
    for (const link of links) {
        const side = linkSide(count, link.a, link.b);
        const { x0, z0 } = placer(link.a % count, Math.floor(link.a / count), 0, false);
        const wall = wallOf(x0, z0, side);
        for (const along of [link.at, link.at + 1]) {
            for (let depth = 0; depth < model.WALL; depth += 1) {
                const cell = wall.cell(along, depth);
                grid.clear(cell.x, 1, cell.z, cell.x, 3, cell.z);
            }
            for (let depth = 0; depth < 2; depth += 1) {
                const near = wall.room(along, depth);
                grid.clear(near.x, 1, near.z, near.x, 3, near.z);
                const far = wall.cell(along, model.WALL + depth);
                grid.clear(far.x, 1, far.z, far.x, 3, far.z);
            }
        }
    }

    // The cage and the ring round it the hiders start on.
    const mid = { x: origin(middle.i) + 7, z: origin(middle.j) + 7 };
    grid.clear(mid.x - 1, 1, mid.z - 1, mid.x + 1, 3, mid.z - 1);
    grid.clear(mid.x - 1, 1, mid.z, mid.x + 1, 3, mid.z + 1);
    grid.set(BARRIER, mid.x - 2, 1, mid.z - 2, mid.x + 2, 4, mid.z + 2);
    for (const cell of ringOf(mid)) grid.clear(cell.x, 1, cell.z, cell.x, 2, cell.z);

    // The nooks in each room's walls, then the room itself.
    plans.forEach((plan, room) => {
        const template = templates[room]!;
        if (!plain) nooksOf(draft, plan, template.style, doorsOf(room), room, era, random);
    });
    plans.forEach((plan, room) => {
        const template = templates[room]!;
        const place = placer(plan.i, plan.j, plan.turn, plan.mirror);
        const localDoors = doorsOf(room).map((door) => {
            const local = rooms.SIDES.find((one) => place.side(one) === door.side)!;
            return { side: local, at: door.at };
        });
        template.draw(canvasOf(draft, place, template.style, localDoors, era, random, room));
    });

    // Lamps in every room's floor and ceiling - what stands on the floor's
    // lamps, the ceiling's light from above - then the floor, the foundation,
    // the walls.
    plans.forEach((plan, room) => {
        const place = placer(plan.i, plan.j, 0, false);
        const style = templates[room]!.style;
        for (const [u, v] of [
            [3, 3],
            [3, 10],
            [10, 3],
            [10, 10]
        ] as const) {
            grid.set(LAMP, place.x0 + u, 0, place.z0 + v);
            grid.set(LAMP, place.x0 + u, model.ROOF - 1, place.z0 + v);
        }
        // And over the corners, which furniture can box in.
        for (const u of [1, rooms.LAST - 1])
            for (const v of [1, rooms.LAST - 1])
                grid.set(LAMP, place.x0 + u, model.ROOF - 1, place.z0 + v);
        grid.set(
            style.floor,
            place.x0,
            0,
            place.z0,
            place.x0 + rooms.LAST,
            0,
            place.z0 + rooms.LAST
        );
        // Each room's faces of its walls.
        for (const side of rooms.SIDES) {
            const wall = wallOf(place.x0, place.z0, side);
            const a = wall.cell(0, 0);
            const b = wall.cell(rooms.LAST, 0);
            grid.set(style.face, a.x, 1, a.z, b.x, model.ROOF - 1, b.z);
        }
    });
    grid.set(FOUNDATION, 0, model.DEEP, 0, size - 1, -1, size - 1);
    grid.set(OUTER, 0, 0, 0, size - 1, model.ROOF - 1, 0);
    grid.set(OUTER, 0, 0, size - 1, size - 1, model.ROOF - 1, size - 1);
    grid.set(OUTER, 0, 0, 0, 0, model.ROOF - 1, size - 1);
    grid.set(OUTER, size - 1, 0, 0, size - 1, model.ROOF - 1, size - 1);
    // Whatever is left of the walls is their core.
    for (let index = 0; index <= count; index += 1) {
        const line = index * (model.ROOM + model.WALL);
        grid.set(CORE, line, 0, 0, line + model.WALL - 1, model.ROOF - 1, size - 1);
        grid.set(CORE, 0, 0, line, size - 1, model.ROOF - 1, line + model.WALL - 1);
    }

    // Paintings on solid wall too, the same as the ones over a gap.
    if (!plain) decoyPaintings(draft, plans, random);
    const keys = chooseKeys(draft, random);
    // A panel left with no key is plain wall or floor: nothing opens it.
    for (const panel of draft.panels)
        if (!keys.some((key) => key.id === panel.id && !key.inside))
            for (const level of panel.shape === "wall" ? [1, 2] : [0])
                grid.panels.delete(grid.index(panel.x, level, panel.z));
    return {
        design: DESIGN,
        count,
        size,
        era,
        rooms: plans,
        links,
        grid,
        panels: draft.panels.filter((panel) =>
            keys.some((key) => key.id === panel.id && !key.inside)
        ),
        keys,
        paintings: draft.paintings,
        shown: draft.shown,
        spots: draft.spots,
        nooks: draft.nooks,
        middle: mid,
        bare: plain
    };
}

/** The ring the hiders start on: every cell four from the cage's middle. */
function ringOf(mid: { x: number; z: number }): { x: number; z: number }[] {
    const ring: { x: number; z: number }[] = [];
    for (let x = mid.x - 4; x <= mid.x + 4; x += 1)
        for (let z = mid.z - 4; z <= mid.z + 4; z += 1)
            if (Math.max(Math.abs(x - mid.x), Math.abs(z - mid.z)) === 4) ring.push({ x, z });
    return ring.sort(
        (a, b) => Math.atan2(a.z - mid.z, a.x - mid.x) - Math.atan2(b.z - mid.z, b.x - mid.x)
    );
}

function canvasOf(
    draft: Draft,
    place: ReturnType<typeof placer>,
    style: rooms.Style,
    doors: rooms.Canvas["doors"],
    era: model.Era,
    random: () => number,
    room: number
): rooms.Canvas {
    const { grid } = draft;
    const box = (u1: number, v1: number, u2: number, v2: number) => {
        const a = place.at(u1, v1);
        const b = place.at(u2, v2);
        return {
            x1: Math.min(a.x, b.x),
            z1: Math.min(a.z, b.z),
            x2: Math.max(a.x, b.x),
            z2: Math.max(a.z, b.z)
        };
    };
    const canvas: rooms.Canvas = {
        random,
        era,
        style,
        doors,
        set(block, u1, l1, v1, u2 = u1, l2 = l1, v2 = v1) {
            const b = box(u1, v1, u2, v2);
            grid.set(place.block(block), b.x1, l1, b.z1, b.x2, l2, b.z2);
        },
        clear(u1, l1, v1, u2 = u1, l2 = l1, v2 = v1) {
            const b = box(u1, v1, u2, v2);
            grid.clear(b.x1, l1, b.z1, b.x2, l2, b.z2);
        },
        free(u, level, v) {
            const at = place.at(u, v);
            return grid.free(at.x, level, at.z);
        },
        floorPanel(u, v, facing, inside, bottom = -3) {
            const at = place.at(u, v);
            const material = panels.MATERIALS.find((one) => one === model.bare(style.floor));
            if (!material || !grid.free(at.x, 0, at.z)) return;
            grid.set(material, at.x, 0, at.z);
            grid.panel(at.x, 0, at.z, "floor");
            const world = place.side(facing);
            grid.set(`minecraft:ladder[facing=${world}]`, at.x, bottom, at.z, at.x, -1, at.z);
            const id = draft.nextPanel++;
            draft.panels.push({
                id,
                x: at.x,
                level: 0,
                z: at.z,
                shape: "floor",
                material,
                facing: world,
                front: { x: at.x, feet: 1, z: at.z },
                room
            });
            const button = place.at(inside.u, inside.v);
            canvas.set(
                `minecraft:stone_button[face=wall,facing=${inside.facing},powered=false]`,
                inside.u,
                inside.level,
                inside.v
            );
            draft.insideKeys.push({ panel: id, x: button.x, level: inside.level, z: button.z });
        },
        display(block, u, level, v) {
            if (!era.display) return;
            const at = place.at(u, v);
            draft.shown.push({ x: at.x, level, z: at.z, block: place.block(block) });
        },
        hook(hook) {
            const at = place.at(hook.u, hook.v);
            const from = place.at(hook.from.u, hook.from.v);
            draft.hooks.push({ room, hook, x: at.x, z: at.z, fromX: from.x, fromZ: from.z });
        },
        spot(u, feet, v) {
            const at = place.at(u, v);
            draft.spots.push({ room, x: at.x, feet, z: at.z });
        }
    };
    return canvas;
}

/** A room's nooks: one or two, in stretches of its walls clear of doorways. */
function nooksOf(
    draft: Draft,
    plan: RoomPlan,
    style: rooms.Style,
    doors: readonly { side: Side; at: number }[],
    room: number,
    era: model.Era,
    random: () => number
): void {
    const { grid } = draft;
    const x0 = origin(plan.i);
    const z0 = origin(plan.j);
    const wanted = 1 + (random() < 0.6 ? 1 : 0);
    let made = 0;
    const entrances = style.entrances.filter((one) => one !== "veil" || era.display);
    for (const side of shuffled(rooms.SIDES, random)) {
        if (made >= wanted) break;
        const wall = wallOf(x0, z0, side);
        const blocked = (along: number) =>
            doors.some(
                (door) => door.side === side && along >= door.at - 2 && along <= door.at + 3
            );
        // The longest stretch free of doorways, a block in from the corners.
        const free: number[] = [];
        for (let along = 1; along <= rooms.LAST - 1; along += 1)
            if (!blocked(along)) free.push(along);
        const runs: [number, number][] = [];
        for (const along of free) {
            const last = runs.at(-1);
            if (last && last[1] === along - 1) last[1] = along;
            else runs.push([along, along]);
        }
        const run = runs
            .filter(([a, b]) => b - a + 1 >= 4)
            .sort((p, q) => q[1] - q[0] - (p[1] - p[0]))[0];
        if (!run) continue;
        const length = Math.min(run[1] - run[0] + 1, 4 + Math.floor(random() * 4));
        const start = run[0] + Math.floor(random() * (run[1] - run[0] + 2 - length));
        const end = start + length - 1;
        // Not where another room's nook already took this wall's core, nor
        // behind a door the room on the other side hung in its own face: what
        // the nook hangs on its far face - a ladder, the button out - would
        // hang on that door, and the door would open into the nook.
        let taken = false;
        for (let along = start - 1; along <= end + 1; along += 1) {
            for (const depth of [1, 2]) {
                const cell = wall.cell(along, depth);
                if (!grid.free(cell.x, 1, cell.z)) taken = true;
            }
            const far = wall.cell(along, model.WALL - 1);
            if (!grid.free(far.x, 1, far.z) || !grid.free(far.x, 2, far.z)) taken = true;
        }
        if (taken) continue;
        let entrance =
            entrances[Math.floor(random() * Math.min(entrances.length, 2))] ?? "painting";
        if (entrance === "falls" && length < 5)
            entrance = entrances.find((one) => one !== "falls") ?? "painting";
        const tall = entrance !== "falls" && random() < 0.5;
        const at =
            entrance === "falls" ? start + 2 : start + 1 + Math.floor(random() * (length - 2));
        carveNook(draft, wall, { start, end, at, tall, entrance, style, room, random });
        made += 1;
    }
    // Doors on solid wall too, in a room whose nooks open with doors.
    if (style.entrances.includes("door"))
        for (const side of shuffled(rooms.SIDES, random).slice(0, 2)) {
            const wall = wallOf(x0, z0, side);
            const along = 2 + Math.floor(random() * 10);
            const near = [along - 1, along, along + 1];
            if (
                near.some((one) =>
                    doors.some(
                        (door) => door.side === side && one >= door.at - 1 && one <= door.at + 2
                    )
                )
            )
                continue;
            const cell = wall.cell(along, 0);
            const front = wall.room(along, 0);
            if (!grid.free(front.x, 1, front.z)) continue;
            // Solid wall all the way through, and beside it: not into a nook
            // behind, and not where a nook's banner or the other room's ladder
            // or button hangs on the face it would take.
            if (
                near.some((one) =>
                    [0, 1, 2, model.WALL - 1].some((depth) => {
                        const at = wall.cell(one, depth);
                        return !grid.free(at.x, 1, at.z) || !grid.free(at.x, 2, at.z);
                    })
                )
            )
                continue;
            setDoor(grid, cell, wall.inward);
            grid.clear(front.x, 1, front.z, front.x, 2, front.z);
        }
}

function setDoor(grid: model.Grid, cell: { x: number; z: number }, facing: Side): void {
    grid.set(
        `minecraft:oak_door[facing=${facing},half=lower,hinge=left,open=false]`,
        cell.x,
        1,
        cell.z
    );
    grid.set(
        `minecraft:oak_door[facing=${facing},half=upper,hinge=left,open=false]`,
        cell.x,
        2,
        cell.z
    );
}

/** A nook in a wall's core from `start` to `end`, opening at `at`. */
function carveNook(
    draft: Draft,
    wall: ReturnType<typeof wallOf>,
    nook: {
        start: number;
        end: number;
        at: number;
        tall: boolean;
        entrance: rooms.Entrance;
        style: rooms.Style;
        room: number;
        random: () => number;
    }
): void {
    const { grid } = draft;
    const { start, end, at, tall, entrance, style, room } = nook;
    const cell = wall.cell;
    const door = cell(at, 0);
    const front = wall.room(at, 0);
    const top = tall ? 7 : 3;
    // What hangs inside, before the core is cleared round it.
    const mid = Math.floor((start + end) / 2);
    const lamp = cell(mid === at ? mid + 1 : mid, 1);
    grid.set(LAMP, lamp.x, 0, lamp.z);
    if (tall) {
        // Boards at level 4, a ladder up the far side at one end, a lamp in them.
        const foot = cell(start, 2);
        grid.set(`minecraft:ladder[facing=${wall.inward}]`, foot.x, 1, foot.z, foot.x, 4, foot.z);
        const light = cell(end, 1);
        grid.set(LAMP, light.x, 4, light.z);
        const a = cell(start, 1);
        const b = cell(end, 2);
        grid.set(BOARDS, a.x, 4, a.z, b.x, 4, b.z);
        const upper = cell(end, 2);
        draft.spots.push({ room, x: upper.x, feet: 5, z: upper.z });
    }
    switch (entrance) {
        case "painting": {
            grid.set(`${BANNER}[facing=${wall.grows}]`, door.x, 1, door.z, door.x, 2, door.z);
            draft.paintings.push({
                x: front.x,
                level: 1,
                z: front.z,
                facing: wall.inward,
                variant: PAINTINGS[Math.floor(nook.random() * PAINTINGS.length)]!,
                door: true
            });
            break;
        }
        case "veil":
            grid.clear(door.x, 1, door.z, door.x, 2, door.z);
            for (const level of [1, 2])
                draft.shown.push({ x: door.x, level, z: door.z, block: style.face });
            break;
        case "door":
            setDoor(grid, door, wall.inward);
            break;
        case "falls": {
            // Three sources in the face at level 5 pour down in front of it
            // into a pool in the floor; the middle of the face behind the falls
            // is open. Falling water never spreads sideways, and every side of
            // a source is stone or the falls themselves.
            for (const along of [at - 1, at, at + 1]) {
                const spout = cell(along, 0);
                grid.set("minecraft:water", spout.x, 5, spout.z);
                const pour = wall.room(along, 0);
                grid.set("~water", pour.x, 1, pour.z, pour.x, 5, pour.z);
                grid.set("minecraft:water", pour.x, 0, pour.z);
            }
            grid.clear(door.x, 1, door.z, door.x, 2, door.z);
            break;
        }
        default: {
            const material = style.face;
            grid.set(material, door.x, 1, door.z, door.x, 2, door.z);
            grid.panel(door.x, 1, door.z, "wall");
            grid.panel(door.x, 2, door.z, "wall");
            const id = draft.nextPanel++;
            draft.panels.push({
                id,
                x: door.x,
                level: 1,
                z: door.z,
                shape: "wall",
                material,
                front: { x: front.x, feet: 1, z: front.z },
                room
            });
            // Out again: a button on the far side of the nook, facing the panel.
            const inside = cell(at, 2);
            grid.set(
                `minecraft:stone_button[face=wall,facing=${wall.inward}]`,
                inside.x,
                2,
                inside.z
            );
            draft.insideKeys.push({ panel: id, x: inside.x, level: 2, z: inside.z });
        }
    }
    if (entrance !== "falls") grid.clear(front.x, 1, front.z, front.x, 2, front.z);
    const a = cell(start, 1);
    const b = cell(end, 2);
    grid.clear(a.x, 1, a.z, b.x, top, b.z);
    const spot = cell(at, 2);
    draft.spots.push({ room, x: spot.x, feet: 1, z: spot.z });
    draft.nooks.push({ room, entrance, tall, length: end - start + 1 });
}

/** One to three paintings on solid wall in each room, like those over a gap. */
function decoyPaintings(draft: Draft, plans: readonly RoomPlan[], random: () => number): void {
    const { grid } = draft;
    const taken = new Set(draft.paintings.map((one) => `${one.x},${one.z}`));
    for (const plan of plans) {
        const x0 = origin(plan.i);
        const z0 = origin(plan.j);
        let hung = 0;
        const wanted = 1 + Math.floor(random() * 3);
        for (let attempt = 0; attempt < 20 && hung < wanted; attempt += 1) {
            const side = rooms.SIDES[Math.floor(random() * 4)]!;
            const wall = wallOf(x0, z0, side);
            const along = 1 + Math.floor(random() * (rooms.LAST - 1));
            const face = wall.cell(along, 0);
            const front = wall.room(along, 0);
            const near = [-1, 0, 1].some((d) => {
                const one = wall.room(along + d, 0);
                return taken.has(`${one.x},${one.z}`);
            });
            if (near) continue;
            if (
                grid.cell(face.x, 1, face.z) !== "solid" ||
                grid.cell(face.x, 2, face.z) !== "solid"
            )
                continue;
            if (grid.panelAt(face.x, 1, face.z) || grid.get(face.x, 1, face.z)?.includes("water"))
                continue;
            if (grid.get(front.x, 1, front.z) || grid.get(front.x, 2, front.z)) continue;
            draft.paintings.push({
                x: front.x,
                level: 1,
                z: front.z,
                facing: wall.inward,
                variant: PAINTINGS[Math.floor(random() * PAINTINGS.length)]!,
                door: false
            });
            taken.add(`${front.x},${front.z}`);
            hung += 1;
        }
    }
}

const KIND_OF: Readonly<Record<rooms.HookKind, panels.KeyKind>> = {
    btn: "btn",
    rug: "crouch",
    tile: "up",
    gaze: "gaze"
};

/** A key for each panel among its room's hooks, far enough from it, and its
 *  button inside; a panel left with no key is turned back into wall. Holds
 *  are filled in once the walk can be measured (`withHolds`). */
function chooseKeys(draft: Draft, random: () => number): Key[] {
    const used = new Set<number>();
    const keys: Key[] = [];
    for (const panel of draft.panels) {
        const choices = draft.hooks
            .map((one, index) => ({ one, index }))
            .filter(
                ({ one, index }) =>
                    !used.has(index) &&
                    one.room === panel.room &&
                    Math.hypot(one.fromX - panel.front.x, one.fromZ - panel.front.z) >= KEY_DISTANCE
            );
        if (choices.length === 0) continue;
        const { one, index } = choices[Math.floor(random() * choices.length)]!;
        used.add(index);
        keys.push({
            id: panel.id,
            kind: KIND_OF[one.hook.kind],
            x: one.x,
            level: one.hook.level,
            z: one.z,
            from: { x: one.fromX, z: one.fromZ },
            hold: HOLD_MIN,
            inside: false
        });
        const inside = draft.insideKeys.find((each) => each.panel === panel.id);
        if (inside)
            keys.push({
                id: panel.id,
                kind: "btn",
                x: inside.x,
                level: inside.level,
                z: inside.z,
                from: { x: inside.x, z: inside.z },
                hold: INSIDE_HOLD,
                inside: true
            });
    }
    return keys;
}

/** Ticks a panel is held open after its key: the walk from the key to the
 *  panel at a walk, and `MARGIN_TICKS` to get in. */
export function holdTicks(steps: number): number {
    return Math.min(
        HOLD_MAX,
        Math.max(HOLD_MIN, Math.ceil((steps * 20) / WALK_SPEED) + MARGIN_TICKS)
    );
}

/** The keys with their holds, measured over the house as built. */
function withHolds(manor: Omit<Manor, "keys">, keys: readonly Key[]): Key[] {
    return keys.map((key) => {
        if (key.inside) return key;
        const panel = manor.panels.find((one) => one.id === key.id);
        if (!panel) return key;
        const steps = model.walk(manor.grid, { x: key.from.x, feet: 1, z: key.from.z }, "seeker");
        const there = steps[manor.grid.index(panel.front.x, panel.front.feet, panel.front.z)]!;
        return there < 0 ? { ...key, hold: -1 } : { ...key, hold: holdTicks(there) };
    });
}

/** A run's house: drawn from the run's id until one keeps every rule. */
export function manorFor(seed: string, count: number, era: model.Era): Manor {
    for (let draw = 0; draw < DRAWS; draw += 1) {
        const drawn = drawManor(seed, count, era, draw);
        const manor = { ...drawn, keys: withHolds(drawn, drawn.keys) };
        if (manorProblems(manor).length === 0) return manor;
    }
    const plain = drawManor(seed, count, era, 0, true);
    return { ...plain, keys: withHolds(plain, plain.keys) };
}

// ------------------------------------------------------------------ the rules

/** Where the hiders start, spread round the ring: as many as can play. */
export function hiderCells(manor: Pick<Manor, "middle">): { x: number; z: number }[] {
    const ring = ringOf(manor.middle);
    const step = ring.length / MOST;
    return Array.from({ length: MOST }, (_, index) => ring[Math.floor(index * step)]!);
}

export function seekerCells(manor: Pick<Manor, "middle">): { x: number; z: number }[] {
    const { x, z } = manor.middle;
    return [
        { x, z },
        { x: x - 1, z },
        { x: x + 1, z }
    ];
}

function inCage(manor: Pick<Manor, "middle">, x: number, z: number): boolean {
    return Math.abs(x - manor.middle.x) <= 2 && Math.abs(z - manor.middle.z) <= 2;
}

/** Blocks that burn: none within reach of lava. */
const BURNS =
    /(planks|_log|leaves|wool|carpet|bookshelf|oak_fence|spruce_fence|hay_block|scaffolding|_stairs|_slab|_banner|tnt|vine)$/;

/**
 * Every rule a house breaks, one line each; empty when it keeps them all.
 */
export function manorProblems(manor: Manor): string[] {
    const problems: string[] = [];
    const { grid } = manor;
    const start = hiderCells(manor)[0]!;
    const seeker = model.walk(grid, { x: start.x, feet: 1, z: start.z }, "seeker");
    const hider = model.walk(grid, { x: start.x, feet: 1, z: start.z }, "hider");
    const seekerMoves = model.moves(grid, "seeker");
    const hiderMoves = model.moves(grid, "hider");
    const light = model.lightOf(grid);
    const unfair: string[] = [];
    const sealed: string[] = [];
    const dark: string[] = [];
    for (let x = 0; x < grid.size; x += 1)
        for (let z = 0; z < grid.size; z += 1)
            for (let feet = model.DEEP + 1; feet < model.ROOF - 1; feet += 1) {
                const index = grid.index(x, feet, z);
                if (inCage(manor, x, z) && feet <= 5) continue;
                // A body with its feet or its head in lava: a seeker there is sent back.
                const inLava =
                    grid.cell(x, feet, z) === "lava" || grid.cell(x, feet + 1, z) === "lava";
                if (hider[index]! >= 0 && seeker[index]! < 0 && !inLava)
                    unfair.push(`${x},${feet},${z}`);
                const stands = seekerMoves.held(x, feet, z) || hiderMoves.held(x, feet, z);
                if (feet <= 1 && seekerMoves.held(x, feet, z) && seeker[index]! < 0)
                    sealed.push(`${x},${feet},${z}`);
                // A panel's own cell is only stood in open, when it is air and lit.
                if (
                    stands &&
                    !grid.panelAt(x, feet, z) &&
                    (hider[index]! >= 0 || seeker[index]! >= 0) &&
                    light[index]! === 0
                )
                    dark.push(`${x},${feet},${z}`);
            }
    if (unfair.length > 0)
        problems.push(
            `${unfair.length} places a hider reaches and a seeker cannot, first ${unfair[0]}`
        );
    if (sealed.length > 0)
        problems.push(`${sealed.length} places to stand cannot be reached, first ${sealed[0]}`);
    if (dark.length > 0)
        problems.push(
            `${dark.length} places to stand are dark enough for monsters, first ${dark[0]}`
        );
    // In and never out again: a drop with no ladder back up, powder snow over a
    // hollow whose panel was never built. Whoever falls in is stuck there for
    // the rest of the game, seeker or hider.
    for (const walker of ["hider", "seeker"] as const) {
        const stuck = model.stranded(grid, { x: start.x, feet: 1, z: start.z }, walker);
        if (stuck.length > 0) {
            const at = grid.place(stuck[0]!);
            problems.push(
                `${stuck.length} places a ${walker} gets into and not out of, first ${at.x},${at.feet},${at.z}`
            );
        }
    }
    for (const spot of manor.spots)
        if (seeker[grid.index(spot.x, spot.feet, spot.z)]! < 0)
            problems.push(`the hiding place at ${spot.x},${spot.feet},${spot.z} cannot be reached`);
    // Somewhere to hide in every room, so the hiders spread over the house.
    if (!manor.bare)
        placesByRoom(manor).forEach((places, room) => {
            if (places === 0) problems.push(`room ${room} has nowhere to hide`);
        });
    for (const cell of hiderCells(manor))
        if (!seekerMoves.held(cell.x, 1, cell.z))
            problems.push(`a hider's start at ${cell.x},${cell.z} is taken`);
    for (const panel of manor.panels) {
        const keys = manor.keys.filter((key) => key.id === panel.id && !key.inside);
        if (keys.length === 0) problems.push(`panel ${panel.id} has no key`);
        if (!manor.keys.some((key) => key.id === panel.id && key.inside))
            problems.push(`panel ${panel.id} has no way out`);
        for (const key of keys) {
            if (Math.hypot(key.from.x - panel.front.x, key.from.z - panel.front.z) < KEY_DISTANCE)
                problems.push(`the key to panel ${panel.id} is beside it`);
            if (key.hold < 0) problems.push(`the key to panel ${panel.id} cannot reach it`);
            if (seeker[grid.index(key.from.x, 1, key.from.z)]! < 0)
                problems.push(`the key to panel ${panel.id} cannot be reached`);
        }
    }
    // Nothing that burns where lava can set it alight: two across and three up.
    for (let x = 0; x < grid.size; x += 1)
        for (let z = 0; z < grid.size; z += 1)
            for (let level = model.DEEP; level < model.ROOF; level += 1) {
                if (grid.cell(x, level, z) !== "lava") continue;
                for (let dx = -3; dx <= 3; dx += 1)
                    for (let dz = -3; dz <= 3; dz += 1)
                        for (let up = 0; up <= 4; up += 1) {
                            const block = grid.get(x + dx, level + up, z + dz);
                            if (block && BURNS.test(model.bare(block)))
                                problems.push(
                                    `${model.bare(block)} at ${x + dx},${level + up},${z + dz} can catch fire from the lava`
                                );
                        }
            }
    return [...new Set(problems)];
}

/** How many hiding places each room has. */
export function placesByRoom(manor: Manor): number[] {
    const counts = new Array<number>(manor.count * manor.count).fill(0);
    for (const spot of manor.spots) counts[spot.room]! += 1;
    return counts;
}

// ------------------------------------------------------------------ into the world

function worldOf(box: Box, x: number, level: number, z: number) {
    return { x: box.x1 + x, y: box.y1 + model.BASE + level, z: box.z1 + z };
}

/** Every kind of block it is built of, as bare ids, in the order it comes
 *  down: the lava and water first, so nothing runs as the rest goes; then what
 *  hangs on something or stands on it - a painting's banners, buttons,
 *  ladders, doors, trapdoors, rugs, flowers, heads, beds, scaffolding - before
 *  what holds it up. */
export function manorBlocks(manor: Manor): string[] {
    const ids = new Set<string>([BARRIER, ROOF_BLOCK]);
    for (const part of manor.grid.boxes()) ids.add(model.bare(part.block));
    // Water that reaches lava turns it to stone, cobblestone or obsidian: a
    // house with both takes those down too.
    if (ids.has("minecraft:water") && ids.has("minecraft:lava"))
        for (const id of ["minecraft:obsidian", "minecraft:cobblestone", "minecraft:stone"])
            ids.add(id);
    const first = (id: string) =>
        /lava|water/.test(id)
            ? 0
            : /powder_snow/.test(id)
              ? 1
              : /(_button|ladder|_banner|_door|_trapdoor|_carpet|poppy|dandelion|cornflower|azure_bluet|_skull|_bed|scaffolding|torch)$/.test(
                      id
                  )
                ? 2
                : 3;
    return [...ids].sort((a, b) => first(a) - first(b));
}

/**
 * What it is built of, each only into air: the barrier under it all and the
 * roof, then everything in the model - what hangs on something before what
 * holds it, which is how a server keeps it, the floor after the rest, the
 * water and lava after the stone round them so nothing runs - and last a
 * block of floor already there, the probe that proves the blocks stayed.
 *
 * Scaffolding is the exception to "what hangs before what holds": it checks
 * its own support a tick after it is placed, not when something next to it
 * changes, and scaffolding with nothing under it breaks and drops itself as an
 * item. Put down before the floor, every tower came apart into scaffolding in
 * the hiders' hands - which they cannot place - and left no way up. So it comes
 * after the solid blocks, standing on a floor that is already there.
 */
export function manorFills(box: Box, manor: Manor): Fill[] {
    const fills: Fill[] = [
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        { box: { ...box, y1: box.y2 }, block: ROOF_BLOCK }
    ];
    const order = (block: string) => {
        const id = model.bare(block);
        if (/lava|water/.test(id)) return 3;
        if (/scaffolding$/.test(id)) return 2;
        if (/(_button|ladder|_banner|_door|_trapdoor)$/.test(id)) return 0;
        return 1;
    };
    const parts = manor.grid.boxes().sort((a, b) => order(a.block) - order(b.block));
    for (const part of parts) {
        const a = worldOf(box, part.x1, part.l1, part.z1);
        const b = worldOf(box, part.x2, part.l2, part.z2);
        fills.push({
            box: { x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z },
            block: part.block
        });
    }
    const probe = worldOf(box, model.WALL, 0, model.WALL);
    const floor = manor.grid.get(model.WALL, 0, model.WALL) ?? OUTER;
    fills.push({
        box: { x1: probe.x, y1: probe.y, z1: probe.z, x2: probe.x, y2: probe.y, z2: probe.z },
        block: floor
    });
    return fills;
}

const FACING_BYTE: Readonly<Record<Side, number>> = { south: 0, west: 1, north: 2, east: 3 };

/**
 * What the house shows that is not a block, once it is built: its paintings
 * - written with both spellings of their facing and canvas, since 1.19 and
 * 1.21 renamed them and every release ignores the one it does not read, and
 * unbreakable, since a seeker swinging at a hider must not knock one off -
 * and, from 1.19.4, its display blocks.
 */
export function decorLines(box: Box, manor: Manor): string[] {
    const lines: string[] = [];
    for (const one of manor.paintings) {
        const at = worldOf(box, one.x, one.level, one.z);
        const facing = FACING_BYTE[one.facing];
        lines.push(
            `execute in minecraft:overworld run summon minecraft:painting ${at.x + 0.5} ${at.y + 0.5} ${at.z + 0.5} {Facing:${facing}b,facing:${facing}b,Motive:"${one.variant}",variant:"${one.variant}",Invulnerable:1b,Tags:["${panels.DECOR}"]}`
        );
    }
    if (manor.era.display)
        for (const one of manor.shown) {
            const at = worldOf(box, one.x, one.level, one.z);
            const [name, state] = [model.bare(one.block), /\[(.*)\]$/.exec(one.block)?.[1]];
            const properties = state
                ? `,Properties:{${state
                      .split(",")
                      .map((pair) => pair.split("="))
                      .map(([key, value]) => `${key}:"${value}"`)
                      .join(",")}}`
                : "";
            lines.push(
                `execute in minecraft:overworld run summon minecraft:block_display ${at.x} ${at.y} ${at.z} {block_state:{Name:"${name}"${properties}},Tags:["${panels.DECOR}"]}`
            );
        }
    return lines;
}

/** A number for this run's panels no other house near it shares. */
function idBase(seed: string): number {
    let hash = 0;
    for (const char of seed) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
    return ((Math.abs(hash) % 9000) + 1000) * 100;
}

/** The panels and keys put to work at "Go!", and the seekers' way home. */
export function armLines(box: Box, manor: Manor, seed: string): string[] {
    const base = idBase(seed);
    const home = worldOf(box, manor.middle.x, 1, manor.middle.z + 3);
    return panels.armLines(
        box,
        manor.panels.map((panel) => ({
            ...worldOf(box, panel.x, panel.level, panel.z),
            id: base + panel.id,
            shape: panel.shape,
            material: panel.material,
            facing: panel.facing
        })),
        manor.keys.map((key) => ({
            ...worldOf(box, key.x, key.level, key.z),
            id: base + key.id,
            kind: key.kind,
            hold: key.hold
        })),
        home
    );
}

/** Where the pack is not on to work them: every panel left open at "Go!",
 *  a wall's to air and a floor's to the ladder that goes on down, still a
 *  way in. */
export function openLines(box: Box, manor: Manor): string[] {
    return manor.panels.flatMap((panel) => {
        const at = worldOf(box, panel.x, panel.level, panel.z);
        const set = (y: number, block: string) =>
            `execute in minecraft:overworld if block ${at.x} ${y} ${at.z} ${panel.material} run setblock ${at.x} ${y} ${at.z} ${block}`;
        return panel.shape === "wall"
            ? [set(at.y, "minecraft:air"), set(at.y + 1, "minecraft:air")]
            : [set(at.y, `minecraft:ladder[facing=${panel.facing ?? "north"}]`)];
    });
}

export function cageBox(box: Box, manor: Manor): Box {
    const a = worldOf(box, manor.middle.x - 2, 1, manor.middle.z - 2);
    const b = worldOf(box, manor.middle.x + 2, 4, manor.middle.z + 2);
    return { x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z };
}

export function cageDown(box: Box, manor: Manor): string {
    const cage = cageBox(box, manor);
    return `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace ${BARRIER}`;
}

export function hiderSpot(box: Box, manor: Manor, index: number): Spot {
    const cell = hiderCells(manor)[index % MOST]!;
    const at = worldOf(box, cell.x, 1, cell.z);
    return {
        ...at,
        yaw: Math.round(
            (-Math.atan2(cell.x - manor.middle.x, cell.z - manor.middle.z) * 180) / Math.PI
        )
    };
}

export function seekerSpot(box: Box, manor: Manor, index: number): Spot {
    const cells = seekerCells(manor);
    return {
        ...worldOf(box, cells[index % cells.length]!.x, 1, cells[index % cells.length]!.z),
        yaw: 0
    };
}

/** Before the house comes down: the markers, paintings and display blocks
 *  gone, and the lava and water taken out while its walls still stand round
 *  them. Safe on any house, or none. */
export function closeLines(box: Box): string[] {
    const region = `${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2}`;
    const volume = (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1);
    const fluids = volume <= 32_768 ? [region] : sliceRegions(box);
    return [
        ...panels.stopLines(box),
        panels.decorOff(box),
        ...["minecraft:lava", "minecraft:water"].flatMap((fluid) =>
            fluids.map(
                (one) =>
                    `execute in minecraft:overworld run fill ${one} minecraft:air replace ${fluid}`
            )
        )
    ];
}

/** A box's layers, each small enough for one fill. */
function sliceRegions(box: Box): string[] {
    const out: string[] = [];
    const layer = (box.x2 - box.x1 + 1) * (box.z2 - box.z1 + 1);
    const strip = Math.max(1, Math.floor(32_768 / (box.z2 - box.z1 + 1)));
    for (let y = box.y1; y <= box.y2; y += 1) {
        if (layer <= 32_768) {
            out.push(`${box.x1} ${y} ${box.z1} ${box.x2} ${y} ${box.z2}`);
            continue;
        }
        for (let x = box.x1; x <= box.x2; x += strip)
            out.push(`${x} ${y} ${box.z1} ${Math.min(box.x2, x + strip - 1)} ${y} ${box.z2}`);
    }
    return out;
}

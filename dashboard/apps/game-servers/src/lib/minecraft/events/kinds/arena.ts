/**
 * The pieces the events played in an arena by sides - a team duel, a build
 * battle - are built from: `join` read out of the chat, a box of air proven to
 * be air, filled with the event's own blocks and emptied of only those again,
 * a kit marked so that only it is ever taken back, and each player put back
 * exactly where they stood. Parkour and spleef, which each plays alone, are
 * on a stage of their own (`stage.ts`) under the same guarantees.
 *
 * What they guarantee, between them:
 *
 * - No block that was not air is changed. The box is counted first - the game
 *   compares it with itself, which counts every block in it that is not air -
 *   and only a count of nought is built on, with `fill ... keep` besides.
 * - No block the event did not place is removed. Taking it down is `fill ...
 *   air replace <block>` for each kind of block it used, inside its own box;
 *   and nobody can have put one of those there meanwhile, since everybody in
 *   it plays in adventure mode.
 * - None of anybody's own items is taken. What the event hands out carries a
 *   marker, and only items with the marker are cleared. What somebody drops
 *   while they are there is kept theirs - only they can pick it up, it does
 *   not vanish - and is sent after them when they are put back.
 *
 * Pure, like the rest of the commands.
 */

import { text } from "../commands";
import { fallProof } from "./stage";
import { PLAYER_NAME } from "../catalog";
import { stripFormatting } from "../../parse";
import { GAMEMODES, type Arena, type Box, type Entrant, type Marker } from "../state";

type Gamemode = (typeof GAMEMODES)[number];

const IN_OVERWORLD = "execute in minecraft:overworld run";

// ------------------------------------------------------------------ joining

/** `join` or `unirse`, alone on the line, in either language. */
export function wantsToJoin(said: string): boolean {
    const word = said
        .trim()
        .toLowerCase()
        .replace(/^[!/]/, "")
        .replace(/[.!]+$/, "");
    return word === "join" || word === "unirse";
}

// ------------------------------------------------------------------ the box

/** How far above the ground an arena floats: past any tree, clear of the land. */
export const ALTITUDE = 30;

/** The most blocks one fill, or one comparison, may cover. */
export const VOLUME_MAX = 32_768;

/** The highest block a world has: 319 from 1.18, 255 before. */
export function worldTop(from118: boolean): number {
    return from118 ? 319 : 255;
}

export function volume(box: Box): number {
    return (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1);
}

/** A box cut into pieces no larger than the game takes at once: by layers, and
 *  a layer too big by itself into strips. */
export function slices(box: Box, max = VOLUME_MAX): Box[] {
    if (volume(box) <= max) return [box];
    const width = box.x2 - box.x1 + 1;
    const depth = box.z2 - box.z1 + 1;
    const layer = width * depth;
    const pieces: Box[] = [];
    if (layer <= max) {
        const thick = Math.max(1, Math.floor(max / layer));
        for (let y = box.y1; y <= box.y2; y += thick) {
            pieces.push({ ...box, y1: y, y2: Math.min(box.y2, y + thick - 1) });
        }
        return pieces;
    }
    const strip = Math.max(1, Math.floor(max / depth));
    for (let y = box.y1; y <= box.y2; y += 1) {
        for (let x = box.x1; x <= box.x2; x += strip) {
            pieces.push({ ...box, x1: x, x2: Math.min(box.x2, x + strip - 1), y1: y, y2: y });
        }
    }
    return pieces;
}

export function region(box: Box): string {
    return `${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2}`;
}

/** The same box as a selector's volume, for the entities in it. */
export function within(box: Box): string {
    return `x=${box.x1},y=${box.y1},z=${box.z1},dx=${box.x2 - box.x1},dy=${box.y2 - box.y1},dz=${box.z2 - box.z1}`;
}

export function contains(box: Box, point: { x: number; y: number; z: number }): boolean {
    return (
        point.x >= box.x1 &&
        point.x < box.x2 + 1 &&
        point.y >= box.y1 &&
        point.y < box.y2 + 1 &&
        point.z >= box.z1 &&
        point.z < box.z2 + 1
    );
}

/**
 * How many blocks in a box are anything but air: the box compared with itself
 * in `masked` mode, which skips air and counts every other block, each of which
 * matches itself. `Test passed, count: 0` is a box of nothing but air.
 */
export function solidCount(box: Box): string {
    return `execute in minecraft:overworld if blocks ${region(box)} ${box.x1} ${box.y1} ${box.z1} masked`;
}

/** The count out of that answer; `unloaded` while its chunks are still coming
 *  in, null when the game refused (outside the world, say). */
export function readCount(output: string): number | "unloaded" | null {
    const plain = stripFormatting(output);
    if (/not loaded|unloaded/i.test(plain)) return "unloaded";
    const match = /count:?\s*(\d+)/i.exec(plain);
    return match ? Number(match[1]) : null;
}

export function forceloadArea(box: Box, add: boolean): string {
    return `${IN_OVERWORLD} forceload ${add ? "add" : "remove"} ${box.x1} ${box.z1} ${box.x2} ${box.z2}`;
}

/** Our block, only where there is air. */
export function fillKeep(box: Box, block: string): string {
    return `${IN_OVERWORLD} fill ${region(box)} ${block} keep`;
}

/**
 * The arena taken down: every kind of block it used replaced with air, and
 * nothing else, inside its own box and nowhere else.
 *
 * A kind at a time over the whole box, in the order the arena lists them: a
 * flower, a ladder or a banner listed first comes down before what holds it
 * up. Taken the other way - every kind in the lowest slice, then the next -
 * the ground of one slice went first, and what stood on it in the slice over
 * it dropped as an item nobody owns.
 */
export function teardown(arena: Arena): string[] {
    const pieces = slices(arena.box);
    return arena.blocks
        .filter((block) => ITEM_ID.test(block))
        .flatMap((block) =>
            pieces.map(
                (piece) => `${IN_OVERWORLD} fill ${region(piece)} minecraft:air replace ${block}`
            )
        );
}

/** Whether a fill could not reach its blocks, and has to be tried again. */
export function notLoaded(output: string): boolean {
    return /not loaded|unloaded/i.test(stripFormatting(output));
}

// ------------------------------------------------------------------ the kit

const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const MARK = "polaris_event:1b";

export interface KitExtras {
    /** Blocks it can be placed on in adventure mode. */
    readonly placeOn?: readonly string[];
    /** Blocks it can break in adventure mode. */
    readonly breaks?: readonly string[];
    /** Never wears out: a crown, a sword and shield, a tool the event hands out
     *  must last the event however much it is used. */
    readonly unbreakable?: boolean;
    /** Mines at this speed whatever it may break, dropping it as the right tool
     *  would. From 1.20.5, which has the tool component; ignored before. What it
     *  may break is still only `breaks`. */
    readonly miningSpeed?: number;
}

/** What every piece of kit that can wear out is given: it lasts the event. */
export const LASTS: KitExtras = { unbreakable: true };

/** An item as the event hands it out: marked, so it is the only thing taken back. */
export function marked(id: string, marker: Marker, extras: KitExtras = {}): string {
    const list = (ids: readonly string[]) => `[${ids.map((one) => `"${one}"`).join(",")}]`;
    if (marker === "components") {
        const parts = [`minecraft:custom_data={${MARK}}`];
        if (extras.placeOn) parts.push(`minecraft:can_place_on={blocks:${list(extras.placeOn)}}`);
        if (extras.breaks) parts.push(`minecraft:can_break={blocks:${list(extras.breaks)}}`);
        if (extras.unbreakable) parts.push("minecraft:unbreakable={}");
        // A tag rather than the blocks again: the list twice outgrew one command.
        if (extras.miningSpeed)
            parts.push(
                `minecraft:tool={default_mining_speed:${extras.miningSpeed.toFixed(1)}f,rules:[{blocks:"#minecraft:mineable/pickaxe",speed:${extras.miningSpeed.toFixed(1)}f,correct_for_drops:true}]}`
            );
        return `${id}[${parts.join(",")}]`;
    }
    const parts = [MARK];
    if (extras.placeOn) parts.push(`CanPlaceOn:${list(extras.placeOn)}`);
    if (extras.breaks) parts.push(`CanDestroy:${list(extras.breaks)}`);
    if (extras.unbreakable) parts.push("Unbreakable:1b");
    return `${id}{${parts.join(",")}}`;
}

export function giveMarked(
    name: string,
    id: string,
    count: number,
    marker: Marker,
    extras: KitExtras = {}
): string {
    return `give ${name} ${marked(id, marker, extras)} ${count}`;
}

/** A marked item put straight into one slot (`weapon.offhand`), from 1.17. Only
 *  where that slot was emptied first: whatever is in it is replaced. */
export function equipMarked(
    name: string,
    slot: string,
    id: string,
    marker: Marker,
    extras: KitExtras = {}
): string {
    return `item replace entity ${name} ${slot} with ${marked(id, marker, extras)} 1`;
}

/**
 * A marked item put on somebody's head, and only when nothing is on it: with
 * `item replace` from 1.17, `replaceitem` before it - which, unguarded, takes
 * the place of whatever helmet they wear, their own included.
 */
export function wearMarked(name: string, id: string, marker: Marker, itemCommand: boolean): string {
    const put = itemCommand
        ? `item replace entity ${name} armor.head with ${marked(id, marker)} 1`
        : `replaceitem entity ${name} armor.head ${marked(id, marker)} 1`;
    return `execute unless data entity ${name} Inventory[{Slot:103b}] run ${put}`;
}

/** Who carries a tag, read the way `commands.readWhere` reads where they are. */
export function readTagged(tag: string): string {
    return `execute as @a[tag=${tag}] run data get entity @s Pos`;
}

/** The kit taken back from one player: only items carrying the marker. */
export function clearMarked(name: string, id: string, marker: Marker): string {
    return marker === "components"
        ? `clear ${name} ${id}[minecraft:custom_data={${MARK}}]`
        : `clear ${name} ${id}{${MARK}}`;
}

/** How a marked item reads in an item entity's `Item`. */
function markedItem(marker: Marker): string {
    return marker === "components"
        ? `{components:{"minecraft:custom_data":{${MARK}}}}`
        : `{tag:{${MARK}}}`;
}

/** Kit lying about in the box, dropped or thrown: gone, and only it. */
export function killMarkedDrops(box: Box, marker: Marker): string {
    return `${IN_OVERWORLD} kill @e[type=minecraft:item,${within(box)},nbt={Item:${markedItem(marker)}}]`;
}

/**
 * What a block broken in the box let fall: gone before anybody can pick it up,
 * so nothing unmarked leaves with them. Never the kit, and never what somebody
 * threw (it has a `Thrower`), so nobody's own things are touched.
 */
export function killBrokenDrops(box: Box, marker: Marker): string {
    return `execute in minecraft:overworld as @e[type=minecraft:item,${within(box)},nbt=!{Item:${markedItem(marker)}}] unless data entity @s Thrower run kill @s`;
}

/**
 * What a block broken in the box let fall, made kit again: marked and placeable
 * on `placeOn`, as it was handed out, so it stacks with the rest and is taken
 * back with it. Never what somebody threw (it has a `Thrower`).
 */
export function reclaimBrokenDrops(box: Box, marker: Marker, placeOn: readonly string[]): string {
    const list = `[${placeOn.map((one) => `"${one}"`).join(",")}]`;
    const item =
        marker === "components"
            ? `{components:{"minecraft:custom_data":{${MARK}},"minecraft:can_place_on":{blocks:${list}}}}`
            : `{tag:{${MARK},CanPlaceOn:${list}}}`;
    return `execute in minecraft:overworld as @e[type=minecraft:item,${within(box)},nbt=!{Item:${markedItem(marker)}}] unless data entity @s Thrower run data merge entity @s {Item:${item}}`;
}

/**
 * Whatever somebody drops in the box kept theirs: only the one who threw it can
 * pick it up, and it does not vanish while they are away from it.
 */
export function keepThrown(box: Box): string[] {
    const each = `execute in minecraft:overworld as @e[type=minecraft:item,${within(box)}] if data entity @s Thrower run`;
    return [
        `${each} data modify entity @s Owner set from entity @s Thrower`,
        `${each} data merge entity @s {Age:-32768}`
    ];
}

/** What one player dropped in the box, sent after them. */
export function sendThrown(box: Box, entrant: Entrant): string | null {
    if (!entrant.uuid || !PLAYER_NAME.test(entrant.name)) return null;
    return `execute in minecraft:overworld as @e[type=minecraft:item,${within(box)},nbt={Thrower:[I;${entrant.uuid.join(",")}]}] run tp @s ${entrant.name}`;
}

// ------------------------------------------------------------------ who they are

export const READ_GAMEMODES = "execute as @a run data get entity @s playerGameType";
export const READ_UUIDS = "execute as @a run data get entity @s UUID";

/** `Ana has the following entity data: 0` - 0 survival, 1 creative, 2 adventure, 3 spectator. */
export function readGamemodes(output: string): Map<string, Gamemode> {
    const found = new Map<string, Gamemode>();
    const pattern = /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: ([0-3])(?![\d.])/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, GAMEMODES[Number(match[2])] as Gamemode);
    }
    return found;
}

/** `Ana has the following entity data: [I; 1, -2, 3, 4]`. */
export function readUuids(output: string): Map<string, number[]> {
    const found = new Map<string, number[]>();
    const pattern =
        /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: \[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, [match[2], match[3], match[4], match[5]].map(Number));
    }
    return found;
}

// ------------------------------------------------------------------ in and out

export interface Spot {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
    readonly pitch?: number;
}

/** The tag everybody an arena took in carries until they are sent back. */
export const IN_ARENA = "pe_arena";

/** Into the arena, standing on its floor, in adventure mode: nothing can be
 *  placed or broken there but what the kit allows. Tagged before they are
 *  moved, so nobody is ever in it untagged and taken for back already. */
export function enter(name: string, spot: Spot): string[] {
    return [
        `tag ${name} add ${IN_ARENA}`,
        `${IN_OVERWORLD} tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} ${spot.yaw} ${spot.pitch ?? 0}`,
        `gamemode adventure ${name}`
    ];
}

/** Back, and so no longer in: the tag taken off. */
export function leftArena(name: string): string {
    return `tag ${name} remove ${IN_ARENA}`;
}

/** Moved within it, the game mode as it is. */
export function moveTo(name: string, spot: Spot): string {
    return `${IN_OVERWORLD} tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} ${spot.yaw} ${spot.pitch ?? 0}`;
}

const DIMENSION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** Whether a stored entrant can be put into a command at all. */
export function commandable(entrant: Entrant): boolean {
    return (
        PLAYER_NAME.test(entrant.name) &&
        DIMENSION.test(entrant.dimension) &&
        [entrant.x, entrant.y, entrant.z, entrant.yaw, entrant.pitch].every(Number.isFinite)
    );
}

/** Before they are sent back: unable to fall to their death for a while, and
 *  the kit taken back. Their own game mode only once they are home - switched
 *  back up in the air, a player who was flying would fall. */
export function homeward(
    entrant: Entrant,
    marker: Marker | null,
    kit: readonly string[]
): string[] {
    return [
        ...fallProof(entrant.name),
        ...(marker
            ? kit
                  .filter((id) => ITEM_ID.test(id))
                  .map((id) => clearMarked(entrant.name, id, marker))
            : [])
    ];
}

/** Home: their own game mode again. */
export function homeMode(entrant: Entrant): string {
    return `gamemode ${entrant.gamemode} ${entrant.name}`;
}

/** Back to exactly where they stood, facing the way they faced. */
export function sendHome(entrant: Entrant): string {
    const at = [entrant.x, entrant.y, entrant.z].map((value) => value.toFixed(3)).join(" ");
    return `execute in ${entrant.dimension} run tp ${entrant.name} ${at} ${entrant.yaw.toFixed(1)} ${entrant.pitch.toFixed(1)}`;
}

/** Whether a teleport reached them - an offline player is not found. */
export function wentHome(output: string): boolean {
    const plain = stripFormatting(output);
    return /teleported/i.test(plain) && !/no (player|entity) was found/i.test(plain);
}

/** Falling slowly for a moment past each look: nobody is hurt stepping off a roof. */
export function floatDown(name: string): string {
    return `effect give ${name} minecraft:slow_falling 3 0 true`;
}

/** Nobody goes hungry in an arena: fed for a moment past each look. */
export function feed(name: string): string {
    return `effect give ${name} minecraft:saturation 3 0 true`;
}

/**
 * Everybody inside healed whole, at "Go!". A fight reads health from a
 * `health` count (`team-duel.healthOf`), which the game fills in only once a
 * player's health changes, and takes a player with no score yet as whole. A
 * player who came in already hurt had none - until the first scratch, or the
 * first heart back, wrote their true, low health and the next look called
 * them out of a fight nobody had touched them in.
 */
export const HEAL_INSIDE = `effect give @a[tag=${IN_ARENA}] minecraft:instant_health 1 3 true`;

/** Beyond harm for a moment past each look: where nobody is meant to fight,
 *  nobody can be hurt, or die and drop what they carry. */
export function protect(name: string): string {
    return `effect give ${name} minecraft:resistance 3 4 true`;
}

// ------------------------------------------------------------------ on screen

export function actionbarTo(name: string, line: string): string {
    return `title ${name} actionbar ${text(line)}`;
}

export function titleTo(name: string, title: string, subtitle: string): string[] {
    return [
        `title ${name} times 10 60 20`,
        `title ${name} subtitle ${text(subtitle)}`,
        `title ${name} title ${text(title)}`
    ];
}

export function tellTo(name: string, line: string): string {
    return `tellraw ${name} ${text(line)}`;
}

/**
 * Maps: a server that already has somewhere to play, not just something to run.
 *
 * A blueprint installs the plugin that makes a game exist and leaves the world to
 * the generator, which is the right answer for a game whose content is generated
 * and the wrong one for every game whose content is a place somebody built. Bed
 * wars is the case that made this necessary: the plugin installs, the server
 * starts, and what the operator gets is an empty flat world, because the arena is
 * the game and no plugin ships one.
 *
 * A map is the other half - a world somebody built, fetched while the server is
 * being created and extracted into its data directory before it boots. Nothing is
 * kept on the machine Polaris runs on: the entry names a URL and the container
 * downloads it itself, once, on the first start, and only when that level does not
 * already exist. A server that is never created never downloads anything.
 *
 * Three things make a map more than a download, and all three are why this is a
 * table rather than a URL on the blueprint:
 *
 * - The release. A world is upgraded forward by the game, so terrain built on an
 *   old release plays on a new one - but a map whose game is written in commands
 *   is only as portable as that syntax, and item NBT stopped being accepted in
 *   1.20.5. `minecraft.policy` is where that difference is written down: `from`
 *   takes the newest release, `exact` refuses to move off the one the map's own
 *   logic was written for.
 * - The settings. Spawn protection is the sharpest one - sixteen blocks of
 *   unbreakable ground around spawn is invisible on a survival server and is the
 *   whole first island on a skyblock map - and the gamemode, the difficulty and
 *   whether command blocks run at all decide whether the map does anything.
 * - The plugins. A map that carries its own game in command blocks and datapacks
 *   wants the blueprint's plugin taken back off, not added to: BedWars1058 and a
 *   vanilla bed wars map are two implementations of the same game fighting over
 *   one world. `projects` says what the map itself needs, and an empty list is a
 *   map that needs nothing.
 *
 * The archives are mirrored rather than fetched from the page each map was
 * published on. Those pages hand their downloads out through a gate - a token in
 * the URL, a check on where the request came from - which is a download that works
 * when a person clicks it and fails from inside a container, and failing there
 * means a server that boots into an empty world with the reason only in its log.
 * What is mirrored is the world folder and nothing else. Every entry credits its
 * author and links the page it came from.
 *
 * The mirror is a CDN over a tagged repository, and both halves of that are the
 * result of the same measurement. A GitHub release was the obvious place to put
 * them and is the wrong one: its asset host redirects to a signed URL that closes
 * HTTP/1.1 connections part way through often enough to fail two downloads in
 * three, and HTTP/1.1 is what the image's downloader speaks - so the first server
 * built on a map usually got no map. The tag is what makes the URL immutable, and
 * immutable is what lets each entry carry the hash of what it will actually get.
 */

import { FLAT_LEVEL_TYPE } from "./world";
import type { GameBlueprint } from "./blueprints";

/** Where the mirrored archives live. One tag, so a map added later is a commit
 *  and a new tag rather than a new place for these to come from. */
const MIRROR = "https://cdn.jsdelivr.net/gh/FJRG2007/polaris-minecraft-worlds@v2";

/** The kind of game a map is, which is what a blueprint offers a choice of. */
export type MapCategory = "skyblock" | "parkour" | "bedwars" | "luckyblock";

/**
 * How a map is tied to a Minecraft release.
 *
 * `from` is the release the world was built on and means nothing after that: the
 * game upgrades terrain forward, so the newest release is used. `exact` is a map
 * whose own logic - datapack functions, command blocks - was written against one
 * release and stops working on later ones, and it is a pin rather than a
 * preference.
 */
export interface MapRelease {
    readonly version: string;
    readonly policy: "from" | "exact";
}

/** A pack the map needs the client to load for it to look like itself. */
export interface MapResourcePack {
    readonly url: string;
    /** Required by the game before a client will use a downloaded pack. */
    readonly sha1: string;
}

/**
 * The generator a world cannot describe for itself.
 *
 * Minecraft only started storing world generation inside the world file in 1.16.
 * A world older than that says nothing about how it was made, and a dedicated
 * server filling that gap does not guess - it reads `level-type` out of its own
 * settings and generates accordingly. So a flat map from 1.13 dropped onto a server
 * set to "normal" keeps the blocks that are in its region files and grows ordinary
 * terrain through and around them, with the map's own spawn point now well
 * underground. It looks like the map was never installed.
 *
 * Which is why this is not a preference. It is read out of the map's own
 * `level.dat` - `generatorName` and `generatorOptions` - and written back so the
 * server generates what the map was built on rather than what it would have chosen.
 */
export interface MapGenerator {
    /** The `level-type` this world was made with. */
    readonly levelType: string;
    /** Its `generator-settings`, verbatim, for a type that takes them. */
    readonly settings?: string;
}

export interface WorldMap {
    /** Also the level folder it is extracted into, so it has to be a level name. */
    readonly id: string;
    readonly name: string;
    readonly category: MapCategory;
    readonly summary: string;
    readonly author: string;
    /** The page it was published on, which is where credit points. */
    readonly source: string;
    /** The archive the container downloads. */
    readonly url: string;
    /** What that archive is, so a mirror that changed under us is visible. */
    readonly sha256: string;
    readonly bytes: number;
    readonly minecraft: MapRelease;
    /** How many the map was built for, which is what the slot count starts on. */
    readonly players: { readonly min: number; readonly max: number };
    /** Server settings the map needs to play the way it was built to. */
    readonly env?: Readonly<Record<string, string>>;
    readonly resourcePack?: MapResourcePack;
    /** The generator this world needs written into the server's settings, for a
     *  world old enough not to carry its own. */
    readonly generator?: MapGenerator;
    /** Modrinth projects the map itself needs. Empty is a map that carries its
     *  own game, and takes the blueprint's plugin back off. */
    readonly projects: readonly string[];
    /** What is still left to the people playing it, when anything is. */
    readonly setup?: string;
}

/**
 * Settings every one of these maps needs, whatever else it wants.
 *
 * Spawn protection is the one that is always wrong for a built map. It defaults to
 * sixteen blocks nobody but an operator can build in, which on a generated
 * survival world is a fence around a spawn point and on a map is the middle of
 * the game - the first skyblock island, a bed wars generator, the start of a
 * parkour course. Command blocks are off by default for the same kind of reason:
 * a map whose logic is command blocks does nothing at all without them, and every
 * map here has some.
 */
const MAP_BASE_ENV = { SPAWN_PROTECTION: "0", ENABLE_COMMAND_BLOCK: "true" } as const;

export const WORLD_MAPS: readonly WorldMap[] = [
    {
        id: "skyblock-2-1",
        name: "Skyblock 2.1",
        category: "skyblock",
        summary: "The original island in the void, a tree and a chest. Survive on what you can make of it.",
        author: "Polaris",
        source: "https://skyblock.net",
        url: `${MIRROR}/skyblock-2-1.zip`,
        sha256: "2dc429f5b76292559fe20de44676400d60ed7d1cb4fa0959291ff39358554920",
        bytes: 2554241,
        // Terrain and a chest, with no commands of its own to go out of date.
        minecraft: { version: "1.16.4", policy: "from" },
        players: { min: 1, max: 10 },
        env: { ...MAP_BASE_ENV, MODE: "survival", DIFFICULTY: "normal", PVP: "false" },
        projects: [],
        setup: "Everyone starts on the same island. The challenge list is in the chest."
    },
    {
        id: "parkour-spiral",
        name: "Parkour Spiral",
        category: "parkour",
        summary: "A tower of themed courses with checkpoints, climbed from the bottom.",
        author: "Polaris",
        source: "https://hielkemaps.com/maps/parkour-spiral",
        url: `${MIRROR}/parkour-spiral.zip`,
        sha256: "6ad92d235ed01e5bb4172af18168064e55876fefdeeb46e7920d78aaecda8836",
        bytes: 10488466,
        // The build the author publishes for the current release. Pinned rather
        // than floated: the courses are run by command blocks, and the author
        // reissues the map for a new release rather than the map surviving one.
        minecraft: { version: "26.2", policy: "exact" },
        players: { min: 1, max: 20 },
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "peaceful", PVP: "false" },
        projects: [],
        setup: "Checkpoints are saved per player, so people can join and leave without losing the climb."
    },
    {
        id: "bedwars-treasure-island",
        name: "Bedwars: Treasure Island",
        category: "bedwars",
        summary: "Eight teams, a bed each and a pirate island in the middle. Shops, generators and traps are built in.",
        author: "Polaris",
        source: "https://www.minecraftmaps.com/51834-bedwars-treasure-island",
        url: `${MIRROR}/bedwars-treasure-island.zip`,
        sha256: "a13834575ed84953f1ce52df87ea9514241725684604912977a6789af15a7d74",
        bytes: 12756637,
        // The game is a datapack, and a datapack declares the release it was
        // written for: this one is 1.19's, which a later server refuses to load.
        // Its shop functions are older than that refusal matters for anyway - they
        // give items with the NBT syntax the game stopped accepting in 1.20.5.
        minecraft: { version: "1.19.4", policy: "exact" },
        players: { min: 2, max: 16 },
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "easy", PVP: "true" },
        resourcePack: {
            url: `${MIRROR}/bedwars-treasure-island-resources.zip`,
            sha1: "7e015ebb19ae0101cbddbbd5a24fee772094eee1"
        },
        // The map is the whole game, which is what makes it worth having: the
        // blueprint's own plugin is a second bed wars implementation, and two of
        // them in one world is neither.
        projects: [],
        setup: "Stand on a team's pad to join it and the game starts itself. Nothing to configure and no arena to register."
    },
    {
        id: "luckyblock-towers",
        name: "Luckyblock Towers",
        category: "luckyblock",
        summary: "Race up towers of lucky blocks and take whatever they give you. Hidden chest in every tower.",
        author: "Polaris",
        source: "https://www.minecraftmaps.com",
        url: `${MIRROR}/luckyblock-towers.zip`,
        sha256: "e8bd1acbb05a3203dda363ee133fb6c1b572335899b32aa0ae345df5c14d45b0",
        bytes: 2313341,
        // Command blocks only, and every command in them is the modern syntax -
        // no items are given with NBT, which is the change that breaks maps of
        // this age - so it plays on the current release.
        minecraft: { version: "1.13", policy: "from" },
        players: { min: 1, max: 12 },
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "normal", PVP: "true" },
        // Written in 1.13, three releases before a world could say how it was made,
        // so the server has to be told: a single layer of air, and the towers stand
        // in the void. Taken from its own level.dat, where `generatorName` is flat
        // and `generatorOptions` is this. Left to the default it grew ordinary
        // terrain around the towers and put spawn under it.
        generator: {
            levelType: FLAT_LEVEL_TYPE,
            settings: JSON.stringify({ layers: [{ block: "minecraft:air", height: 1 }], biome: "minecraft:desert" })
        },
        // The lucky blocks are sponges wearing the pack. Without it the map plays
        // exactly the same and looks like a sponge farm.
        resourcePack: {
            url: `${MIRROR}/luckyblock-towers-resources.zip`,
            sha1: "9dac960cbdb8fea3f027bb64bce4352f99080223"
        },
        projects: []
    }
];

/** How each category is named where somebody is choosing between them. */
export const MAP_CATEGORIES: Readonly<Record<MapCategory, string>> = {
    skyblock: "Skyblock",
    parkour: "Parkour",
    bedwars: "Bed wars",
    luckyblock: "Lucky blocks"
};

export function findMap(id: string | undefined): WorldMap | undefined {
    return id ? WORLD_MAPS.find((map) => map.id === id) : undefined;
}

/** A map somebody could actually be given. Blank is "generate a world instead",
 *  which is a valid answer rather than a missing one. */
export function isWorldMap(id: string): boolean {
    return id.length === 0 || findMap(id) !== undefined;
}

/** Every map a blueprint can be built on, which is every map of its category. */
export function mapsFor(blueprint: Pick<GameBlueprint, "mapCategory"> | undefined): readonly WorldMap[] {
    return blueprint?.mapCategory ? WORLD_MAPS.filter((map) => map.category === blueprint.mapCategory) : [];
}

/** Whether this blueprint could be built on a map at all. */
export function hasMaps(blueprint: Pick<GameBlueprint, "mapCategory"> | undefined): boolean {
    return mapsFor(blueprint).length > 0;
}

/**
 * The map a blueprint is being built on, refusing one that is not its game.
 *
 * Checked rather than trusted because the id arrives from a form: a skyblock
 * blueprint handed the bed wars map would install a world its settings and its
 * release pin were never worked out for.
 */
export function mapFor(blueprint: GameBlueprint, id: string | undefined): WorldMap | undefined {
    if (!id) return undefined;
    const map = findMap(id);
    if (!map || map.category !== blueprint.mapCategory) throw new Error("That map is not one this game can be built on");
    return map;
}

/** The release a map has to run on, or null when it does not care. */
export function pinnedRelease(map: WorldMap | undefined): string | null {
    return map && map.minecraft.policy === "exact" ? map.minecraft.version : null;
}

/** Whether a resource pack URL is one of ours, which is what makes it safe for a
 *  map that needs no pack to clear: an operator's own pack is left alone. */
export function isMapResourcePack(url: string | undefined): boolean {
    const trimmed = (url ?? "").trim();
    return trimmed.length > 0 && WORLD_MAPS.some((map) => map.resourcePack?.url === trimmed);
}

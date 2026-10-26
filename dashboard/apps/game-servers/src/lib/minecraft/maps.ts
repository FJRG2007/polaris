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
 * being created and extracted into its data directory before it boots. The entry
 * names an archive and the container downloads it from Polaris itself, once, on
 * the first start, and only when that level does not already exist. A server that
 * is never created never downloads anything.
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
 * The archives ship with Polaris rather than being fetched from the page each map
 * was published on. Those pages hand their downloads out through a gate - a token
 * in the URL, a check on where the request came from - which is a download that
 * works when a person clicks it and fails from inside a container, and failing
 * there means a server that boots into an empty world with the reason only in its
 * log. What ships is the world folder and nothing else
 * (resources/minecraft-worlds), published by Polaris's own CI beside its app
 * bundles and downloaded by an instance only when a server is built on that map
 * (`map-store.ts`), so an instance carries only the worlds its servers use.
 * Every entry credits its author and links the page it came from, and carries
 * the hash of the archive it names, which is also how it is fetched.
 *
 * The dashboard serves them (`world-download.ts`): a world to the server's
 * container behind the instance's key, a pack to the players' clients. This
 * module only knows the paths, so a screen can import it.
 */

import { gameMessage } from "../game-message";
import { FLAT_LEVEL_TYPE } from "./world";
import type { GameBlueprint } from "./blueprints";

/** Where a server's container downloads a world: `<base>/<key>/<archive>`. */
export const WORLD_PATH = "/api/minecraft/world";

/** Where a player's client downloads a map's pack: `<base>/<archive>`. Public,
 *  because the game fetches it with no credential of any kind. */
export const MAP_PACK_PATH = "/api/minecraft/map-pack";

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
    /** The file in resources/minecraft-worlds. */
    readonly archive: string;
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
    /** The file in resources/minecraft-worlds the container downloads. */
    readonly archive: string;
    /** What that archive is, so a file that changed under us is visible. */
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
        summary: gameMessage("games", "lib.maps.skyblock-2-1.summary"),
        author: "Noobcrew",
        source: "https://skyblock.net",
        archive: "skyblock-2-1.zip",
        sha256: "2dc429f5b76292559fe20de44676400d60ed7d1cb4fa0959291ff39358554920",
        bytes: 2554241,
        // Terrain and a chest, with no commands of its own to go out of date.
        minecraft: { version: "1.16.4", policy: "from" },
        players: { min: 1, max: 10 },
        env: { ...MAP_BASE_ENV, MODE: "survival", DIFFICULTY: "normal", PVP: "false" },
        projects: [],
        setup: gameMessage("games", "lib.maps.skyblock-2-1.setup")
    },
    {
        id: "parkour-spiral",
        name: "Parkour Spiral",
        category: "parkour",
        summary: gameMessage("games", "lib.maps.parkour-spiral.summary"),
        author: "Hielke",
        source: "https://hielkemaps.com/maps/parkour-spiral",
        archive: "parkour-spiral.zip",
        sha256: "d8ca9541c2c38b9e31170322ed6b3f0fde59b2f75078b8d2f297c1e769513f3f",
        bytes: 5367784,
        // The build the author publishes for the current release. Pinned rather
        // than floated: the courses are run by command blocks, and the author
        // reissues the map for a new release rather than the map surviving one.
        minecraft: { version: "26.2", policy: "exact" },
        players: { min: 1, max: 20 },
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "peaceful", PVP: "false" },
        projects: [],
        setup: gameMessage("games", "lib.maps.parkour-spiral.setup")
    },
    {
        id: "parkour-spiral-2",
        name: "Parkour Spiral 2",
        category: "parkour",
        summary: gameMessage("games", "lib.maps.parkour-spiral-2.summary"),
        author: "Hielke",
        source: "https://hielkemaps.com/maps/parkour-spiral-2",
        archive: "parkour-spiral-2.zip",
        sha256: "ab8a96a391ce3a9056fd12ab609a8f9fa84f8a217e6672747312b66b2a131ef5",
        bytes: 16606371,
        // Run by command blocks like the first one, and reissued by the author
        // for each release in the same way, so pinned the same way.
        minecraft: { version: "26.2", policy: "exact" },
        players: { min: 1, max: 20 },
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "peaceful", PVP: "false" },
        projects: [],
        setup: gameMessage("games", "lib.maps.parkour-spiral.setup")
    },
    {
        id: "parkour-spiral-3",
        name: "Parkour Spiral 3",
        category: "parkour",
        summary: gameMessage("games", "lib.maps.parkour-spiral-3.summary"),
        author: "Hielke",
        source: "https://hielkemaps.com/maps/parkour-spiral-3",
        archive: "parkour-spiral-3.zip",
        sha256: "2659e167bb875bd5e1ee1f139fa8ea387962174ff1d13993a2106e88de706632",
        bytes: 27644845,
        // Run by command blocks like the first one, and reissued by the author
        // for each release in the same way, so pinned the same way.
        minecraft: { version: "26.2", policy: "exact" },
        players: { min: 1, max: 20 },
        // Easy rather than peaceful: the author set it, and the map is built for it.
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "easy", PVP: "false" },
        projects: [],
        setup: gameMessage("games", "lib.maps.parkour-spiral.setup")
    },
    {
        id: "bedwars-treasure-island",
        name: "Bedwars: Treasure Island",
        category: "bedwars",
        summary: gameMessage("games", "lib.maps.bedwars-treasure-island.summary"),
        author: "TriplicataMC",
        source: "https://www.minecraftmaps.com/51834-bedwars-treasure-island",
        archive: "bedwars-treasure-island.zip",
        sha256: "0649d573b032b0635512e10f47aab19994d24336d9e33d4cdd6b70ea8be52008",
        bytes: 4889177,
        // The game is a datapack, and a datapack declares the release it was
        // written for: this one is 1.19's, which a later server refuses to load.
        // Its shop functions are older than that refusal matters for anyway - they
        // give items with the NBT syntax the game stopped accepting in 1.20.5.
        minecraft: { version: "1.19.4", policy: "exact" },
        players: { min: 2, max: 16 },
        env: { ...MAP_BASE_ENV, MODE: "adventure", DIFFICULTY: "easy", PVP: "true" },
        resourcePack: {
            archive: "bedwars-treasure-island-resources.zip",
            sha1: "7e015ebb19ae0101cbddbbd5a24fee772094eee1"
        },
        // The map is the whole game, which is what makes it worth having: the
        // blueprint's own plugin is a second bed wars implementation, and two of
        // them in one world is neither.
        projects: [],
        setup: gameMessage("games", "lib.maps.bedwars-treasure-island.setup")
    },
    {
        id: "luckyblock-towers",
        name: "Luckyblock Towers",
        category: "luckyblock",
        summary: gameMessage("games", "lib.maps.luckyblock-towers.summary"),
        author: "Polaris",
        source: "https://www.minecraftmaps.com",
        archive: "luckyblock-towers.zip",
        sha256: "9c86023e637b4aae3a291932b395f3cd4b65db89d2bb646499d0e9946981a310",
        bytes: 2170584,
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
            settings: JSON.stringify({
                layers: [{ block: "minecraft:air", height: 1 }],
                biome: "minecraft:desert"
            })
        },
        // The lucky blocks are sponges wearing the pack. Without it the map plays
        // exactly the same and looks like a sponge farm.
        resourcePack: {
            archive: "luckyblock-towers-resources.zip",
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
export function mapsFor(
    blueprint: Pick<GameBlueprint, "mapCategory"> | undefined
): readonly WorldMap[] {
    return blueprint?.mapCategory
        ? WORLD_MAPS.filter((map) => map.category === blueprint.mapCategory)
        : [];
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
    if (!map || map.category !== blueprint.mapCategory)
        throw new Error(gameMessage("games", "lib.notMapForGame"));
    return map;
}

/** The release a map has to run on, or null when it does not care. */
export function pinnedRelease(map: WorldMap | undefined): string | null {
    return map && map.minecraft.policy === "exact" ? map.minecraft.version : null;
}

/** Every world archive a server may be given, and every pack a client may be. */
export const WORLD_FILES: readonly string[] = WORLD_MAPS.map((map) => map.archive);
export const MAP_PACK_FILES: readonly string[] = WORLD_MAPS.flatMap((map) =>
    map.resourcePack ? [map.resourcePack.archive] : []
);

/** Where a server's container downloads this map's world. */
export function worldUrl(baseUrl: string, map: WorldMap, key: string): string {
    return `${baseUrl.replace(/\/+$/, "")}${WORLD_PATH}/${encodeURIComponent(key)}/${map.archive}`;
}

/** Where a client downloads this map's pack, or null for a map with none. */
export function mapPackUrl(baseUrl: string, map: WorldMap): string | null {
    return map.resourcePack
        ? `${baseUrl.replace(/\/+$/, "")}${MAP_PACK_PATH}/${map.resourcePack.archive}`
        : null;
}

/**
 * The host the archives were served from before Polaris carried them. Only ever
 * matched, never written: a server created then still names it in `WORLD` or
 * `RESOURCE_PACK` until the component sweep rewrites the value, and recognising
 * it is what lets that sweep - and a reset - replace it.
 */
const FORMER_HOST = "cdn.jsdelivr.net";

/** The archive a URL Polaris wrote names - one of ours, served from `path`
 *  here or from the former host - or null when it is anything else. */
function archiveOf(url: string | undefined, path: string, files: readonly string[]): string | null {
    let parsed: URL;
    try {
        parsed = new URL((url ?? "").trim());
    } catch {
        return null;
    }
    const file = parsed.pathname.split("/").pop() ?? "";
    if (!files.includes(file)) return null;
    const ours = parsed.hostname === FORMER_HOST || parsed.pathname.startsWith(`${path}/`);
    return ours ? file : null;
}

/** The map whose world a `WORLD` value Polaris wrote fetches, or undefined when
 *  the value is somebody else's or blank. */
export function mapOfWorldUrl(url: string | undefined): WorldMap | undefined {
    const file = archiveOf(url, WORLD_PATH, WORLD_FILES);
    return file ? WORLD_MAPS.find((map) => map.archive === file) : undefined;
}

/** The map whose pack a `RESOURCE_PACK` value Polaris wrote is, or undefined. */
export function mapOfPackUrl(url: string | undefined): WorldMap | undefined {
    const file = archiveOf(url, MAP_PACK_PATH, MAP_PACK_FILES);
    return file ? WORLD_MAPS.find((map) => map.resourcePack?.archive === file) : undefined;
}

/** Whether a resource pack URL is one of ours, which is what makes it safe for a
 *  map that needs no pack to clear: an operator's own pack is left alone. Also
 *  true for the address a map's pack had before Polaris carried it. */
export function isMapResourcePack(url: string | undefined): boolean {
    return mapOfPackUrl(url) !== undefined;
}

/** Where this instance serves the archives from, as a server and its players
 *  reach it (`world-address.ts` decides). */
export interface MapAddresses {
    /** The base a server's container fetches a world from. */
    readonly world: string;
    /** The base a player's client fetches a pack from, or null when Polaris has
     *  no address a client could reach. */
    readonly pack: string | null;
    /** The instance's key, which the world's address carries. */
    readonly key: string;
}

/** The pack settings a map needs, or blanks when its pack has no address a
 *  client could reach: a pack nobody can download is a warning on every join.
 *  Null for a map with no pack. */
export function mapPackEnv(
    map: WorldMap,
    addresses: MapAddresses
): { RESOURCE_PACK: string; RESOURCE_PACK_SHA1: string } | null {
    if (!map.resourcePack) return null;
    const url = addresses.pack === null ? null : mapPackUrl(addresses.pack, map);
    return url
        ? { RESOURCE_PACK: url, RESOURCE_PACK_SHA1: map.resourcePack.sha1 }
        : { RESOURCE_PACK: "", RESOURCE_PACK_SHA1: "" };
}

/**
 * What a server's `WORLD` and `RESOURCE_PACK` should become, when Polaris wrote
 * them and they no longer name where the archive is served now: the host they
 * came from before Polaris carried them, a key that was rotated, an address that
 * changed. Empty when nothing has to change. A value anybody else set is never
 * touched.
 */
export function mapUrlRewrites(
    env: ReadonlyMap<string, string>,
    addresses: MapAddresses
): Record<string, string> {
    const changes: Record<string, string> = {};
    const world = env.get("WORLD") ?? "";
    const worldMap = mapOfWorldUrl(world);
    if (worldMap) {
        const wanted = worldUrl(addresses.world, worldMap, addresses.key);
        if (wanted !== world) changes.WORLD = wanted;
    }
    const pack = env.get("RESOURCE_PACK") ?? "";
    const packMap =
        mapOfPackUrl(pack) ?? (env.has("RESOURCE_PACK") && pack === "" ? worldMap : undefined);
    const packEnv = packMap ? mapPackEnv(packMap, addresses) : null;
    if (packEnv && packEnv.RESOURCE_PACK !== pack) Object.assign(changes, packEnv);
    return changes;
}

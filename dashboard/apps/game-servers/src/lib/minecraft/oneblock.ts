/**
 * OneBlock's one setup step, done by Polaris instead of by somebody at a console.
 *
 * The plugin (MrMarL/OneBlock) does nothing until an admin has told it where the
 * first block goes: its own `config.yml` ships with `set: 0`, and an offset of
 * zero is how it spells "not configured" - it skips starting its tasks, and `/ob`
 * answers with nothing to join. The form it takes from the console is
 * `/ob set <offset> <x> <y> <z> <world>`, which writes the offset and the origin
 * back to that same file.
 *
 * So the file is the record of whether it has been done. A server whose file says
 * zero is told; one whose file says anything else was set up already - by this,
 * or by an operator who chose their own spot - and is left alone, unless its
 * islands are still in the level Polaris last set it up on and the server has
 * moved to a new one. Running the command again is not harmless: it turns the
 * block at the origin back into grass, which is the first island's block, so a
 * plugin that never takes it is only told a few times.
 *
 * Pure: what the file says and what to send. Reaching the server is
 * `oneblock-service.ts`.
 */

/** The blueprint this belongs to. */
export const ONEBLOCK_BLUEPRINT_ID = "oneblock";

/** The plugin's settings file, inside the server's data directory. */
export const ONEBLOCK_CONFIG_PATH = "/data/plugins/OneBlock/config.yml";

/** Install config key recording that the plugin has been seen set up, so the walk
 *  stops opening the server to look. */
export const ONEBLOCK_READY_KEY = "oneblockReady";

/** Install config key holding the level Polaris last saw the plugin set up on, so
 *  a new world can tell its own old setup from one an operator chose. */
export const ONEBLOCK_WORLD_KEY = "oneblockWorld";

/** Install config key counting the passes that sent the setup, so a plugin that
 *  never takes it stops having its first block reset. */
export const ONEBLOCK_TRIES_KEY = "oneblockTries";

/** Passes that send the setup before giving up on a plugin that does not take it. */
export const MAX_TRIES = 5;

/** The distance between two islands; the plugin's own default for `/ob set`. */
export const ISLAND_SPACING = 100;

/** Where the first block goes. The world is void, so the height is only what the
 *  sky and the build limit leave room for above and below it. */
export const ORIGIN = { x: 0, y: 64, z: 0 } as const;

/**
 * The island offset the plugin's file holds, or null when the file says nothing
 * readable about it. Zero is "never set".
 */
export function islandOffset(config: string): number | null {
    const line = /^set:[ \t]*(-?\d+)[ \t]*(?:#.*)?$/m.exec(config);
    if (!line?.[1]) return null;
    const value = Number.parseInt(line[1], 10);
    return Number.isFinite(value) ? value : null;
}

/** The world the plugin's file puts the islands in, or null when it names none. */
export function islandWorld(config: string): string | null {
    const line = /^world:[ 	]*["']?([^"'#\s]+)["']?[ 	]*(?:#.*)?$/m.exec(config);
    return line?.[1] ?? null;
}

/**
 * Whether the file shows the plugin already has somewhere to put islands on
 * `level`. A file that does not say is treated as not set: telling it is the safe
 * side, since a plugin with no origin is a server with no game on it. Nor is one
 * whose islands are in `previous`, the level Polaris last set it up on - after a
 * new world that is the old level's folder, which the server no longer loads, and
 * the plugin answers `/ob` with nothing to join. Islands in any other world are
 * an operator's choice and count as set up.
 */
export function isSetUp(config: string, level: string, previous: string | null = null): boolean {
    const offset = islandOffset(config);
    if (offset === null || offset === 0) return false;
    const world = islandWorld(config);
    if (world === null) return false;
    return world === level || world !== previous;
}

/**
 * The console lines that set the plugin up on `level`: the origin, and joining
 * people to their own block as they arrive instead of leaving them standing at
 * the world's spawn over nothing.
 */
export function setupLines(level: string): string[] {
    return [
        `ob set ${ISLAND_SPACING} ${ORIGIN.x} ${ORIGIN.y} ${ORIGIN.z} ${level}`,
        "ob autojoin true"
    ];
}

/**
 * Flat generator settings for a world with nothing in it, which is the void the
 * island floats in. One layer of air is how the game's own "The Void" preset is
 * written; plains rather than the void biome so weather and the sky look normal.
 */
export const VOID_GENERATOR_SETTINGS = JSON.stringify({
    layers: [{ block: "minecraft:air", height: 1 }],
    biome: "minecraft:plains",
    features: false,
    lakes: false
});

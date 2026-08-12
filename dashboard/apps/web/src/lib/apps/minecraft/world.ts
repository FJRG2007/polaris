/**
 * Where a Minecraft server keeps its map, and what may be done to it.
 *
 * The whole of the world feature rests on one decision: a map is never edited in
 * place. Generating a new one, restoring an old one and rolling a seed back are
 * all the same act - put a level folder on disk and point the server's `LEVEL` at
 * it - and the server only ever reads it at boot. That is what makes any of this
 * safe to do from here: a running server holds its own folder open and writes to
 * it right up to the moment it shuts down, so anything that swaps files under a
 * live world races with the shutdown save and loses. Nothing here touches the
 * folder the server is playing on.
 *
 * The cost is that old levels stay on disk until somebody deletes them, which is
 * why the screen lists them with their sizes. That is the right trade: a map that
 * is still there is an undo, and a map that was deleted to save a gigabyte is not.
 *
 * Pure - names, paths and rules. What runs inside the container is world-service.
 */

import type { MinecraftEdition } from "./service";

/** The image's own data directory, which the world volume is mounted at. */
export const DATA_DIR = "/data";

/** Where world archives are kept: inside the same volume as the world, so a
 *  backup costs one command in the container rather than a copy across the
 *  network. Which also means it is not an off-machine copy - the screen says so,
 *  and offers the download that makes one. */
export const BACKUP_DIR = `${DATA_DIR}/backups`;

/** Where a restore unpacks before the level is put in place. Hidden and outside
 *  the level names, so a half-finished restore is never mistaken for a world. */
export const STAGING_DIR = `${DATA_DIR}/.polaris-restore`;

/** Bedrock keeps every level under one directory; Java puts them beside the
 *  server's own files. */
export const BEDROCK_WORLDS_DIR = `${DATA_DIR}/worlds`;

/** Where config written by a release this server no longer runs is put out of the
 *  way. Hidden and outside the level names, for the same reason the restore folder
 *  is: a half-recognised folder must never read as a world. */
export const CONFIG_ASIDE_DIR = `${DATA_DIR}/.polaris-config`;

/** Where the server keeps what it loads at startup. */
export const PLUGINS_DIR = `${DATA_DIR}/plugins`;

/** And where a plugin this server is no longer meant to run goes. Same shape as
 *  the config folder, and nothing here is ever deleted. */
export const PLUGIN_ASIDE_DIR = `${DATA_DIR}/.polaris-plugins`;

/**
 * Whether this file is that project's plugin.
 *
 * The list of plugins is a list of project names and what is on the disk is a jar
 * somebody versioned however they liked, so the two are matched on the only thing
 * they share: the letters and digits of the name, in order, at the front.
 * `bedwars1058` finds `BedWars1058-25.5-SNAPSHOT.jar` and nothing else.
 */
export function isPluginOf(file: string, project: string): boolean {
    const bare = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    return file.toLowerCase().endsWith(".jar") && bare(file).startsWith(bare(project)) && bare(project).length > 0;
}

/**
 * The files a server's own release wrote and a different one cannot read.
 *
 * Paper keeps its settings under `config/` and the format is version specific in a
 * way that only breaks in one direction: a newer build writes the sentinel
 * `default` into fields an older build deserializes as numbers, and the older one
 * throws `NumberFormatException` while it is still reading its own configuration.
 * That is not a setting that does not apply, it is a server that never starts, and
 * a container the deploy will restart forever. The three loose files beside it are
 * the pre-1.19 layout, present on anything that ever ran older Paper, and the
 * Bukkit trio regenerates blank - they are here because leaving three of a set of
 * seven behind is how the next version-skew is found the hard way.
 *
 * `server.properties` is deliberately not here: the image rewrites the keys it
 * owns from the environment on every boot, so it is not stale in the way these
 * are. `plugins` is deliberately not here either - a plugin built against a newer
 * API fails its own load with an unsupported version and the server carries on,
 * which is a plugin that does not work rather than a server that does not start.
 */
export const VERSIONED_CONFIG = [
    "config",
    "bukkit.yml",
    "spigot.yml",
    "paper.yml",
    "commands.yml",
    "help.yml",
    "permissions.yml"
] as const;

/** The level each image generates into when it is told nothing else. */
const DEFAULT_LEVEL: Record<MinecraftEdition, string> = { java: "world", bedrock: "Bedrock level" };

/** The variable that names the level folder, per edition. */
const LEVEL_KEY: Record<MinecraftEdition, string> = { java: "LEVEL", bedrock: "LEVEL_NAME" };

/** The variable that carries the seed, per edition. */
const SEED_KEY: Record<MinecraftEdition, string> = { java: "SEED", bedrock: "LEVEL_SEED" };

/** The suffixes Paper and Spigot give a level's other two dimensions. Vanilla
 *  keeps them inside the level folder instead, so they need no naming here. */
const DIMENSION_SUFFIXES = ["_nether", "_the_end"] as const;

/**
 * What a player keeps when the map is replaced: their bag, what they have done,
 * and what they have collected. Java writes each as a folder inside the level, so
 * carrying them across is a copy; Bedrock keeps all of it inside the level
 * database, where it cannot be separated from the terrain at all.
 */
export const PLAYER_DATA_DIRS = ["playerdata", "stats", "advancements"] as const;

export function defaultLevel(edition: MinecraftEdition): string {
    return DEFAULT_LEVEL[edition];
}

export function levelEnvKey(edition: MinecraftEdition): string {
    return LEVEL_KEY[edition];
}

export function seedEnvKey(edition: MinecraftEdition): string {
    return SEED_KEY[edition];
}

/** Whether a player's things can be carried onto a new map at all. */
export function canCarryPlayers(edition: MinecraftEdition): boolean {
    return edition === "java";
}

/**
 * A level name that is safe to hand to a command as an argument and to keep as a
 * folder.
 *
 * Deliberately narrow: these names arrive from a directory listing inside the
 * container, which is to say from disk, which is to say from anything that has
 * ever written there. A name is only ever used as one argv element - never
 * through a shell - so this is the second line rather than the first, but a
 * leading dash would still be read as a flag and a leading dot would hide the
 * folder from every listing that shows it.
 */
export function isLevelName(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value);
}

/**
 * A seed as the game takes it, which is any text at all: a number is used as
 * itself and anything else is hashed. Bounded and stripped of control characters
 * so what is stored is what the operator typed.
 */
export function isSeed(value: string): boolean {
    return value.length > 0 && value.length <= 64 && !/[\0-\x1f\x7f]/.test(value);
}

/** The name of an archive this feature wrote, and nothing else. Checked before a
 *  name from a request is ever joined onto a path. */
export function isBackupName(value: string): boolean {
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}\.tar\.gz$/.test(value);
}

/** The archive a backup taken now would be written to. */
export function backupName(at: Date): string {
    return `${at.toISOString().replace(/[:.]/g, "-").replace("Z", "")}.tar.gz`;
}

/** When a backup was taken, from its name. Null for anything else in the folder. */
export function backupTakenAt(name: string): Date | null {
    if (!isBackupName(name)) return null;
    const iso = name.slice(0, -".tar.gz".length);
    const parsed = new Date(
        `${iso.slice(0, 10)}T${iso.slice(11, 13)}:${iso.slice(14, 16)}:${iso.slice(17, 19)}.${iso.slice(20, 23)}Z`
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A moment as a folder name: `20260812-210456`.
 *
 * Sorts chronologically as text, which is the whole point - these folders are
 * only ever read by somebody looking for the most recent one, in a listing that
 * sorts by name.
 */
export function folderStamp(at: Date): string {
    return at.toISOString().slice(0, 19).replace(/[:T-]/g, "").replace(/(\d{8})(\d{6})/, "$1-$2");
}

/**
 * A level name nothing else is using.
 *
 * Stamped rather than counted, because the alternative is reading the folder to
 * find the highest number and racing anything that is doing the same. `world-`
 * keeps them together in a listing and says what they are.
 */
export function newLevelName(at: Date, taken: readonly string[] = []): string {
    const stamp = folderStamp(at);
    let candidate = `world-${stamp}`;
    let suffix = 2;
    while (taken.includes(candidate)) candidate = `world-${stamp}-${suffix++}`;
    return candidate;
}

/**
 * Every folder a level is made of, relative to the data directory.
 *
 * Java's other two dimensions are folders beside the level on Paper and Spigot
 * and folders inside it on vanilla, so both layouts are covered by naming the
 * three and letting the ones that do not exist be skipped.
 */
export function levelDirs(edition: MinecraftEdition, level: string): string[] {
    if (edition === "bedrock") return [`worlds/${level}`];
    return [level, ...DIMENSION_SUFFIXES.map((suffix) => `${level}${suffix}`)];
}

/** The directory a level's folders sit in, as an absolute path. */
export function levelParent(edition: MinecraftEdition): string {
    return edition === "bedrock" ? BEDROCK_WORLDS_DIR : DATA_DIR;
}

/** Whether a directory name beside the level is one of its other dimensions,
 *  which the worlds list must not offer as a world of its own. */
export function isDimensionOf(name: string, level: string): boolean {
    return DIMENSION_SUFFIXES.some((suffix) => name === `${level}${suffix}`);
}

/** The variables that decide what a generated world looks like, beside its seed. */
const LEVEL_TYPE_KEY = "LEVEL_TYPE";
const GENERATOR_SETTINGS_KEY = "GENERATOR_SETTINGS";

/** The shape of the world, as `level-type` names it. */
export interface LevelTypeOption {
    readonly value: string;
    readonly label: string;
    readonly detail: string;
}

/**
 * The world shapes Minecraft generates.
 *
 * Java's own `level-type` values, and only those - Bedrock's set is a different
 * one, so this is not offered there rather than offered wrongly.
 */
/** Named because a blueprint asks for it: a minigame's spawn is a lobby, and a
 *  lobby generated as ordinary terrain is the whole reason one looks like an
 *  ordinary server. */
export const FLAT_LEVEL_TYPE = "minecraft:flat";

export const LEVEL_TYPES: readonly LevelTypeOption[] = [
    { value: "minecraft:normal", label: "Normal", detail: "The ordinary world, with every biome in it." },
    { value: "minecraft:large_biomes", label: "Large biomes", detail: "The same world, with each biome several times wider." },
    { value: "minecraft:amplified", label: "Amplified", detail: "Enormous terrain. Hard on the machine, and worth seeing." },
    { value: "minecraft:single_biome_surface", label: "One biome", detail: "The whole overworld is the biome you pick." },
    { value: FLAT_LEVEL_TYPE, label: "Flat", detail: "A featureless plane, for building on." }
];

export const DEFAULT_LEVEL_TYPE = "minecraft:normal";

/** Whether this shape is generated around a biome the operator chooses. */
export function usesBiome(levelType: string): boolean {
    return levelType === "minecraft:single_biome_surface";
}

/** Overworld biomes worth offering as a whole world: the ones that read as a
 *  different place to be, rather than every id the game has. */
export const BIOMES: readonly { readonly value: string; readonly label: string }[] = [
    { value: "minecraft:plains", label: "Plains" },
    { value: "minecraft:forest", label: "Forest" },
    { value: "minecraft:birch_forest", label: "Birch forest" },
    { value: "minecraft:dark_forest", label: "Dark forest" },
    { value: "minecraft:cherry_grove", label: "Cherry grove" },
    { value: "minecraft:desert", label: "Desert" },
    { value: "minecraft:badlands", label: "Badlands" },
    { value: "minecraft:savanna", label: "Savanna" },
    { value: "minecraft:jungle", label: "Jungle" },
    { value: "minecraft:swamp", label: "Swamp" },
    { value: "minecraft:mangrove_swamp", label: "Mangrove swamp" },
    { value: "minecraft:taiga", label: "Taiga" },
    { value: "minecraft:snowy_taiga", label: "Snowy taiga" },
    { value: "minecraft:ice_spikes", label: "Ice spikes" },
    { value: "minecraft:mushroom_fields", label: "Mushroom fields" },
    { value: "minecraft:ocean", label: "Ocean" }
];

export const DEFAULT_BIOME = "minecraft:plains";

export function isLevelType(value: string): boolean {
    return LEVEL_TYPES.some((entry) => entry.value === value);
}

export function isBiome(value: string): boolean {
    return BIOMES.some((entry) => entry.value === value);
}

/**
 * What a chosen shape sets, as the image's environment.
 *
 * Both variables are always written, blank included: these are set on a server
 * that already exists as well as on a new one, and leaving the old value behind
 * would generate the previous shape's world under the new shape's name.
 */
export function levelTypeEnv(
    edition: MinecraftEdition,
    levelType: string,
    biome: string,
    settings?: string
): Record<string, string> {
    // Bedrock names its world shapes differently and this offers Java's, so there
    // is nothing here to set for it.
    if (edition === "bedrock" || !isLevelType(levelType)) return {};
    return {
        [LEVEL_TYPE_KEY]: levelType,
        // A caller that has the settings from the world itself passes them, and they
        // win: a chosen biome describes a world about to be generated, where these
        // describe one that already exists.
        [GENERATOR_SETTINGS_KEY]:
            settings ?? (usesBiome(levelType) && isBiome(biome) ? JSON.stringify({ biome }) : "")
    };
}

/** The file every generated level has and nothing else in the data directory
 *  does. What makes a folder a world is that the game wrote this into it. */
export const LEVEL_MARKER = "level.dat";

/**
 * How to find the levels: the folders holding a level marker.
 *
 * Not a listing of the data directory. Beside the world the image keeps `logs`,
 * `plugins`, `mods`, `libraries`, `cache` and a dozen more, and no list of names
 * to skip stays true across two editions and seven server softwares - the first
 * one it did not know about would be offered as a world somebody could delete.
 * The marker is the game's own answer to the question.
 */
export function levelMarkerArgv(edition: MinecraftEdition): string[] {
    return ["find", levelParent(edition), "-mindepth", "2", "-maxdepth", "2", "-name", LEVEL_MARKER];
}

/**
 * The levels behind those markers: each folder once, and never a folder that is
 * another level's Nether or End - Paper writes a marker into those too, and
 * listing them would offer half of one world as three.
 */
export function levelsFromMarkers(edition: MinecraftEdition, output: string): string[] {
    const found = [
        ...new Set(
            parseListing(output)
                .map((line) => line.split("/").slice(-2)[0] ?? "")
                .filter((name) => isLevelName(name))
        )
    ];
    if (edition === "bedrock") return found.sort((a, b) => a.localeCompare(b));
    return found
        .filter((entry) => !found.some((other) => other !== entry && isDimensionOf(entry, other)))
        .sort((a, b) => a.localeCompare(b));
}

/**
 * What an unpacked archive holds and where each folder has to end up.
 *
 * An archive carries the level under whatever it was called when it was taken,
 * and a restore never puts it back under that name - it lands as a new level, so
 * the running server's own folder is left alone. The dimensions have to follow
 * the same rename or the server generates fresh ones and the old Nether is
 * orphaned beside them.
 */
export function restorePlan(
    edition: MinecraftEdition,
    entries: readonly string[],
    level: string
): { readonly from: string; readonly to: string }[] {
    const named = entries.filter((entry) => isLevelName(entry));
    if (edition === "bedrock") {
        // One level per archive; the name inside it is whatever it was called.
        const source = named[0];
        return source ? [{ from: source, to: level }] : [];
    }
    const primary = named.find((entry) => !named.some((other) => other !== entry && isDimensionOf(entry, other)));
    if (!primary) return [];
    return named.flatMap((entry) => {
        if (entry === primary) return [{ from: entry, to: level }];
        const suffix = DIMENSION_SUFFIXES.find((candidate) => entry === `${primary}${candidate}`);
        return suffix ? [{ from: entry, to: `${level}${suffix}` }] : [];
    });
}

/**
 * Sizes read from `du -sk`, as bytes per path.
 *
 * One walk for every folder rather than one per world: `du` prints a line per
 * argument, and the path it echoes back is the one it was given, so the caller
 * can put each figure against the folder it asked about.
 */
export function parseDuLines(output: string): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const line of output.split("\n")) {
        const match = /^(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const kilobytes = Number.parseInt(match[1] as string, 10);
        if (Number.isFinite(kilobytes)) sizes.set(match[2] as string, kilobytes * 1024);
    }
    return sizes;
}

/** One archive as `stat` reported it. */
export interface StatLine {
    readonly name: string;
    readonly sizeBytes: number;
}

/**
 * Archives from `stat -c "%s %n"`, newest first.
 *
 * The size comes from `stat` and the time comes from the name, not from the
 * file's own timestamp: a copy, a restore or a filesystem that was restored
 * itself all move mtime, and when a backup was taken is the one thing about it
 * nobody may be told wrongly.
 */
export function parseBackupList(output: string): StatLine[] {
    const rows: StatLine[] = [];
    for (const line of output.split("\n")) {
        const match = /^(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const name = (match[2] as string).split("/").pop() ?? "";
        if (!isBackupName(name)) continue;
        rows.push({ name, sizeBytes: Number.parseInt(match[1] as string, 10) });
    }
    return rows.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * The seed in a `seed` reply, which the server answers as `Seed: [123]`.
 *
 * Worth asking for rather than only showing what was configured. A world created
 * without one was generated from a seed all the same - the server picked it - and
 * an operator looking at a field that says "Random" has no way to tell a world
 * that really was random from one where the setting never took. The number itself
 * settles it, and it is also the only way to make that world again.
 */
export function parseSeedReply(output: string): string | null {
    const match = /Seed:\s*\[(-?\d{1,20})\]/i.exec(output);
    return match ? (match[1] as string) : null;
}

/** Lines of a `ls -1A` listing, without the blanks. */
export function parseListing(output: string): string[] {
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * The map: backing it up, putting one back, and starting a new one.
 *
 * Everything here runs inside the server's own container, which is the only place
 * that can see the world volume - so a backup is a `tar` next to the world rather
 * than a copy pulled across the network, and it costs the disk the server already
 * has. That is worth being plain about and the screen is: an archive beside the
 * world survives a mistake, not a dead disk, which is what the download is for.
 *
 * Nothing here edits the level the server is playing on. A restore unpacks beside
 * it and a new world is generated into a folder of its own; what actually changes
 * which map is served is the `LEVEL` variable and the restart that follows. The
 * reason is in world.ts: a running server writes its world right up to the moment
 * it shuts down, so anything that swaps files underneath it loses the race with
 * the shutdown save.
 *
 * `docker exec` needs a container that is up, so all of this needs the server
 * running - including backing it up. Callers say so rather than failing blankly.
 */

import * as world from "./world";
import { prisma } from "@polaris/db";
import { deployApplication } from "@/lib/deploy-service";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import { withServerContainer, type MinecraftEdition, type ServerContainer } from "./service";

/** How long to give a Bedrock server to finish holding its save before the
 *  archive is written. It answers into its own log rather than to the caller, so
 *  there is nothing to wait on - only a pause long enough to be worth having. */
const BEDROCK_SAVE_HOLD_MS = 1500;

/** Paths per `du` call. The daemon takes 32 argv elements and three are spent on
 *  the command itself, so this leaves room without ever being the thing that
 *  fails. */
const DU_BATCH = 24;

/** One map on disk. */
export interface WorldEntry {
    readonly level: string;
    /** Whether this is the one the server boots into. */
    readonly current: boolean;
    /** What it takes up, when it could be measured. */
    readonly sizeBytes: number | null;
}

/** One archive in the server's backup folder. */
export interface WorldBackup {
    readonly name: string;
    readonly sizeBytes: number;
    readonly createdAt: string;
}

/** Everything the World screen shows. */
export interface WorldView {
    readonly edition: MinecraftEdition;
    /** The level the server boots into, whether or not it exists yet. */
    readonly level: string;
    /** The seed the next new world would be generated from. Blank means random. */
    readonly seed: string;
    /** The seed the map being played was actually generated from, as the server
     *  reports it. Null when it could not be asked - a stopped server, or Bedrock,
     *  which answers into its own console rather than to the caller. */
    readonly worldSeed: string | null;
    /** Whether a player's things can be carried onto a new map on this edition. */
    readonly carriesPlayers: boolean;
    readonly worlds: readonly WorldEntry[];
    readonly backups: readonly WorldBackup[];
    /** Why the lists are empty, when the container could not be read. */
    readonly message: string | null;
}

/** What the map is called and what it would be generated from, from Polaris' own
 *  records - so a stopped server still says which world it would come back on. */
async function readWorldSettings(
    ownerId: string,
    applicationId: string,
    edition: MinecraftEdition
): Promise<{ level: string; seed: string }> {
    const vars = await listEnvVars("application", applicationId, ownerId).catch(() => []);
    const value = (key: string): string => vars.find((item) => item.key === key)?.value?.trim() ?? "";
    const level = value(world.levelEnvKey(edition));
    return { level: world.isLevelName(level) ? level : world.defaultLevel(edition), seed: value(world.seedEnvKey(edition)) };
}

/** The application behind an install, refusing one that was never deployed. */
async function applicationOf(ownerId: string, installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    if (!install) throw new Error("Server not found");
    if (!install.applicationId) throw new Error("This server has not been deployed yet");
    return install.applicationId;
}

/**
 * The maps on disk and the archives beside them.
 *
 * The settings half is a database read and always answers; the disk half needs
 * the container, so a stopped server reports what it would boot into and says why
 * there is nothing else. Never throws for that case - it is the ordinary state of
 * a server somebody stopped, not an error worth a blank screen.
 */
export async function readWorldView(ownerId: string, installedAppId: string): Promise<WorldView> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const { level, seed } = await readWorldSettings(ownerId, server.applicationId, server.edition);
        const base = {
            edition: server.edition,
            level,
            seed,
            carriesPlayers: world.canCarryPlayers(server.edition)
        };
        try {
            // Asked before anything is read, because a command against a container
            // that is down comes back empty rather than angry - and an empty list
            // reads as "this server has no backups", which is the one thing it must
            // not say about a server nobody has been able to look at.
            const reachable = await server.run(["ls", "-1A", "--", world.DATA_DIR]);
            if (reachable.code !== 0) {
                return {
                    ...base,
                    worlds: [],
                    backups: [],
                    worldSeed: null,
                    message: "The server has to be running to read or change its worlds. Start it first."
                };
            }
            const [worlds, backups, worldSeed] = await Promise.all([
                listWorlds(server, level),
                listBackups(server),
                readWorldSeed(server)
            ]);
            return { ...base, worlds, backups, worldSeed, message: null };
        } catch (caught) {
            return {
                ...base,
                worlds: [],
                backups: [],
                worldSeed: null,
                message: caught instanceof Error ? caught.message : "Could not read the server's files"
            };
        }
    });
}

/**
 * The seed the map being played was actually generated from.
 *
 * Asked of the game rather than read from the setting, because the setting only
 * says what the next world would use: a world created without a seed still has
 * one, and "Random" on a screen is not an answer to "which world is this".
 *
 * Java answers over RCON. Bedrock has no RCON and answers into its own console,
 * so there this is null and the screen says what was configured instead.
 */
async function readWorldSeed(server: ServerContainer): Promise<string | null> {
    if (server.edition === "bedrock") return null;
    return server.say(["seed"]).then(world.parseSeedReply, () => null);
}

/** The maps on disk, found by the marker the game writes into each of them. A
 *  server that has never generated one answers with nothing, which is the
 *  ordinary state of a server that has just been created rather than a failure. */
async function readLevels(server: ServerContainer): Promise<string[]> {
    const found = await server.run(world.levelMarkerArgv(server.edition));
    return world.levelsFromMarkers(server.edition, found.output);
}

/** Every level in the server's data directory, with what each takes up. */
async function listWorlds(server: ServerContainer, current: string): Promise<WorldEntry[]> {
    const levels = await readLevels(server);
    const listing = await server.run(["ls", "-1A", "--", world.levelParent(server.edition)]);
    const present = new Set(listing.code === 0 ? world.parseListing(listing.output) : []);

    // One walk per batch rather than one per world: du echoes back the path it was
    // given, so each figure lands against the folder it was asked about.
    const paths = levels.flatMap((level) =>
        world
            .levelDirs(server.edition, level)
            .filter((dir) => present.has(dir.split("/").pop() as string))
            .map((dir) => `${world.DATA_DIR}/${dir}`)
    );
    const sizes = new Map<string, number>();
    for (let index = 0; index < paths.length; index += DU_BATCH) {
        const batch = paths.slice(index, index + DU_BATCH);
        const measured = await server.run(["du", "-sk", "--", ...batch]);
        // A world being written while it is measured makes du complain and exit
        // non-zero with the figures it did get, so its output is read either way.
        for (const [path, bytes] of world.parseDuLines(measured.output)) sizes.set(path, bytes);
    }

    return levels.map((level) => {
        const dirs = world.levelDirs(server.edition, level).map((dir) => `${world.DATA_DIR}/${dir}`);
        const measured = dirs.map((dir) => sizes.get(dir)).filter((bytes): bytes is number => bytes !== undefined);
        return {
            level,
            current: level === current,
            sizeBytes: measured.length > 0 ? measured.reduce((total, bytes) => total + bytes, 0) : null
        };
    });
}

/** The archives this feature has written, newest first. */
async function listBackups(server: ServerContainer): Promise<WorldBackup[]> {
    const found = await server.run([
        "find",
        world.BACKUP_DIR,
        "-maxdepth",
        "1",
        "-type",
        "f",
        "-name",
        "*.tar.gz",
        "-exec",
        "stat",
        "-c",
        "%s %n",
        "{}",
        "+"
    ]);
    // No backup folder yet is not a failure; it is a server nobody has backed up.
    if (found.code !== 0 && found.output.trim().length > 0 && !/no such file/i.test(found.output)) {
        return [];
    }
    return world.parseBackupList(found.output).map((row) => ({
        name: row.name,
        sizeBytes: row.sizeBytes,
        createdAt: (world.backupTakenAt(row.name) ?? new Date(0)).toISOString()
    }));
}

/**
 * Copy the world into an archive beside it.
 *
 * The world is flushed and autosave held first, so what is captured is a world
 * between writes rather than one halfway through one. Best effort: a server that
 * is still generating its world has nothing to flush and is not writing either,
 * and refusing to back it up over a command it cannot answer yet would be worse
 * than the archive it would have produced. Autosave is always turned back on.
 */
export async function createWorldBackup(ownerId: string, installedAppId: string): Promise<WorldBackup> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const { level } = await readWorldSettings(ownerId, server.applicationId, server.edition);
        const listing = await server.runOk(
            ["ls", "-1A", "--", world.levelParent(server.edition)],
            "Could not read the server's files"
        );
        const present = new Set(world.parseListing(listing));
        const dirs = world.levelDirs(server.edition, level).filter((dir) => present.has(dir.split("/").pop() as string));
        if (dirs.length === 0) throw new Error("There is no world to back up yet - start the server and let it generate one");

        await server.runOk(["mkdir", "-p", "--", world.BACKUP_DIR], "Could not create the backup folder");
        await holdSave(server);
        const at = new Date();
        const name = world.backupName(at);
        try {
            await server.runOk(
                ["tar", "-czf", `${world.BACKUP_DIR}/${name}`, "-C", world.DATA_DIR, ...dirs],
                "Could not write the backup"
            );
        } finally {
            await resumeSave(server);
        }
        const stat = await server.run(["stat", "-c", "%s", "--", `${world.BACKUP_DIR}/${name}`]);
        return {
            name,
            sizeBytes: Number.parseInt(stat.output.trim(), 10) || 0,
            createdAt: at.toISOString()
        };
    });
}

/** Stop the server writing the world, so what is on disk stops moving. */
async function holdSave(server: ServerContainer): Promise<void> {
    try {
        if (server.edition === "bedrock") {
            await server.say(["save", "hold"]);
            await new Promise((resolve) => setTimeout(resolve, BEDROCK_SAVE_HOLD_MS));
            return;
        }
        await server.say(["save-off"]);
        await server.say(["save-all", "flush"]);
    } catch {
        // Nothing to hold: the server is not answering, which also means it is not
        // writing. The archive is taken either way.
    }
}

/** Let it write again, whatever happened in between. */
async function resumeSave(server: ServerContainer): Promise<void> {
    await (server.edition === "bedrock" ? server.say(["save", "resume"]) : server.say(["save-on"])).catch(
        () => undefined
    );
}

/** Take an archive off the server. */
export async function deleteWorldBackup(ownerId: string, installedAppId: string, name: string): Promise<void> {
    if (!world.isBackupName(name)) throw new Error("That is not a backup of this server");
    await withServerContainer(ownerId, installedAppId, (server) =>
        server.runOk(["rm", "-f", "--", `${world.BACKUP_DIR}/${name}`], "Could not delete the backup")
    );
}

/** Where an archive sits inside the container, for the route that streams it out. */
export function backupPathInContainer(name: string): string {
    if (!world.isBackupName(name)) throw new Error("That is not a backup of this server");
    return `${world.BACKUP_DIR}/${name}`;
}

/**
 * Put an archived world back.
 *
 * It lands as a new level rather than over the one being played, so the running
 * server is untouched until it restarts onto it - and the map it was on is still
 * there afterwards, which is what makes restoring the wrong backup survivable.
 */
export async function restoreWorldBackup(
    ownerId: string,
    installedAppId: string,
    name: string,
    actorId: string
): Promise<{ level: string }> {
    if (!world.isBackupName(name)) throw new Error("That is not a backup of this server");
    const level = await withServerContainer(ownerId, installedAppId, async (server) => {
        const parent = world.levelParent(server.edition);
        const staging = server.edition === "bedrock" ? `${world.STAGING_DIR}/worlds` : world.STAGING_DIR;

        await server.runOk(["rm", "-rf", "--", world.STAGING_DIR], "Could not clear the restore folder");
        await server.runOk(["mkdir", "-p", "--", world.STAGING_DIR], "Could not create the restore folder");
        try {
            await server.runOk(
                ["tar", "-xzf", `${world.BACKUP_DIR}/${name}`, "-C", world.STAGING_DIR],
                "Could not unpack the backup"
            );
            const unpacked = world.parseListing(
                await server.runOk(["ls", "-1A", "--", staging], "The backup does not hold a world")
            );
            const listing = await server.run(["ls", "-1A", "--", parent]);
            const taken = listing.code === 0 ? world.parseListing(listing.output) : [];
            const target = world.newLevelName(new Date(), taken);
            const plan = world.restorePlan(server.edition, unpacked, target);
            if (plan.length === 0) throw new Error("That backup does not hold a world this server can use");

            await server.runOk(["mkdir", "-p", "--", parent], "Could not create the worlds folder");
            for (const move of plan) {
                await server.runOk(
                    ["mv", "--", `${staging}/${move.from}`, `${parent}/${move.to}`],
                    "Could not put the world in place"
                );
            }
            return target;
        } finally {
            await server.run(["rm", "-rf", "--", world.STAGING_DIR]);
        }
    });
    await switchLevel(ownerId, installedAppId, level, actorId);
    return { level };
}

/**
 * Start a new map.
 *
 * The server generates it on its next boot, into a folder of its own, from the
 * seed it is given - so the map that was being played is still on disk and can be
 * switched back to. What a player is carrying is a copy made before the restart:
 * on Java their bag, their stats and their advancements are folders inside the
 * level, and putting them in the new one before it exists means the fresh world
 * is generated around them. Bedrock keeps all of it inside the level database,
 * where it cannot be separated from the terrain, so there it is not offered.
 */
export async function newWorld(
    ownerId: string,
    installedAppId: string,
    input: { seed?: string; levelType?: string; biome?: string; keepPlayers: boolean },
    actorId: string
): Promise<{ level: string; carried: boolean }> {
    const seed = input.seed?.trim() ?? "";
    if (seed.length > 0 && !world.isSeed(seed)) throw new Error("That seed will not do");
    const levelType = input.levelType ?? world.DEFAULT_LEVEL_TYPE;
    const biome = input.biome ?? world.DEFAULT_BIOME;
    if (!world.isLevelType(levelType)) throw new Error("That is not a world type");
    if (world.usesBiome(levelType) && !world.isBiome(biome)) throw new Error("That is not a biome");

    const planned = await withServerContainer(ownerId, installedAppId, async (server) => {
        const { level: current } = await readWorldSettings(ownerId, server.applicationId, server.edition);
        const listing = await server.run(["ls", "-1A", "--", world.levelParent(server.edition)]);
        const taken = listing.code === 0 ? world.parseListing(listing.output) : [];
        const target = world.newLevelName(new Date(), taken);
        const keep = input.keepPlayers && world.canCarryPlayers(server.edition);

        if (keep) {
            // Written out first, or what is copied is the last save rather than
            // what everyone is holding right now.
            await server.say(["save-all", "flush"]).catch(() => undefined);
            await server.runOk(["mkdir", "-p", "--", `${world.DATA_DIR}/${target}`], "Could not create the new world");
            for (const folder of world.PLAYER_DATA_DIRS) {
                // A server that has none of a folder yet is the ordinary case for a
                // young world, so a copy that finds nothing is not a failure.
                await server.run([
                    "cp",
                    "-a",
                    "--",
                    `${world.DATA_DIR}/${current}/${folder}`,
                    `${world.DATA_DIR}/${target}/`
                ]);
            }
        }
        await setEnvVars("application", server.applicationId, ownerId, [
            { key: world.levelEnvKey(server.edition), value: target, isSecret: false },
            // Cleared rather than left behind when no seed was given: the stored one
            // would otherwise generate the same map again and read as a bug.
            { key: world.seedEnvKey(server.edition), value: seed, isSecret: false },
            // Written every time, blank included, for the same reason: a shape left
            // over from the last world would quietly generate the previous one.
            ...Object.entries(world.levelTypeEnv(server.edition, levelType, biome)).map(([key, value]) => ({
                key,
                value,
                isSecret: false
            }))
        ]);
        return { target, keep };
    });

    await deployApplication(await applicationOf(ownerId, installedAppId), ownerId, actorId);
    return { level: planned.target, carried: planned.keep };
}

/** Boot the server onto a map it already has. */
export async function switchLevel(
    ownerId: string,
    installedAppId: string,
    level: string,
    actorId: string
): Promise<void> {
    if (!world.isLevelName(level)) throw new Error("That is not a world on this server");
    const applicationId = await applicationOf(ownerId, installedAppId);
    const edition = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!(await readLevels(server)).includes(level)) throw new Error("That world is not on this server");
        return server.edition;
    });
    await setEnvVars("application", applicationId, ownerId, [
        { key: world.levelEnvKey(edition), value: level, isSecret: false }
    ]);
    await deployApplication(applicationId, ownerId, actorId);
}

/** Delete a map the server is not on. The one it boots into is refused here
 *  rather than in the screen, because that is the mistake worth being unable to
 *  make from anywhere. */
export async function deleteLevel(ownerId: string, installedAppId: string, level: string): Promise<void> {
    if (!world.isLevelName(level)) throw new Error("That is not a world on this server");
    await withServerContainer(ownerId, installedAppId, async (server) => {
        const { level: current } = await readWorldSettings(ownerId, server.applicationId, server.edition);
        if (level === current) throw new Error("That is the world the server plays on - switch to another one first");
        const dirs = world.levelDirs(server.edition, level).map((dir) => `${world.DATA_DIR}/${dir}`);
        await server.runOk(["rm", "-rf", "--", ...dirs], "Could not delete the world");
    });
}

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
import * as policy from "./backup-policy";
import { OWNED_PROJECTS } from "@/lib/apps/games-create";
import { appHasCapability, findApp } from "@/lib/apps/catalog";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import { createNotification } from "@/lib/notification-service";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { withServerContainer, type MinecraftEdition, type ServerContainer } from "./service";

/** How long to give a Bedrock server to finish holding its save before the
 *  archive is written. It answers into its own log rather than to the caller, so
 *  there is nothing to wait on - only a pause long enough to be worth having. */
const BEDROCK_SAVE_HOLD_MS = 1500;

/** Paths per `du` call. The daemon takes 32 argv elements and three are spent on
 *  the command itself, so this leaves room without ever being the thing that
 *  fails. */
const DU_BATCH = 24;

/** How long to give a container to come up when something here needs it. Only the
 *  filesystem is being waited on, not the game, so this is a container starting
 *  rather than a world loading - seconds, with room for a slow machine. */
const START_TIMEOUT_MS = 60_000;

/** Between attempts. Each one opens the target's ports and closes them again, so
 *  it is not free enough to do continuously. */
const START_POLL_MS = 2000;

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
    /** How often copies are taken and how many are kept. */
    readonly policy: policy.BackupPolicy;
    /** What the archives take up together, against the budget when there is one. */
    readonly backupBytes: number;
    /** When the next scheduled copy is due, or null when none is scheduled. */
    readonly nextBackupAt: string | null;
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
 * Make a folder inside the data volume that the server itself has to write into.
 *
 * `docker exec` does not run as the account the game runs as - the image comes up
 * as root and drops to its own user before it launches Java - so a folder made
 * from here is a folder the server cannot write a single file into. What that
 * costs is not a damaged world, it is a server that never boots again: the first
 * thing Minecraft does with a level is take `session.lock` inside it, and a
 * folder it may not write is an `AccessDeniedException` and a container that
 * restarts forever, on a world nobody can switch away from without knowing why.
 *
 * So the folder is handed over as soon as it is made - to whoever owns the volume
 * the game has been writing to all along, and writable by them whatever umask the
 * exec carried. Both are best effort: an exec that already runs as that user is
 * giving the folder the owner it has, which changes nothing, and neither call can
 * leave it worse than `mkdir` left it.
 */
async function makeServerDir(server: ServerContainer, path: string, failure: string): Promise<void> {
    await server.runOk(["mkdir", "-p", "--", path], failure);
    const stat = await server.run(["stat", "-c", "%u:%g", "--", world.DATA_DIR]);
    const owner = stat.output.trim();
    if (stat.code === 0 && /^\d+:\d+$/.test(owner)) await server.run(["chown", owner, "--", path]);
    await server.run(["chmod", "u+rwx", "--", path]);
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
        const rules = await getBackupPolicy(installedAppId);
        const base = {
            edition: server.edition,
            level,
            seed,
            carriesPlayers: world.canCarryPlayers(server.edition),
            policy: rules
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
                    backupBytes: 0,
                    nextBackupAt: null,
                    message: "The server has to be running to read or change its worlds. Start it first."
                };
            }
            const [worlds, backups, worldSeed] = await Promise.all([
                listWorlds(server, level),
                listBackups(server),
                readWorldSeed(server)
            ]);
            const newest = backups[0] ? new Date(backups[0].createdAt) : null;
            return {
                ...base,
                worlds,
                backups,
                worldSeed,
                backupBytes: policy.totalBackupBytes(backups),
                nextBackupAt: policy.nextBackupAt(rules, newest)?.toISOString() ?? null,
                message: null
            };
        } catch (caught) {
            return {
                ...base,
                worlds: [],
                backups: [],
                worldSeed: null,
                backupBytes: 0,
                nextBackupAt: null,
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
        const taken = await writeBackup(ownerId, server);
        // Retention is enforced where a copy is made rather than on a timer, so a
        // manual backup cannot be the one that pushes the disk past its budget.
        await pruneBackups(server, policy.readBackupPolicy(readInstallConfig(
            (await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } }))?.config
        )));
        return taken;
    });
}

/** The archive itself, on a container that is already open. Shared by the button
 *  and by the sweep, so a scheduled copy and one somebody asked for are the same
 *  act rather than two that drift. */
async function writeBackup(ownerId: string, server: ServerContainer): Promise<WorldBackup> {
    const { level } = await readWorldSettings(ownerId, server.applicationId, server.edition);
    const listing = await server.runOk(
        ["ls", "-1A", "--", world.levelParent(server.edition)],
        "Could not read the server's files"
    );
    const present = new Set(world.parseListing(listing));
    const dirs = world.levelDirs(server.edition, level).filter((dir) => present.has(dir.split("/").pop() as string));
    if (dirs.length === 0) {
        throw new Error("There is no world to back up yet - start the server and let it generate one");
    }

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
}

/**
 * Write the world out before the server is stopped.
 *
 * Minecraft saves on a graceful shutdown, and a graceful shutdown is not what
 * every stop turns out to be: a container that does not finish shutting down in
 * time is killed, and what is killed is the last few minutes everyone played.
 * Flushing first costs a second and makes the difference not matter.
 *
 * Best effort and never throws. This runs on the path that stops a server, and a
 * server that will not answer is exactly one that needs stopping - refusing to
 * stop it because it could not be asked to save would be the worse failure.
 */
export async function flushWorldForStop(ownerId: string, installedAppId: string): Promise<boolean> {
    try {
        return await withServerContainer(ownerId, installedAppId, async (server) => {
            if (!server.running) return false;
            await server.say(server.edition === "bedrock" ? ["save", "hold"] : ["save-all", "flush"]);
            // Bedrock was asked to hold its save, not to finish one; let it.
            if (server.edition === "bedrock") {
                await new Promise((resolve) => setTimeout(resolve, BEDROCK_SAVE_HOLD_MS));
                await server.say(["save", "resume"]).catch(() => undefined);
            }
            return true;
        });
    } catch {
        return false;
    }
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

            await makeServerDir(server, parent, "Could not create the worlds folder");
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
 *
 * `fromMap` is the case where none of that applies: the world is about to be
 * fetched already built, so the seed and the shape describe nothing. They are not
 * merely useless written down - a blueprint's flat lobby setting on a map server
 * is `level-type=minecraft:flat` with no layers under it, which the server reports
 * as an error on every boot of a world it was never going to generate.
 */
export async function newWorld(
    ownerId: string,
    installedAppId: string,
    input: {
        seed?: string;
        levelType?: string;
        biome?: string;
        keepPlayers: boolean;
        fromMap?: boolean;
        /** The generator a map brings with it, for one whose world file does not
         *  carry its own. See `MapGenerator`. */
        mapGenerator?: { levelType: string; settings?: string };
    },
    actorId: string
): Promise<{ level: string; carried: boolean }> {
    const generating = input.fromMap !== true;
    const seed = input.seed?.trim() ?? "";
    const levelType = input.levelType ?? world.DEFAULT_LEVEL_TYPE;
    const biome = input.biome ?? world.DEFAULT_BIOME;
    // Only checked when it is going to be used. A map reset carries the
    // blueprint's own defaults through this call, and refusing one of them would
    // be refusing the reset over a value that is never written anywhere.
    if (generating) {
        if (seed.length > 0 && !world.isSeed(seed)) throw new Error("That seed will not do");
        if (!world.isLevelType(levelType)) throw new Error("That is not a world type");
        if (world.usesBiome(levelType) && !world.isBiome(biome)) throw new Error("That is not a biome");
    }

    // Copying what people are carrying reads the old level off the disk, which
    // only the container can see. Refusing a stopped server here told somebody to
    // go and press Start themselves and come back - a step with one possible
    // answer, so it is taken for them.
    if (input.keepPlayers) await startForFileAccess(ownerId, installedAppId);

    const planned = await withServerContainer(ownerId, installedAppId, async (server) => {
        const { level: current } = await readWorldSettings(ownerId, server.applicationId, server.edition);
        const listing = await server.run(["ls", "-1A", "--", world.levelParent(server.edition)]);
        const taken = listing.code === 0 ? world.parseListing(listing.output) : [];
        const target = world.newLevelName(new Date(), taken);
        // Never onto a map, and this is not a preference - it is the one thing that
        // stops the map arriving at all.
        //
        // Carrying players forward means creating the new level folder now and
        // copying their data into it. The image downloads the world archive only
        // when that folder does not exist, so creating it first is exactly the
        // instruction "there is already a world here, do not fetch one" - and the
        // server boots into an empty flat void with the map's settings on it and no
        // map. Which is precisely what it did: spawn at y=-63, and straight through
        // the floor.
        //
        // A map is also the case where carrying least belongs. It is built around
        // its own spawn and its own idea of what a player starts with, and the
        // inventories from the world before it are not part of that.
        const keep = input.keepPlayers && world.canCarryPlayers(server.edition) && input.fromMap !== true;

        if (keep) {
            // Written out first, or what is copied is the last save rather than
            // what everyone is holding right now.
            await server.say(["save-all", "flush"]).catch(() => undefined);
            await makeServerDir(server, `${world.DATA_DIR}/${target}`, "Could not create the new world");
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
            // A new one every time, and never an empty value: the stored seed
            // would otherwise generate the same map again, and an empty one
            // leaves the image to decide what "no seed" means - which for at
            // least one of them is zero, a real seed that gives the same world
            // to everybody who ever asks for a random one.
            {
                key: world.seedEnvKey(server.edition),
                value: generating ? seed || world.randomSeed() : "",
                isSecret: false
            },
            // Written every time, blank included, for the same reason: a shape left
            // over from the last world would quietly generate the previous one.
            //
            // A world that arrives already built is described by none of it, and it
            // goes back to the default rather than being left alone - a blueprint's
            // flat lobby setting inherited by a map server is a flat level type
            // with no layers under it, which the server reports as an error on
            // every boot of a world it will never generate.
            //
            // Unless the map is older than 1.16, when a world began carrying its own
            // generator. There is nothing in the file for the server to read, so it
            // uses this - and the default grows ordinary terrain through a map that
            // was built in the void.
            ...Object.entries(
                generating
                    ? world.levelTypeEnv(server.edition, levelType, biome)
                    : input.mapGenerator
                      ? world.levelTypeEnv(
                            server.edition,
                            input.mapGenerator.levelType,
                            world.DEFAULT_BIOME,
                            input.mapGenerator.settings ?? ""
                        )
                      : world.levelTypeEnv(server.edition, world.DEFAULT_LEVEL_TYPE, world.DEFAULT_BIOME)
            ).map(([key, value]) => ({ key, value, isSecret: false }))
        ]);
        return { target, keep };
    });

    await deployApplication(await applicationOf(ownerId, installedAppId), ownerId, actorId);
    return { level: planned.target, carried: planned.keep };
}

/**
 * Put the config a different Minecraft wrote out of the way, so this one can boot.
 *
 * A reset changes the release a server runs and deliberately leaves the volume
 * alone, which is right for everything on it except the settings the previous
 * release wrote about itself. Those only break in one direction and they break
 * hard: a newer Paper writes the sentinel `default` into fields an older one reads
 * as numbers, and the older one throws while it is still loading its own
 * configuration - a crash before the world is even opened, on a container the
 * deploy restarts forever. See `world.VERSIONED_CONFIG` for what moves and what
 * pointedly does not.
 *
 * Moved rather than deleted, for the reason a reset keeps the old level: an
 * operator who had tuned something has it, in a folder beside the world, and can
 * take it back. Nothing here deletes anything.
 *
 * Unconditional, and that is the correction rather than the shortcut. Comparing
 * the release the server is on against the one it is moving to looked precise and
 * was blind to the case it existed for: a server already crash-looping on the
 * release it was being reset onto compared equal to itself, and the settings
 * breaking it stayed exactly where they were. What is on disk is not what the
 * server is running - it is what some earlier release wrote - so no comparison of
 * releases can decide this.
 *
 * Never throws. A server this could not reach is a server that may be about to
 * crash-loop, and the health sweep is what says so - failing the reset here would
 * only mean it never got the new release either.
 */
export async function setAsideVersionedConfig(ownerId: string, installedAppId: string): Promise<string | null> {
    try {
        // The container has to be up for an exec to reach the volume, and a server
        // being reset is quite often one somebody had already stopped.
        await startForFileAccess(ownerId, installedAppId);
        return await withServerContainer(ownerId, installedAppId, async (server) => {
            // Bedrock has no config directory and rewrites its properties from the
            // environment, so there is nothing here that a release can spoil.
            if (server.edition === "bedrock") return null;

            const listing = await server.run(["ls", "-1A", "--", world.DATA_DIR]);
            if (listing.code !== 0) return null;
            const present = new Set(world.parseListing(listing.output));
            const moving = world.VERSIONED_CONFIG.filter((entry) => present.has(entry));
            if (moving.length === 0) return null;

            const aside = `${world.CONFIG_ASIDE_DIR}/${world.folderStamp(new Date())}`;
            await makeServerDir(server, aside, "Could not set the old config aside");
            // One move for the whole set rather than one each: on a container that
            // is crash-looping every exec is a race against the next restart, and
            // `mv` takes a directory as its last argument for exactly this.
            const moved = await server.run([
                "mv",
                "--",
                ...moving.map((entry) => `${world.DATA_DIR}/${entry}`),
                aside
            ]);
            return moved.code === 0 ? aside : null;
        });
    } catch {
        return null;
    }
}

/**
 * Take off the disk the plugins this server is no longer meant to run.
 *
 * Taking a plugin off the list is not taking it off the server. The image installs
 * what the list names and has never removed anything, so a plugin from an earlier
 * life keeps loading, keeps its settings folder, and keeps doing whatever it was
 * configured to do - which is how a bed wars map ended up running a bed wars plugin
 * that still held an arena pointing at a world three resets old. The plugin loaded
 * the world, the world had been written by a newer Minecraft than the map's pinned
 * release, and the server refused it and stopped. Every boot, forever.
 *
 * Only plugins Polaris puts on servers itself are candidates, and only the ones the
 * new list does not ask for. Anything installed from the Mods screen is somebody
 * else's decision and is not touched by a change of game.
 *
 * Moved, never deleted, and the settings folder beside it is left alone: whatever
 * was configured is still there if the plugin comes back.
 */
export async function setAsideRetiredPlugins(
    ownerId: string,
    installedAppId: string,
    keep: readonly string[]
): Promise<string | null> {
    const wanted = new Set(keep.map((entry) => entry.toLowerCase()));
    const retired = OWNED_PROJECTS.filter((project) => !wanted.has(project.toLowerCase()));
    if (retired.length === 0) return null;

    try {
        await startForFileAccess(ownerId, installedAppId);
        return await withServerContainer(ownerId, installedAppId, async (server) => {
            // Bedrock runs no plugins at all.
            if (server.edition === "bedrock") return null;

            const listing = await server.run(["ls", "-1A", "--", world.PLUGINS_DIR]);
            if (listing.code !== 0) return null;
            const moving = world
                .parseListing(listing.output)
                .filter((file) => retired.some((project) => world.isPluginOf(file, project)));
            if (moving.length === 0) return null;

            const aside = `${world.PLUGIN_ASIDE_DIR}/${world.folderStamp(new Date())}`;
            await makeServerDir(server, aside, "Could not set the old plugins aside");
            const moved = await server.run([
                "mv",
                "--",
                ...moving.map((file) => `${world.PLUGINS_DIR}/${file}`),
                aside
            ]);
            return moved.code === 0 ? aside : null;
        });
    } catch {
        return null;
    }
}

/**
 * Get the container up, because something here has to read the disk through it.
 *
 * `docker exec` needs a container that is running, and the world volume is only
 * visible from inside one - so a stopped server cannot be read at all. The old
 * answer was to refuse and say "start the server first", which is a step with
 * exactly one possible response and no reason to hand back to the person.
 *
 * The wait is for the container, not for the game: the filesystem is there long
 * before the world has loaded, so this returns as soon as a command runs rather
 * than when players could join. A server that never gets that far is one that
 * cannot start at all, and it says so in those words - the useful thing to know
 * is that it is failing to boot, not that a copy did not happen.
 */
async function startForFileAccess(ownerId: string, installedAppId: string): Promise<void> {
    const reachable = async (): Promise<boolean> =>
        withServerContainer(ownerId, installedAppId, async (server) => {
            const listing = await server.run(["ls", "-1A", "--", world.DATA_DIR]);
            return listing.code === 0;
        }).catch(() => false);

    if (await reachable()) return;
    const applicationId = await applicationOf(ownerId, installedAppId);
    await setApplicationRunning(applicationId, ownerId, true);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
        if (await reachable()) return;
    }
    throw new Error(
        "The server would not start, so what players are carrying could not be copied. Check the console for why, or try again without carrying it across."
    );
}

/** The policy on one server, and how it is written. */
export async function getBackupPolicy(installedAppId: string): Promise<policy.BackupPolicy> {
    const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
    return policy.readBackupPolicy(readInstallConfig(row?.config));
}

export async function setBackupPolicy(installedAppId: string, value: policy.BackupPolicy): Promise<void> {
    await patchInstallConfig(installedAppId, { backupPolicy: value });
}

/**
 * Delete whatever the retention rules no longer keep, and say what went.
 *
 * Run after every backup rather than on a timer of its own: the moment a new
 * archive lands is the moment the count and the budget can be exceeded, and
 * pruning then means the disk never holds more than the operator asked for even
 * for a minute.
 */
async function pruneBackups(server: ServerContainer, rules: policy.BackupPolicy): Promise<string[]> {
    const doomed = policy.backupsToPrune(await listBackups(server), rules);
    const gone: string[] = [];
    for (const name of doomed) {
        const removed = await server.run(["rm", "-f", "--", `${world.BACKUP_DIR}/${name}`]);
        if (removed.code === 0) gone.push(name);
    }
    return gone;
}

/** What one sweep did to one server. */
export interface BackupSweep {
    readonly installedAppId: string;
    readonly name: string | null;
    readonly pruned: readonly string[];
    readonly error: string | null;
}

/**
 * Take the copies that are due across an owner's servers, and prune what has
 * fallen out of retention.
 *
 * Swept from the cron and again whenever the screen is read, exactly as the
 * schedules are: an instance with no cron configured should still keep the
 * backups it was promised while somebody is looking, and the cron is what makes
 * that true at four in the morning too.
 *
 * A server that is stopped is skipped rather than failed. `docker exec` needs a
 * container that is up, so a stopped server cannot be archived at all - and a
 * nightly notification saying so about a server somebody deliberately turned off
 * is noise that teaches people to ignore the ones that matter.
 */
export async function sweepWorldBackups(ownerId: string, now: Date = new Date()): Promise<BackupSweep[]> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, name: true, catalogId: true, config: true }
    });
    const swept: BackupSweep[] = [];
    for (const install of installs) {
        const manifest = findApp(install.catalogId);
        if (!manifest || !appHasCapability(manifest, "game-server")) continue;
        const rules = policy.readBackupPolicy(readInstallConfig(install.config));
        if (rules.every === "off") continue;
        const done = await sweepOne(ownerId, install, rules, now);
        if (done) swept.push(done);
    }
    return swept;
}

/** One server's turn, which never throws: a sweep walks every server the owner
 *  has, and one that cannot be reached must not end the walk. */
async function sweepOne(
    ownerId: string,
    install: { id: string; name: string },
    rules: policy.BackupPolicy,
    now: Date
): Promise<BackupSweep | null> {
    try {
        return await withServerContainer(ownerId, install.id, async (server) => {
            const existing = await listBackups(server);
            const newest = existing[0] ? new Date(existing[0].createdAt) : null;
            if (!policy.backupDue(rules, newest, now)) {
                // Not due, but retention still applies: the operator may have just
                // lowered the limit, and it should bite without waiting a week.
                return { installedAppId: install.id, name: null, pruned: await pruneBackups(server, rules), error: null };
            }
            const taken = await writeBackup(ownerId, server);
            return {
                installedAppId: install.id,
                name: taken.name,
                pruned: await pruneBackups(server, rules),
                error: null
            };
        });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "The backup did not run";
        // A server that is simply off is not a failure worth waking anybody for.
        if (/start the server first|not been deployed/i.test(message)) return null;
        if (rules.notifyOnFailure) {
            await createNotification({
                userId: ownerId,
                type: "games.backup-failed",
                title: `Could not back up ${install.name}`,
                body: message,
                href: `/apps/installed/${install.id}/world`,
                level: "warning",
                actionRequired: true
            });
        }
        return { installedAppId: install.id, name: null, pruned: [], error: message };
    }
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

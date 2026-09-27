/**
 * The game's own figures for a player, out of the world folder.
 *
 * Minecraft has been keeping these since long before anybody was watching: a file
 * per player beside the world, holding playtime, deaths and kills counted by the
 * server itself. It is worth more than anything Polaris can total up from the
 * outside, because it covers every session the world has ever had - including the
 * ones from before the sweep existed, and the ones on somebody else's panel.
 *
 * Two files and no plugin. `usercache.json` turns a name into the uuid the game
 * files itself under, and `<level>/stats/<uuid>.json` is the figures. Read on
 * demand for one player rather than swept, because there is one of these per player
 * who has ever joined and nobody is looking at most of them.
 */

import * as world from "./world";
import { host } from "@polaris/app-host";
import type { PlayerFigures } from "./rankings";
import { miningFigures, type MiningFigures } from "./xray";
import { withServerContainer, type ServerContainer } from "./service";
import { readPlayerStats, type PlayerStats } from "../games-activity";
import { listContainerDir, readContainerFile, readContainerFiles } from "../container-files";

const { listEnvVars } = host.envVarService;

/** The map from a name to the uuid the world files it under. Written by the server
 *  whenever somebody joins, so it holds everyone who ever has. */
interface CacheEntry {
    readonly name?: unknown;
    readonly uuid?: unknown;
}

/** Every uuid this name is filed under. Usually one; two where the server
 *  switched between online and offline mode, which files the same player under a
 *  different uuid from then on - and both files are that player's time. */
export function uuidsFor(usercache: string, name: string): string[] {
    const wanted = name.trim().toLowerCase();
    return [...namesByUuid(usercache)]
        .filter(([, cached]) => cached.trim().toLowerCase() === wanted)
        .map(([uuid]) => uuid);
}

/** The usercache as uuid to name, lowercased uuids; empty when it cannot be read. */
function namesByUuid(usercache: string): Map<string, string> {
    const names = new Map<string, string>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(usercache);
    } catch {
        return names;
    }
    if (!Array.isArray(parsed)) return names;
    for (const entry of parsed as CacheEntry[]) {
        if (typeof entry?.name === "string" && typeof entry?.uuid === "string") {
            names.set(entry.uuid.toLowerCase(), entry.name);
        }
    }
    return names;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;

/** One player's figures from each of their files, added together. */
export function addStats(all: readonly PlayerStats[]): PlayerStats | null {
    if (all.length === 0) return null;
    return all.reduce((sum, one) => ({
        playedMs: sum.playedMs + one.playedMs,
        deaths: sum.deaths + one.deaths,
        mobKills: sum.mobKills + one.mobKills,
        playerKills: sum.playerKills + one.playerKills
    }));
}

/** The folder a Java world keeps its stats files in, or null when the level is
 *  not one Polaris can name. */
async function statsDir(server: ServerContainer, ownerId: string): Promise<string | null> {
    if (server.edition === "bedrock") return null;
    const vars = await listEnvVars("application", server.applicationId, ownerId).catch(() => []);
    const level = vars.find((entry) => entry.key === world.levelEnvKey("java"))?.value?.trim();
    if (!level || !/^[\w.-]+$/.test(level)) return null;
    return `${world.DATA_DIR}/${level}/stats`;
}

/**
 * What the server has counted for this player, or null.
 *
 * Null covers every ordinary way this comes to nothing - a Bedrock server, which
 * files none of it; somebody who has never joined; a world too young to have
 * written the file - and none of them are worth an error on a dialog that has
 * plenty else to show.
 */
export async function readMinecraftStats(
    ownerId: string,
    installedAppId: string,
    name: string
): Promise<PlayerStats | null> {
    try {
        return await withServerContainer(ownerId, installedAppId, async (server) => {
            const dir = await statsDir(server, ownerId);
            if (!dir) return null;
            const cache = await readContainerFile(server, `${world.DATA_DIR}/usercache.json`);
            if (cache === null) return null;
            const found: PlayerStats[] = [];
            for (const uuid of uuidsFor(cache, name)) {
                if (!UUID.test(uuid.toLowerCase())) continue;
                const json = await readContainerFile(server, `${dir}/${uuid.toLowerCase()}.json`);
                const stats = json === null ? null : readPlayerStats(json);
                if (stats) found.push(stats);
            }
            return addStats(found);
        });
    } catch {
        return null;
    }
}

/** One player's mining, as the X-Ray screen shows it beside the evidence. */
export interface PlayerMining {
    readonly name: string;
    readonly figures: MiningFigures;
}

/**
 * Every stats file the world has, by the name of the player it belongs to. In as
 * many commands as their length needs: together they are longer than one command
 * can answer, and reading them as one left all but the first few out. Empty for
 * Bedrock and for
 * a server that cannot be reached.
 */
async function readAllStatsFiles(
    ownerId: string,
    installedAppId: string
): Promise<{ readonly name: string; readonly json: string }[]> {
    try {
        return await withServerContainer(ownerId, installedAppId, async (server) => {
            const dir = await statsDir(server, ownerId);
            if (!dir) return [];
            const cache = await readContainerFile(server, `${world.DATA_DIR}/usercache.json`);
            // No names: the uuids are shown instead.
            const names = namesByUuid(cache ?? "");
            const uuids = new Map<string, string>();
            for (const entry of await listContainerDir(server, dir)) {
                const uuid = entry.replace(/\.json$/, "").toLowerCase();
                if (entry.endsWith(".json") && UUID.test(uuid)) uuids.set(`${dir}/${entry}`, uuid);
            }
            const read = await readContainerFiles(server, [...uuids.keys()]);
            return [...read].map(([path, json]) => {
                const uuid = uuids.get(path)!;
                return { name: names.get(uuid) ?? uuid, json };
            });
        });
    } catch {
        return [];
    }
}

/** The mining figures of every player the world has stats for, a player's files
 *  added together. */
export async function readAllMining(
    ownerId: string,
    installedAppId: string
): Promise<PlayerMining[]> {
    const byName = new Map<string, PlayerMining>();
    for (const file of await readAllStatsFiles(ownerId, installedAppId)) {
        const figures = miningFigures(file.json);
        if (!figures) continue;
        const key = file.name.toLowerCase();
        const held = byName.get(key)?.figures;
        byName.set(key, {
            name: file.name,
            figures: held
                ? {
                      diamonds: held.diamonds + figures.diamonds,
                      deepRock: held.deepRock + figures.deepRock,
                      debris: held.debris + figures.debris,
                      netherRock: held.netherRock + figures.netherRock
                  }
                : figures
        });
    }
    return [...byName.values()];
}

/** How long a reading of every player's figures stands. The game only writes
 *  them when it saves, every few minutes, so reading them more often than this
 *  would only read the same files again. */
const FIGURES_TTL_MS = 60_000;

const figuresRead = new Map<string, { at: number; value: Promise<PlayerFigures[]> }>();

/** Playtime, deaths and kills for every player the world has figures for, for
 *  the rankings; read at most once a minute per server. */
export async function readAllPlayerStats(
    ownerId: string,
    installedAppId: string
): Promise<PlayerFigures[]> {
    const held = figuresRead.get(installedAppId);
    if (held && Date.now() - held.at < FIGURES_TTL_MS) return held.value;
    // A player filed under two uuids is one row with the time of both.
    const value = readAllStatsFiles(ownerId, installedAppId).then((files) => {
        const byName = new Map<string, { name: string; all: PlayerStats[] }>();
        for (const file of files) {
            const stats = readPlayerStats(file.json);
            if (!stats) continue;
            const key = file.name.toLowerCase();
            const held = byName.get(key) ?? { name: file.name, all: [] };
            held.all.push(stats);
            byName.set(key, held);
        }
        return [...byName.values()].flatMap((one) => {
            const stats = addStats(one.all);
            return stats ? [{ name: one.name, stats }] : [];
        });
    });
    figuresRead.set(installedAppId, { at: Date.now(), value });
    return value;
}

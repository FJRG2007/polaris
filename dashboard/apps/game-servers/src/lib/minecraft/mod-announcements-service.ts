/**
 * Mod announcements on one server: which of the known ones are installed, and
 * each one's setting kept where the operator wants it (`mod-announcements.ts`
 * says which mods and why a setting).
 *
 * Kept, not set once: a mod rewrites its config when it is updated, a restored
 * backup brings the old file back, and a mod added next week has never been
 * seen. So every read of the Moderation tab puts the settings right, and a sweep
 * does it on every running modded server every few minutes, so a mod dropped into
 * the folder is quietened without anybody opening the tab.
 *
 * Only the one value changes (`toml-edit.ts`); a file this cannot follow is left
 * exactly as it is and reported, never rewritten.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { loaderForType } from "./modrinth";
import { parseProperties } from "./parse";
import { gameMessage } from "../game-message";
import { SOFTWARE_KEY } from "./join-guard";
import { withServerContainer, type ServerContainer } from "./service";
import {
    listContainerDir,
    readContainerFile,
    readContainerFileState,
    readContainerFiles,
    writeContainerFile
} from "../container-files";
import * as announcements from "./mod-announcements";
import { TomlShapeError, readTomlValue, setTomlValue } from "./toml-edit";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

const DATA_DIR = "/data";

/** Loaders whose servers carry mods at all; a plugin server has no mods folder. */
const MODDED = ["neoforge", "forge", "fabric", "quilt"];

export type AnnouncerStatus =
    /** The config says what the operator wants: quiet. */
    | "blocked"
    /** Let through on purpose. */
    | "allowed"
    /** The mod is in the folder but has not written its config yet: it does on
     *  its first start, and the next sweep sets it. */
    | "waiting"
    /** The config is there and could not be read or followed; left as it is. */
    | "unreadable";

export interface AnnouncerState {
    readonly id: string;
    readonly name: string;
    readonly allowed: boolean;
    readonly status: AnnouncerStatus;
    /** When a change reaches the players: "reload" for a data pack's
     *  announcement, which only ever speaks on a data reload. */
    readonly applies: announcements.Announcer["applies"] | "reload";
}

export interface AnnouncementsState {
    /** Whether the server's files could be looked at: it is up. */
    readonly reachable: boolean;
    readonly mods: readonly AnnouncerState[];
    /** A change written this time that only a restart brings in. */
    readonly needsRestart: boolean;
}

/** The world folder's name, when it is one a path can carry. */
export async function levelOf(server: ServerContainer): Promise<string | null> {
    const text = await readContainerFile(server, `${DATA_DIR}/server.properties`).catch(() => null);
    const name = text ? parseProperties(text)["level-name"] : undefined;
    const level = name && name.length > 0 ? name : "world";
    return /^[A-Za-z0-9_.-]{1,64}$/.test(level) && !level.includes("..") ? level : null;
}

/** One announcer's files brought to the value wanted, and what that left. */
async function keep(
    server: ServerContainer,
    announcer: announcements.Announcer,
    choices: announcements.AnnouncementChoices,
    level: string | null,
    write: boolean
): Promise<{ status: AnnouncerStatus; wrote: boolean }> {
    const wanted = announcements.wantedValue(announcer, choices);
    const paths = announcements
        .configPaths(announcer, DATA_DIR, level ?? "")
        .filter((path) => level !== null || !path.includes("/serverconfig/"));
    let seen = false;
    let unreadable = false;
    let wrote = false;
    for (const path of paths) {
        const read = await readContainerFileState(server, path).catch(
            () => ({ state: "unreadable" }) as const
        );
        if (read.state === "missing") continue;
        seen = true;
        if (read.state === "unreadable") {
            unreadable = true;
            continue;
        }
        try {
            const next = setTomlValue(read.content, announcer.table, announcer.key, wanted);
            if (!next.changed || !write) continue;
            // Read back before it is written: an edit that does not say what it
            // was meant to is never put on the server.
            if (readTomlValue(next.text, announcer.table, announcer.key) !== wanted) {
                unreadable = true;
                continue;
            }
            await writeContainerFile(server, path, next.text);
            wrote = true;
        } catch (caught) {
            if (!(caught instanceof TomlShapeError)) throw caught;
            unreadable = true;
        }
    }
    const allowed = choices.allowed.includes(announcer.id);
    if (unreadable) return { status: "unreadable", wrote };
    if (!seen) return { status: "waiting", wrote };
    return { status: allowed ? "allowed" : "blocked", wrote };
}

/**
 * The data packs inside mod jars that announce themselves on every reload, kept
 * quiet by Polaris's own `polaris-quiet` pack (see `PackAnnouncer`).
 *
 * The blocked ones' empty functions are written where they differ, the allowed
 * ones' removed, and the pack switched on if it is not yet. Switching it on is a
 * data reload, once per server; a later change is read at the next reload,
 * which is the only moment the announcement would speak anyway.
 */
async function keepPacks(
    server: ServerContainer,
    choices: announcements.AnnouncementChoices,
    modFiles: readonly string[],
    level: string | null
): Promise<AnnouncerState[]> {
    const found = announcements.installedPackAnnouncers(modFiles);
    if (found.length === 0) return [];
    const isAllowed = (one: announcements.PackAnnouncer) => choices.allowed.includes(one.id);
    const states = (status: AnnouncerStatus): AnnouncerState[] =>
        found.map((one) => ({
            id: one.id,
            name: one.name,
            allowed: isAllowed(one),
            status: status === "blocked" && isAllowed(one) ? "allowed" : status,
            applies: "reload"
        }));
    if (level === null) return states("unreadable");
    const root = `${DATA_DIR}/${level}/datapacks/${announcements.QUIET_PACK_DIR}`;
    const files = announcements.quietPackFiles(found.filter((one) => !isAllowed(one)));
    const there = await readContainerFiles(
        server,
        [...files.keys()].map((path) => `${root}/${path}`)
    );
    for (const [path, content] of files) {
        if (there.get(`${root}/${path}`) === content) continue;
        await writeContainerFile(server, `${root}/${path}`, content);
    }
    const letThrough = [...announcements.quietPackFiles(found.filter(isAllowed)).keys()]
        .filter((path) => path !== "pack.mcmeta")
        .map((path) => `${root}/${path}`);
    if (letThrough.length > 0) await server.run(["rm", "-f", "--", ...letThrough]);
    const enabled = (said: string) =>
        said.includes(`[${announcements.QUIET_PACK_ID}`) ||
        said.includes(`${announcements.QUIET_PACK_ID} (`);
    if (!enabled(await server.say(["datapack list enabled"]))) {
        await server.say(["datapack list available"]);
        await server.say([`datapack enable "${announcements.QUIET_PACK_ID}"`]);
        if (!enabled(await server.say(["datapack list enabled"]))) return states("waiting");
        console.info(`[minecraft-announcements] ${server.installedAppId}: quiet pack switched on`);
    }
    return states("blocked");
}

/**
 * Every known announcer in the server's mods folder, each put right.
 *
 * A blocked one is set every time. One the operator let through is written only
 * when they flip it (`flipped`): some mods switch their own key off once they
 * have spoken, and setting it back on every sweep would have them speak again
 * and again.
 */
async function keepAll(
    server: ServerContainer,
    choices: announcements.AnnouncementChoices,
    flipped: string | null = null
): Promise<AnnouncementsState> {
    if (!server.running) return { reachable: false, mods: [], needsRestart: false };
    let files: string[];
    try {
        files = await listContainerDir(server, `${DATA_DIR}/mods`);
    } catch {
        return { reachable: false, mods: [], needsRestart: false };
    }
    const found = announcements.installedAnnouncers(files);
    const packs = announcements.installedPackAnnouncers(files);
    if (found.length === 0 && packs.length === 0) {
        return { reachable: true, mods: [], needsRestart: false };
    }
    const level = await levelOf(server);
    const mods: AnnouncerState[] = [];
    let needsRestart = false;
    for (const announcer of found) {
        const allowed = choices.allowed.includes(announcer.id);
        const kept = await keep(
            server,
            announcer,
            choices,
            level,
            !allowed || flipped === announcer.id
        );
        if (kept.wrote && announcer.applies === "restart") needsRestart = true;
        if (kept.wrote) {
            console.info(
                `[minecraft-announcements] ${server.installedAppId}: ${announcer.id} set to ${announcements.wantedValue(announcer, choices)}`
            );
        }
        mods.push({
            id: announcer.id,
            name: announcer.name,
            allowed,
            status: kept.status,
            applies: announcer.applies
        });
    }
    mods.push(...(await keepPacks(server, choices, files, level)));
    return { reachable: true, mods, needsRestart };
}

async function choicesOf(installedAppId: string): Promise<announcements.AnnouncementChoices> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return announcements.readAnnouncementChoices(readInstallConfig(row?.config));
}

/** What the tab shows, with the settings put right on the way. */
export async function announcementsState(
    ownerId: string,
    installedAppId: string
): Promise<AnnouncementsState> {
    const choices = await choicesOf(installedAppId);
    return withServerContainer(ownerId, installedAppId, (server) => keepAll(server, choices));
}

/** Let one mod's announcement through, or block it again, and apply that now. */
export async function setAnnouncementAllowed(
    ownerId: string,
    installedAppId: string,
    id: string,
    allow: boolean
): Promise<AnnouncementsState> {
    if (!announcements.isAnnouncerId(id)) {
        throw new Error(gameMessage("games", "errors.serverNotFound"));
    }
    const choices = announcements.withChoice(await choicesOf(installedAppId), id, allow);
    await patchInstallConfig(installedAppId, { [announcements.ANNOUNCEMENTS_KEY]: choices });
    return withServerContainer(ownerId, installedAppId, (server) => keepAll(server, choices, id));
}

/**
 * Every running modded server, put right. A server that is stopped or cannot be
 * reached is skipped and seen again next time; one failing never stops the rest.
 */
export async function sweepModAnnouncements(): Promise<{ checked: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { catalogId: "minecraft", status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, ownerId: true, applicationId: true, config: true }
    });
    const types = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: { in: installs.map((install) => install.applicationId!) },
            key: SOFTWARE_KEY
        },
        select: { scopeId: true, value: true }
    });
    const software = new Map(types.map((row) => [row.scopeId, row.value ?? ""]));
    let checked = 0;
    for (const install of installs) {
        const loader = loaderForType(software.get(install.applicationId!) ?? "");
        if (!loader || !MODDED.includes(loader)) continue;
        const choices = announcements.readAnnouncementChoices(readInstallConfig(install.config));
        try {
            const kept = await withServerContainer(install.ownerId, install.id, (server) =>
                keepAll(server, choices)
            );
            if (kept.mods.length > 0) checked += 1;
        } catch (caught) {
            console.error(`[minecraft-announcements] could not check ${install.id}:`, caught);
        }
    }
    return { checked };
}

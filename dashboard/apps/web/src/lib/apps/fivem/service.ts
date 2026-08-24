/**
 * Driving an installed FiveM server from the dashboard.
 *
 * Two channels, and which one a job uses is decided by what the game will
 * actually answer. Anything that is a reading - who is on, how full it is, what is
 * running - comes from the small JSON documents the server publishes, because they
 * are always on and cost nothing. Anything that changes something goes over the
 * console, because that is the only thing that changes anything. Both go through
 * `transport.ts` and never leave the container.
 *
 * The awkward part is that FiveM has no whitelist and no ban list. `clientkick`
 * throws somebody off and they are back before the door has shut, so a list kept
 * only here would be a list that does nothing. Polaris therefore installs a small
 * resource of its own into every server it creates and hands it the list as a
 * file - see `guard.ts`. That is also why a player can be on the list and the
 * server not know it yet: the server has to be up before it can be handed
 * anything, and a server that was created a minute ago is still starting. The two
 * states are drawn differently on the screen for exactly the reason ARK's are.
 *
 * Everything a server is configured with lives in one file it reads at boot, so
 * nothing here changes a running server's settings. Each screen that writes one
 * says so rather than pretending otherwise.
 */

import { prisma } from "@polaris/db";
import { createHash, randomBytes } from "node:crypto";
import { findApp } from "@/lib/apps/catalog";
import * as guard from "@/lib/apps/fivem/guard";
import * as access from "@/lib/apps/fivem/access";
import { setEnvVars } from "@/lib/env-var-service";
import * as players from "@/lib/apps/fivem/players";
import { quoteArgument } from "@/lib/apps/fivem/rcon";
import { readAppRuntimeLog } from "@/lib/deploy-service";
import { readCrashLoop, readRestartWatch } from "@/lib/apps/games-health";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { readContainerFile, writeContainerFile } from "@/lib/apps/container-files";
import { crashLoopOf, isCrashLooping, type CrashLoop } from "@/lib/apps/crash-loop";
import { readAppContainerMetricsOrNull, readAppContainerRuntime } from "@/lib/app-container-metrics";
import { NO_HTTP_CLIENT, RCON_PASSWORD_VAR, withFivemServer, type FivemTransport } from "@/lib/apps/fivem/transport";
import { findSetting, settingError, FIVEM_SETTINGS, type FivemSetting } from "@/lib/apps/fivem/settings";
import { readSetting, writeBlock, writeSetting, type CfgKey } from "@/lib/apps/fivem/cfg";
import {
    isLicenseKey,
    FIVEM_CATALOG_ID,
    FIVEM_CONTAINER_PORT,
    LICENSE_KEY_HINT,
    RESOURCES_ROOT,
    SERVER_CFG
} from "@/lib/apps/fivem/config";
import {
    foldResources,
    isResourceName,
    parseResourceListing,
    RESOURCE_URL_HINT,
    resourceArchiveOf,
    type FivemResource,
    type ResourceAction
} from "@/lib/apps/fivem/resources";

export { FIVEM_CATALOG_ID } from "@/lib/apps/fivem/config";

/** Enough to reach past a crash's own noise to the line under it. Paid only for a
 *  container already judged to be looping. */
const CRASH_LOG_TAIL = 600;

/** Where the settings a server was created with wait until there is a server to
 *  hand them to. Written at create, spent by the first sweep that finds the
 *  container answering, and gone after that. */
export const PENDING_SETUP_KEY = "fivemPendingSetup";

/**
 * What the door was last handed, as a fingerprint.
 *
 * The hand-over writes three files into the container and restarts a resource,
 * and it is called from a page that polls every few seconds - so without this it
 * would be eight commands inside a container every twelve seconds for as long as
 * anybody has the server open, to write the same bytes it wrote last time.
 * Recorded rather than compared against the container, because reading the files
 * back costs the same as writing them.
 */
const HANDED_KEY = "fivemAccessDigest";

/** A console password nobody had to invent, minted on this side. The dialog that
 *  offers one to type over mints it in the browser, from the same function. */
export function mintConsolePassword(): string {
    return access.generateConsolePassword((size) => new Uint8Array(randomBytes(size)));
}

/** Whether a catalog id names a FiveM server this Polaris knows how to run. */
export function isFivemServer(catalogId: string): boolean {
    return catalogId === FIVEM_CATALOG_ID && findApp(catalogId) !== undefined;
}

/** Who is on a FiveM server, and whether it is answering at all. */
export interface FivemLive {
    readonly answering: boolean;
    /** Whether the container is actually up, when that can be seen from here. */
    readonly containerRunning: boolean | null;
    readonly players: readonly players.FivemPlayer[];
    /** Slots, as the running server reports them. Nought when it did not answer. */
    readonly max: number;
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
    /** Set when it is restarting without ever starting, or was stopped for doing
     *  so. The rule is a container rule, so this reads it the way the other games
     *  do - see `crash-loop`. */
    readonly crashLoop: CrashLoop | null;
}

const NOT_ANSWERING = (message: string, containerRunning: boolean | null, crashLoop: CrashLoop | null): FivemLive => ({
    answering: false,
    containerRunning,
    players: [],
    max: 0,
    message,
    crashLoop
});

/**
 * Ask the running server who is on. A server that is stopped, still starting or
 * still loading its resources is a reading that says so, never a throw - the
 * callers list servers.
 *
 * The container is looked at before it is spoken to, which costs one cheap call
 * and saves a page listing stopped servers from waiting out a failing exec for
 * each of them.
 */
export async function getFivemPlayers(ownerId: string, installedAppId: string): Promise<FivemLive> {
    return (await readLive(ownerId, installedAppId, false)).live;
}

/** What one visit to a server can answer at once. */
interface FivemReading {
    readonly live: FivemLive;
    /** Only when the caller asked to describe the server: what it is running and
     *  what it calls itself. A list of six servers must not pay for six of these. */
    readonly info: players.FivemInfo | null;
    readonly dynamic: players.FivemDynamic | null;
}

async function readLive(ownerId: string, installedAppId: string, describe: boolean): Promise<FivemReading> {
    const quiet = (live: FivemLive): FivemReading => ({ live, info: null, dynamic: null });
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, config: true }
    });
    if (!install?.applicationId) return quiet(NOT_ANSWERING("This server has not been deployed yet", null, null));

    const app = await prisma.application.findFirst({
        where: { id: install.applicationId },
        select: { desiredState: true }
    });
    if (app?.desiredState !== "running") {
        // A server Polaris stopped for failing to start says so: by now nothing on
        // the container remembers, and "stopped" on its own is the state somebody
        // chose rather than the one that was forced.
        const halted = readCrashLoop(install.config);
        return quiet(
            NOT_ANSWERING(
                halted
                    ? `The server kept failing to start, so it has been stopped after ${halted.restarts} restarts.${halted.cause ? ` ${halted.cause}` : ""}`
                    : "The server is stopped",
                null,
                halted
            )
        );
    }

    const runtime = await readAppContainerRuntime(install.applicationId, ownerId);
    const state = runtime?.status ?? null;
    // Against the reading the sweep took a minute ago: a restart count on its own
    // cannot tell a server that is still looping from one that has just got out.
    if (runtime && isCrashLooping(runtime, readRestartWatch(install.config), new Date())) {
        const loop = crashLoopOf(
            runtime,
            await readAppRuntimeLog(install.applicationId, ownerId, CRASH_LOG_TAIL).catch(() => "")
        );
        return quiet(
            NOT_ANSWERING(
                `The server kept failing to start, so it has been stopped after ${loop.restarts} restarts.${loop.cause ? ` ${loop.cause}` : ""}`,
                false,
                loop
            )
        );
    }
    if (state !== null && state !== "running") {
        return quiet(
            NOT_ANSWERING("The container is not running. Redeploy it, or read the logs to see why it stopped.", false, null)
        );
    }
    const containerRunning = state === null ? null : true;
    try {
        const raw = await withFivemServer(ownerId, installedAppId, async (server) => {
            const [live, dynamic, info] = await Promise.all([
                server.document("players.json"),
                server.document("dynamic.json"),
                describe ? server.document("info.json") : Promise.resolve(null)
            ]);
            return { live, dynamic, info };
        });
        if (raw.live === null) {
            return quiet(
                NOT_ANSWERING(
                    "The server is starting. It loads its resources first, which takes a moment.",
                    containerRunning,
                    null
                )
            );
        }
        const dynamic = players.parseDynamic(raw.dynamic);
        return {
            live: {
                answering: true,
                containerRunning,
                players: players.parsePlayers(raw.live),
                max: dynamic?.maxClients ?? 0,
                message: null,
                crashLoop: null
            },
            dynamic,
            info: players.parseInfo(raw.info)
        };
    } catch (caught) {
        return quiet(
            NOT_ANSWERING(caught instanceof Error ? caught.message : "The server is not answering", containerRunning, null)
        );
    }
}

/** What is running, what it costs, and who is on it. */
export interface FivemStatus extends FivemLive {
    /** Polaris means it to be up. Not the same as it answering. */
    readonly running: boolean;
    /** The port a player's client connects on, which is both the TCP and the UDP
     *  one - a FiveM address is one number. */
    readonly port: number | null;
    /** What it says it is: the name in the browser, and the build it runs. */
    readonly hostname: string | null;
    readonly build: string | null;
    readonly resourcesRunning: number | null;
    /**
     * Whether the resource that keeps players out is actually running.
     *
     * Null when the server did not say. False is the case worth having a field
     * for: a volume that was wiped takes the resource with it, and a server
     * Polaris believes is closed while nothing at its door is enforcing that is
     * the one failure here nobody would notice.
     */
    readonly guardRunning: boolean | null;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number | null;
}

/**
 * The port this server was published on.
 *
 * From what the deploy actually pinned rather than from the image's default: the
 * second server on a machine is on another port, and it is the only thing a
 * player has to be told that they cannot guess.
 */
export async function readFivemPort(applicationId: string | null): Promise<number | null> {
    if (!applicationId) return null;
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { sourceConfig: true } });
    if (!app) return null;
    try {
        const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
        return typeof config.hostPort === "number" ? config.hostPort : null;
    } catch {
        return null;
    }
}

export async function getFivemStatus(ownerId: string, installedAppId: string): Promise<FivemStatus> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    const applicationId = install?.applicationId ?? null;
    const [reading, usage, app, port] = await Promise.all([
        readLive(ownerId, installedAppId, true),
        applicationId ? readAppContainerMetricsOrNull(applicationId, ownerId) : null,
        applicationId
            ? prisma.application.findFirst({ where: { id: applicationId }, select: { desiredState: true } })
            : null,
        readFivemPort(applicationId)
    ]);
    return {
        ...reading.live,
        running: app?.desiredState === "running",
        port,
        hostname: reading.dynamic?.hostname || null,
        build: reading.info?.server || null,
        resourcesRunning: reading.info ? reading.info.resources.length : null,
        guardRunning: reading.info
            ? reading.info.resources.some((name) => name.toLowerCase() === guard.GUARD_RESOURCE)
            : null,
        cpuPercent: usage?.cpuPercent ?? null,
        memUsedBytes: usage?.memUsedBytes ?? null,
        memTotalBytes: usage?.memTotalBytes ?? null
    };
}

/**
 * Run one console command and hand back what the server said.
 *
 * Every moderation action below goes through here rather than round it, so there
 * is one place a command is refused and one place it is bounded.
 */
export async function runFivemCommand(ownerId: string, installedAppId: string, command: string): Promise<string> {
    return withFivemServer(ownerId, installedAppId, (server) => server.rcon(command.trim()));
}

/** Say something to everyone who is playing. */
export async function broadcastToFivem(ownerId: string, installedAppId: string, message: string): Promise<void> {
    await runFivemCommand(ownerId, installedAppId, `say ${quoteArgument(message)}`);
}

/** Say something to one person. The console can only broadcast, so this goes
 *  through the command Polaris' own resource adds.
 *
 *  One quoted argument rather than the words left loose: the console splits a
 *  line on `;` before any resource sees it, so a message typed with one in it
 *  would be a second command run as the console itself. The resource joins its
 *  arguments back with a space, so a single token says the same thing. */
export async function messageFivemPlayer(
    ownerId: string,
    installedAppId: string,
    playerId: number,
    message: string
): Promise<void> {
    if (!access.isBanReason(message)) throw new Error(access.REASON_HINT);
    await runFivemCommand(ownerId, installedAppId, `${guard.DM_COMMAND} ${playerId} ${quoteArgument(message)}`);
}

/** Throw somebody off. They can come straight back unless the allow list or a ban
 *  keeps them out, which is what the screen says beside it. */
export async function kickFivemPlayer(
    ownerId: string,
    installedAppId: string,
    playerId: number,
    reason: string
): Promise<void> {
    await runFivemCommand(
        ownerId,
        installedAppId,
        `clientkick ${playerId} ${quoteArgument(reason || "You were removed from this server.")}`
    );
}

/** Who the server is meant to let in, who runs it, and who is kept out. */
export interface FivemAccessView extends access.FivemAccess {
    /** Whether the running server has been handed the current list. False while
     *  it has never been - a server that is still starting cannot be told, and the
     *  screen says the difference out loud. */
    readonly handedOver: boolean;
}

export async function readFivemAccess(ownerId: string, installedAppId: string): Promise<FivemAccessView> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { config: true }
    });
    return accessOf(readInstallConfig(install?.config));
}

/** The lists as the install holds them, without the ownership check - for the
 *  sweeps, which have already resolved the owner. */
function accessOf(config: Record<string, unknown>): FivemAccessView {
    const allowList = access.readAllowList(config);
    return {
        allowList,
        bans: access.readBans(config),
        admins: access.readAdmins(config),
        exclusiveJoin: access.readExclusiveJoin(config),
        handedOver: allowList.every((entry) => entry.appliedAt !== null)
    };
}

/** The application behind an install, refusing the same way for one that is not
 *  the caller's and one that was never deployed. */
async function requireApplication(ownerId: string, installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true }
    });
    if (!install) throw new Error("Server not found");
    if (install.catalogId !== FIVEM_CATALOG_ID) throw new Error("That is not a FiveM server");
    if (!install.applicationId) throw new Error("This server has not been deployed yet");
    return install.applicationId;
}

/** Read the install's settings blob, for the callers that change one list in it. */
async function configOf(ownerId: string, installedAppId: string): Promise<Record<string, unknown>> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { config: true }
    });
    if (!install) throw new Error("Server not found");
    return readInstallConfig(install.config);
}

/**
 * Let somebody in.
 *
 * Recorded first and handed over second, and the hand-over is allowed to fail: a
 * server that is still starting cannot be told anything, and refusing to write
 * down who may join because of that would leave a moderator pressing the button
 * again and again while nothing happened.
 */
export async function addAllowedPlayer(
    ownerId: string,
    installedAppId: string,
    player: { identifier: string; label: string }
): Promise<FivemAccessView> {
    if (!players.isIdentifier(player.identifier)) throw new Error("That is not a player identifier");
    const config = await configOf(ownerId, installedAppId);
    await patchInstallConfig(installedAppId, {
        [access.ALLOW_LIST_KEY]: access.withAllowed(access.readAllowList(config), player, new Date().toISOString())
    });
    return handOver(ownerId, installedAppId);
}

/**
 * Take somebody off the list.
 *
 * The last one cannot come off while the server is closed, for the same reason it
 * cannot be closed with nobody on it: a closed server with an empty list refuses
 * every client there is, starting with whoever was trying to fix it, and the door
 * would say nothing that explained why.
 */
export async function removeAllowedPlayer(
    ownerId: string,
    installedAppId: string,
    identifier: string
): Promise<FivemAccessView> {
    const config = await configOf(ownerId, installedAppId);
    const next = access.withoutAllowed(access.readAllowList(config), identifier);
    if (next.length === 0 && access.readExclusiveJoin(config)) {
        throw new Error("Open the server to everyone first, or taking the last player off would keep you out too");
    }
    await patchInstallConfig(installedAppId, { [access.ALLOW_LIST_KEY]: next });
    return handOver(ownerId, installedAppId);
}

/** Hand the change to the server and read back what the lists now say, which is
 *  what every screen that changed one draws next. The hand-over is allowed to
 *  fail; the reading is not. */
async function handOver(ownerId: string, installedAppId: string): Promise<FivemAccessView> {
    await applyFivemAccess(ownerId, installedAppId).catch(() => undefined);
    return readFivemAccess(ownerId, installedAppId);
}

/**
 * Keep somebody out, and throw them off if they are on right now.
 *
 * The kick is best effort and the ban is not: the ban is what stops them coming
 * back, and a server that could not be reached to kick them will refuse them the
 * moment it can be.
 */
export async function banFivemPlayer(
    ownerId: string,
    installedAppId: string,
    ban: { identifier: string; label: string; reason: string; until?: string | null }
): Promise<FivemAccessView> {
    if (!players.isIdentifier(ban.identifier)) throw new Error("That is not a player identifier");
    if (!access.isBanReason(ban.reason)) throw new Error("That reason is too long for the screen it is shown on");
    const config = await configOf(ownerId, installedAppId);
    await patchInstallConfig(installedAppId, {
        [access.BAN_LIST_KEY]: access.withBan(access.readBans(config), ban, new Date().toISOString())
    });
    const view = await handOver(ownerId, installedAppId);
    await kickWhoever(ownerId, installedAppId, ban.identifier, ban.reason || access.DEFAULT_BAN_REASON).catch(
        () => undefined
    );
    return view;
}

export async function unbanFivemPlayer(
    ownerId: string,
    installedAppId: string,
    identifier: string
): Promise<FivemAccessView> {
    const config = await configOf(ownerId, installedAppId);
    await patchInstallConfig(installedAppId, {
        [access.BAN_LIST_KEY]: access.withoutBan(access.readBans(config), identifier)
    });
    return handOver(ownerId, installedAppId);
}

/** Throw off whoever on the server right now holds this identifier. Nobody is the
 *  ordinary case: most bans are written about somebody who has already left. */
async function kickWhoever(
    ownerId: string,
    installedAppId: string,
    identifier: string,
    reason: string
): Promise<void> {
    const live = await getFivemPlayers(ownerId, installedAppId);
    if (!live.answering) return;
    for (const player of live.players) {
        if (players.playerHasIdentifier(player, identifier)) {
            await kickFivemPlayer(ownerId, installedAppId, player.id, reason).catch(() => undefined);
        }
    }
}

/** Open or close the server to everyone who is not on the list. */
export async function setExclusiveJoin(
    ownerId: string,
    installedAppId: string,
    closed: boolean
): Promise<FivemAccessView> {
    const config = await configOf(ownerId, installedAppId);
    if (closed && access.readAllowList(config).length === 0) {
        throw new Error("Add somebody to the list first, or closing it would keep you out too");
    }
    await patchInstallConfig(installedAppId, { [access.EXCLUSIVE_JOIN_KEY]: closed });
    return handOver(ownerId, installedAppId);
}

/**
 * Make somebody an administrator, or stop them being one.
 *
 * Written into the config so it survives a restart, and told to the running
 * server as well so it takes effect now - a permission that only arrives on the
 * next restart is one somebody grants and then watches do nothing.
 */
export async function setFivemAdmin(
    ownerId: string,
    installedAppId: string,
    admin: { identifier: string; label: string },
    isAdmin: boolean
): Promise<FivemAccessView> {
    if (!players.isIdentifier(admin.identifier)) throw new Error("That is not a player identifier");
    const config = await configOf(ownerId, installedAppId);
    const held = access.readAdmins(config);
    const next = isAdmin
        ? access.withAdmin(held, admin, new Date().toISOString())
        : access.withoutAdmin(held, admin.identifier);
    await patchInstallConfig(installedAppId, { [access.ADMIN_LIST_KEY]: next });
    const view = await handOver(ownerId, installedAppId);
    const identifier = players.normalizeIdentifier(admin.identifier);
    await runFivemCommand(
        ownerId,
        installedAppId,
        `${isAdmin ? "add_principal" : "remove_principal"} ${quoteArgument(`identifier.${identifier}`)} group.admin`
    ).catch(() => undefined);
    return view;
}

/**
 * Hand the running server the lists Polaris holds.
 *
 * Everything the door needs goes into one file the resource reads on each
 * connection, so there is nothing to reload and no moment where half of it has
 * landed. The administrators are the exception - they are the game's own ACL and
 * live in the config - so they are written there and left for the next start,
 * having already been told to the running server by whatever changed them.
 *
 * Reports how many players it managed to hand over, which is what the sweep logs
 * and what makes "added" and "the server knows" two different things on screen.
 */
export async function applyFivemAccess(
    ownerId: string,
    installedAppId: string,
    /** Hand it over even though nothing has changed. Passed when the caller has
     *  seen that the resource is not running, which is the one way the container
     *  can be out of step with what was recorded here. */
    force = false
): Promise<number> {
    const config = await configOf(ownerId, installedAppId);
    const current = accessOf(config);
    const digest = handedDigest(current);
    // The ordinary case, and the reason this is cheap: nothing has changed since
    // the last hand-over, so there is nothing to say and no container to open.
    if (!force && config[HANDED_KEY] === digest) return 0;
    const written = await withFivemServer(ownerId, installedAppId, async (server) => {
        await installGuard(server, current);
        const cfg = await readContainerFile(server.container, SERVER_CFG);
        if (cfg === null) return false;
        const next = withGuardWiring(cfg, current);
        if (next !== cfg) await writeContainerFile(server.container, SERVER_CFG, next);
        return true;
    });
    if (!written) return 0;
    const now = new Date().toISOString();
    const pending = access.pendingAllowed(current.allowList);
    await patchInstallConfig(installedAppId, {
        [HANDED_KEY]: digest,
        ...(pending.length > 0
            ? {
                  [access.ALLOW_LIST_KEY]: current.allowList.map((entry) =>
                      entry.appliedAt === null ? { ...entry, appliedAt: now } : entry
                  )
              }
            : {})
    });
    return pending.length;
}

/**
 * A fingerprint of everything the container is handed.
 *
 * The lists, and the resource's own text: a Polaris that ships a newer door has
 * to write it into every server it already installed one into, and nothing else
 * here would notice that it had changed. Taken off the whole ban rather than off
 * what is live at this moment, so the fingerprint does not change by itself as a
 * timeout runs down - the sweep that lifts one changes the list, and that is what
 * makes this move.
 */
function handedDigest(current: access.FivemAccess): string {
    return createHash("sha256")
        .update(JSON.stringify(current.allowList.map((entry) => entry.identifier)))
        .update(JSON.stringify(current.bans))
        .update(String(current.exclusiveJoin))
        .update(JSON.stringify(access.adminCfgLines(current.admins)))
        .update(guard.GUARD_MANIFEST)
        .update(guard.GUARD_SCRIPT)
        .digest("hex");
}

/** Write the resource itself and the list it reads. Idempotent: the same bytes
 *  every time, so a sweep that runs every minute writes nothing new. */
async function installGuard(server: FivemTransport, current: access.FivemAccess): Promise<void> {
    await writeContainerFile(server.container, `${guard.GUARD_ROOT}/fxmanifest.lua`, guard.GUARD_MANIFEST);
    await writeContainerFile(server.container, `${guard.GUARD_ROOT}/server.lua`, guard.GUARD_SCRIPT);
    await writeContainerFile(
        server.container,
        guard.GUARD_ACCESS_FILE,
        `${JSON.stringify(guard.guardAccessFile(current), null, 2)}\n`
    );
    // A resource that has just appeared on disk is not one the server knows about,
    // and one whose script changed has to be restarted to pick it up. Both are the
    // same two commands, and both are free on a server that was already running it.
    await server.rcon("refresh").catch(() => undefined);
    await server.rcon(`ensure ${guard.GUARD_RESOURCE}`).catch(() => undefined);
}

/** The config with the two blocks Polaris owns in it: the administrators, and the
 *  line that starts its own resource. */
function withGuardWiring(cfg: string, current: access.FivemAccess): string {
    return writeBlock(
        writeBlock(cfg, access.ADMIN_BLOCK, access.adminCfgLines(current.admins)),
        guard.GUARD_BLOCK,
        guard.guardCfgLines()
    );
}

/**
 * Take the timeouts that have run out off the list.
 *
 * A ban with an end is only a timeout if something comes back to lift it, and
 * this is that something. The door already ignores an expired one - it is handed
 * only the bans that are live - so this is about the screen and the file agreeing
 * with each other rather than about who gets in.
 */
export async function sweepFivemBans(ownerId: string, installedAppId: string, now: Date = new Date()): Promise<number> {
    const config = await configOf(ownerId, installedAppId);
    const held = access.readBans(config);
    const expired = access.expiredBans(held, now);
    if (expired.length === 0) return 0;
    await patchInstallConfig(installedAppId, { [access.BAN_LIST_KEY]: access.activeBans(held, now) });
    await applyFivemAccess(ownerId, installedAppId).catch(() => undefined);
    return expired.length;
}

/**
 * Carry the firewall's blocklist onto the server's own door.
 *
 * The firewall blocks an address at the edge, which a game port does not go
 * through - so an address the operator blocked was still perfectly able to play.
 * Every game here closes that gap in whatever way its own game can, and FiveM's
 * way is the list its door already reads: a blocked address becomes an `ip:` ban
 * like any other, which is exactly what a ban on an address is.
 *
 * Ranges are left alone. The door matches an identifier the client presented, and
 * `ip:203.0.113.0/24` is not something any client ever presents - it would be a
 * rule that silently matches nobody.
 */
export async function applyFivemFirewallBans(ownerId: string, installedAppId: string): Promise<number> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    const { resolveWaf } = await import("@/lib/waf-service");
    const waf = await resolveWaf(applicationId);
    const blocked = waf.deny.filter((entry) => !entry.includes("/"));
    if (blocked.length === 0) return 0;
    const config = await configOf(ownerId, installedAppId);
    const held = access.readBans(config);
    const now = new Date().toISOString();
    let next = held;
    let added = 0;
    for (const address of blocked) {
        const identifier = `ip:${address}`;
        if (next.some((entry) => entry.identifier === identifier)) continue;
        next = access.withBan(
            next,
            { identifier, label: address, reason: "Blocked by the Polaris firewall" },
            now
        );
        added += 1;
    }
    if (added === 0) return 0;
    await patchInstallConfig(installedAppId, { [access.BAN_LIST_KEY]: next });
    await applyFivemAccess(ownerId, installedAppId).catch(() => undefined);
    return added;
}

/** What a server was created with, waiting for there to be a server. */
export interface PendingSetup {
    /** Config values to write, as `key` -> value, resolved against the catalogue. */
    readonly settings: Readonly<Record<string, string>>;
}

/** What the create flow recorded, or null once it has been spent. */
export function readPendingSetup(config: Record<string, unknown>): PendingSetup | null {
    const raw = config[PENDING_SETUP_KEY];
    if (typeof raw !== "object" || raw === null) return null;
    const settings = (raw as { settings?: unknown }).settings;
    if (typeof settings !== "object" || settings === null) return null;
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
        if (typeof value === "string") cleaned[key] = value;
    }
    return { settings: cleaned };
}

/**
 * Hand a newly created server everything it was created with.
 *
 * A server does not exist when it is created - the container has not been built,
 * let alone started - so the name it should answer to, the slots it holds and the
 * switches it was created with are written down and given to it here, by the first
 * sweep that finds it up. It is restarted once afterwards, because every one of
 * those is read at boot; the server is minutes old and nobody is on it.
 *
 * Does nothing at all once there is nothing pending, which is every sweep after
 * the first.
 */
export async function applyPendingSetup(ownerId: string, installedAppId: string): Promise<boolean> {
    const config = await configOf(ownerId, installedAppId);
    const pending = readPendingSetup(config);
    if (!pending) return false;
    const written = await withFivemServer(ownerId, installedAppId, async (server) => {
        const cfg = await readContainerFile(server.container, SERVER_CFG);
        // The image writes this file on the container's first start. Until it is
        // there, there is nothing to edit and this is simply too early.
        if (cfg === null) return false;
        let next = cfg;
        for (const [key, value] of Object.entries(pending.settings)) {
            const setting = findSetting(key);
            if (!setting) continue;
            next = writeSetting(next, setting, value.length > 0 ? value : null);
        }
        // The port the server advertises to the public list, which is the one on
        // the outside of the container rather than the one it binds. Only when the
        // two differ, which is every server on a machine after the first.
        const port = await readFivemPort(server.container.applicationId);
        if (port !== null && port !== FIVEM_CONTAINER_PORT) {
            next = writeSetting(next, { key: "netPort", prefix: "" }, String(port));
        }
        next = withGuardWiring(next, accessOf(config));
        await writeContainerFile(server.container, SERVER_CFG, next);
        await installGuard(server, accessOf(config));
        return true;
    });
    if (!written) return false;
    await patchInstallConfig(installedAppId, {
        [PENDING_SETUP_KEY]: null,
        [access.ALLOW_LIST_KEY]: access.readAllowList(config).map((entry) =>
            entry.appliedAt === null ? { ...entry, appliedAt: new Date().toISOString() } : entry
        )
    });
    await restartServer(ownerId, installedAppId).catch(() => undefined);
    return true;
}

/** Stop and start the container, for the settings that are only read at boot. */
async function restartServer(ownerId: string, installedAppId: string): Promise<void> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    // Imported here rather than at the top: this module is pulled in by the sweep,
    // and the deploy stack is a large thing to drag in behind a player list.
    const { setApplicationRunning } = await import("@/lib/deploy-service");
    await setApplicationRunning(applicationId, ownerId, false);
    await setApplicationRunning(applicationId, ownerId, true);
}

/** One rule as the screen shows it: what the file says, and whether it says
 *  anything at all. */
export interface FivemRule {
    readonly key: string;
    /**
     * What the config holds, or null when it does not set it.
     *
     * Always null for a setting the catalogue marks secret, whatever the file
     * says: one of these is a Steam API key, and a screen that has no need to
     * print a credential back must not be sent one to print.
     */
    readonly value: string | null;
    /** Whether the config sets it at all - which for a secret is the only thing
     *  its row can honestly say. */
    readonly set: boolean;
}

/** Every rule the screen offers, read out of the server's own config. */
export async function readFivemRules(ownerId: string, installedAppId: string): Promise<FivemRule[] | null> {
    const cfg = await withFivemServer(ownerId, installedAppId, (server) =>
        readContainerFile(server.container, SERVER_CFG)
    ).catch(() => null);
    if (cfg === null) return null;
    return FIVEM_SETTINGS.map((setting) => {
        const held = readSetting(cfg, setting);
        return { key: setting.key, value: setting.secret ? null : held, set: held !== null };
    });
}

/**
 * Change the rules, and say whether the server has to be restarted for it.
 *
 * It always does - every one of these is read at boot - which is why this returns
 * rather than restarts: an operator changing the server name at nine in the
 * evening should not have that disconnect everybody who is playing.
 */
export async function writeFivemRules(
    ownerId: string,
    installedAppId: string,
    changes: Readonly<Record<string, string | null>>
): Promise<void> {
    const wanted: { setting: FivemSetting; value: string | null }[] = [];
    for (const [key, value] of Object.entries(changes)) {
        const setting = findSetting(key);
        if (!setting) throw new Error("That is not a setting this server has");
        if (value !== null) {
            const problem = settingError(setting, value);
            if (problem) throw new Error(problem);
        }
        wanted.push({ setting, value });
    }
    await withFivemServer(ownerId, installedAppId, async (server) => {
        const cfg = await readContainerFile(server.container, SERVER_CFG);
        if (cfg === null) throw new Error("The server has not written its config yet. Start it once and try again.");
        let next = cfg;
        for (const change of wanted) next = writeSetting(next, change.setting, change.value);
        await writeContainerFile(server.container, SERVER_CFG, next);
    });
    // The slot count is the one setting something outside this file reads: the
    // server list prints "3 / 32" about a server that is switched off, and there
    // is nothing to ask when it is.
    const slots = Number.parseInt(changes[SLOTS_SETTING] ?? "", 10);
    if (Number.isFinite(slots)) await patchInstallConfig(installedAppId, { slots });
}

/** The setting the list's slot figure comes from. */
const SLOTS_SETTING = "sv_maxclients";

/** Every resource the server has, and which of them are running. */
export async function listFivemResources(ownerId: string, installedAppId: string): Promise<FivemResource[]> {
    return withFivemServer(ownerId, installedAppId, async (server) => {
        const [listing, info] = await Promise.all([
            server.container.run([
                "sh",
                "-c",
                // Depth-limited so a resource that vendors a copy of another one
                // inside itself is not listed as two, and so a large server's
                // node_modules are not walked at all.
                `find ${RESOURCES_ROOT} -maxdepth 4 -name fxmanifest.lua -o -maxdepth 4 -name __resource.lua 2>/dev/null`
            ]),
            server.document("info.json").catch(() => null)
        ]);
        const onDisk = listing.code === 0 ? parseResourceListing(listing.output, `${RESOURCES_ROOT}/`) : [];
        const running = players.parseInfo(info)?.resources ?? [];
        return foldResources(onDisk, running, guard.GUARD_RESOURCE);
    });
}

/** Start, stop or restart one resource. */
export async function actOnResource(
    ownerId: string,
    installedAppId: string,
    name: string,
    action: ResourceAction
): Promise<string> {
    if (!isResourceName(name)) throw new Error("That is not a resource name");
    if (name.toLowerCase() === guard.GUARD_RESOURCE && action === "stop") {
        throw new Error("That resource is what keeps players off this server. Open the server to everyone instead.");
    }
    return runFivemCommand(ownerId, installedAppId, `${action} ${name}`);
}

/** A resource folder was in the archive but held no manifest. */
const NO_MANIFEST = 96;

/** Nothing in the container could unpack that kind of archive. */
const NO_UNPACKER = 95;

/**
 * Fetch a resource from a link and put it where the server will find it.
 *
 * The other way to get one in is Drive, which browses the same volume and is the
 * right answer for a folder somebody already has. This is for the ordinary case:
 * a resource is published as a release archive, and copying a link is the whole
 * of what an operator wants to do with it.
 *
 * Downloaded and unpacked inside the container, so it lands on the volume the
 * server actually reads with no round trip through the dashboard - a resource
 * can be a few hundred megabytes of streamed assets. The link and the name are
 * both handed over base64-encoded and expanded into quoted shell variables, so
 * neither is ever parsed as part of the command.
 *
 * The folder it installs into is replaced outright rather than merged. A resource
 * updated on top of itself keeps whatever the old version left behind, and a
 * stale file in a resource folder is loaded exactly like a current one.
 */
export async function installResourceFromUrl(
    ownerId: string,
    installedAppId: string,
    url: string,
    name: string
): Promise<void> {
    const archive = resourceArchiveOf(url);
    if (archive === null) throw new Error(RESOURCE_URL_HINT);
    if (!isResourceName(name)) throw new Error("A resource name is letters, digits, dots, dashes and underscores");
    if (name.toLowerCase() === guard.GUARD_RESOURCE) throw new Error("That name belongs to Polaris' own resource");
    const link = Buffer.from(url.trim(), "utf8").toString("base64");
    const folder = Buffer.from(`${RESOURCES_ROOT}/${name}`, "utf8").toString("base64");
    const script = [
        "set -e",
        'work="${TMPDIR:-/tmp}/polaris-resource"',
        `url="$(printf %s ${link} | base64 -d)"`,
        `dest="$(printf %s ${folder} | base64 -d)"`,
        'rm -rf "$work"; mkdir -p "$work/unpacked"',
        'if command -v wget >/dev/null 2>&1; then wget -q -O "$work/archive" "$url";',
        'elif command -v curl >/dev/null 2>&1; then curl -fsSL -o "$work/archive" "$url";',
        `else exit ${NO_HTTP_CLIENT}; fi`,
        // Which unpacker to use is read off the path rather than off the whole
        // link, because a signed one - `.../res.zip?token=...` - ends in neither
        // extension.
        archive === "zip"
            ? `command -v unzip >/dev/null 2>&1 || exit ${NO_UNPACKER}; unzip -q "$work/archive" -d "$work/unpacked"`
            : `command -v tar >/dev/null 2>&1 || exit ${NO_UNPACKER}; tar xzf "$work/archive" -C "$work/unpacked"`,
        // The archive is usually one folder with the resource inside it, and
        // sometimes the resource itself. The manifest is what says which.
        'found="$(find "$work/unpacked" -maxdepth 3 -name fxmanifest.lua -o -maxdepth 3 -name __resource.lua | head -n 1)"',
        `[ -n "$found" ] || exit ${NO_MANIFEST}`,
        'rm -rf "$dest"; mkdir -p "$dest"',
        'cp -a "$(dirname "$found")/." "$dest/"',
        'rm -rf "$work"'
    ].join("\n");
    await withFivemServer(ownerId, installedAppId, async (server) => {
        const result = await server.container.run(["sh", "-c", script]);
        if (result.code === NO_MANIFEST) {
            throw new Error("There is no resource in that archive - it has no fxmanifest.lua anywhere in it.");
        }
        if (result.code === NO_UNPACKER || result.code === NO_HTTP_CLIENT) {
            throw new Error("This server's image cannot unpack that. Redeploy it to get the current one.");
        }
        if (result.code !== 0) {
            const said = result.output.trim().slice(0, 200);
            throw new Error(said.length > 0 ? `That could not be installed: ${said}` : "That could not be installed");
        }
        // On disk is not the same as known about; the server has to be told to look
        // again before the resource can be started.
        await server.rcon("refresh").catch(() => undefined);
    });
}

/** Rescan the folder, so a resource that was just added can be started. */
export async function refreshResources(ownerId: string, installedAppId: string): Promise<string> {
    return runFivemCommand(ownerId, installedAppId, "refresh");
}

/**
 * The console password this server runs on, decrypted for somebody who may
 * already read its secrets.
 *
 * Worth reading back rather than only rotating: it is what a third-party tool
 * would be given, and a server whose password cannot be read is one whose owner
 * has to change it to find out what it is.
 */
export async function revealConsolePassword(ownerId: string, installedAppId: string): Promise<string | null> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    const row = await prisma.envVar.findFirst({
        where: { scopeType: "application", scopeId: applicationId, key: RCON_PASSWORD_VAR },
        select: { id: true }
    });
    if (!row) return null;
    const { revealEnvVar } = await import("@/lib/env-var-service");
    return revealEnvVar(row.id, ownerId).catch(() => null);
}

/**
 * Change it.
 *
 * Both halves, in this order: the config the running server reads, so the change
 * is live, and the deploy's environment, so a container rebuilt from scratch
 * comes up on the same one. Written to the config first because that is the half
 * that can fail - a server that is not up cannot be told - and leaving the
 * environment ahead of the config would lock Polaris out of its own server.
 */
export async function setConsolePassword(ownerId: string, installedAppId: string, password: string): Promise<void> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    if (!access.isConsolePassword(password)) throw new Error(access.CONSOLE_PASSWORD_HINT);
    await withFivemServer(ownerId, installedAppId, async (server) => {
        const cfg = await readContainerFile(server.container, SERVER_CFG);
        if (cfg === null) throw new Error("The server has not written its config yet. Start it once and try again.");
        await writeContainerFile(
            server.container,
            SERVER_CFG,
            writeSetting(cfg, RCON_PASSWORD_KEY, password)
        );
        // The running server keeps the old one until it is told; `set` is how the
        // console changes a variable it already holds.
        await server.rcon(`set rcon_password ${quoteArgument(password)}`).catch(() => undefined);
    });
    await setEnvVars("application", applicationId, ownerId, [
        { key: RCON_PASSWORD_VAR, value: password, isSecret: true }
    ]);
}

/**
 * Change the key the server runs on.
 *
 * Write-only, like every credential on these screens: it is never read back, and
 * a blank is refused rather than written - a server whose key was emptied does
 * not start, and the message it prints says nothing about where the key went.
 *
 * The image passes it on the command line at boot, so the running server keeps
 * the old one until it is restarted. The screen says so rather than restarting
 * underneath whoever is playing.
 */
export async function setLicenseKey(ownerId: string, installedAppId: string, key: string): Promise<void> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    if (!isLicenseKey(key)) throw new Error(LICENSE_KEY_HINT);
    await setEnvVars("application", applicationId, ownerId, [
        { key: LICENSE_KEY_VAR, value: key.trim(), isSecret: true }
    ]);
}

/** Where the server key lives on the deploy. The image reads it under this name. */
const LICENSE_KEY_VAR = "LICENSE_KEY";

/** Where the console password lives in the server's own config. */
const RCON_PASSWORD_KEY: CfgKey = { key: "rcon_password", prefix: "" };

/**
 * Driving an installed ARK server from the dashboard.
 *
 * Every read and every moderation action goes through the server's own RCON,
 * reached by running the `arkmanager` the image already ships inside the running
 * container - the same seam the Minecraft servers are driven through, so it works
 * on the local host and on a registered server over SSH without this file knowing
 * which. Nothing is exposed on the network for it: ARK's RCON port is deliberately
 * not published, and the admin password that opens it is the one the install
 * minted for that container and nothing else.
 *
 * The allow list is the part that cannot be a single command. A server that is
 * still downloading thirty gigabytes cannot be told anything, and it is created
 * closed - so who may join is recorded on the install and handed to the server as
 * soon as it answers. Until then the panel says the difference out loud, because
 * "added" and "the server knows" are not the same state and a moderator has to be
 * able to see which one they are in.
 */

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";
import { withTimeout } from "@polaris/core";
import { findApp } from "@/lib/apps/catalog";
import { setEnvVars } from "@/lib/env-var-service";
import * as arkAccess from "@/lib/apps/ark/access";
import * as arkAdmins from "@/lib/apps/ark/admins";
import { readAppRuntimeLog } from "@/lib/deploy-service";
import { withServerContainer } from "@/lib/apps/minecraft/service";
import { parseArkProfile, type ArkProfile } from "@/lib/apps/ark/profile";
import { readCrashLoop, readRestartWatch } from "@/lib/apps/games-health";
import { ARK_ROOT, readArkFile, writeArkFile } from "@/lib/apps/ark/files";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { crashLoopOf, isCrashLooping, type CrashLoop } from "@/lib/apps/crash-loop";
import { isRconRefusal, parseArkPlayers, type ArkPlayer } from "@/lib/apps/ark/parse";
import { readAppContainerMetricsOrNull, readAppContainerRuntime } from "@/lib/app-container-metrics";

/** Enough to reach past a crash's own noise to the line under it. Paid only for a
 *  container already judged to be looping. */
const CRASH_LOG_TAIL = 600;

/** The catalog id an ARK server install is made from. */
export const ARK_CATALOG_ID = "ark";

/** Long enough for a broadcast, short enough that no single field can carry a
 *  second command into the console. */
const MAX_COMMAND_LENGTH = 512;

/** Reject anything that would turn one command into two, or smuggle a newline into
 *  the console. Arguments are passed as argv and never through a shell, so this is
 *  belt and braces - but a moderation screen is exactly where a crafted name would
 *  arrive. */
function assertSafeCommand(command: string): void {
    if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) throw new Error("That command is not valid");
    if (/[\0\r\n]/.test(command)) throw new Error("That command is not valid");
}

/** How arkmanager is invoked. The image runs the server as `steam` and its own
 *  documentation drives it that way; `gosu` is what the image itself uses to drop
 *  to that account. */
function rconArgv(command: string): string[] {
    return ["gosu", "steam", "arkmanager", "rconcmd", command];
}

/**
 * How long the server gets to answer one command.
 *
 * A command that fails comes back; a container whose connection has wedged does
 * not come back at all, and every caller here is something a person or a sweep is
 * waiting on. Generous, because arkmanager shells out to its own tooling and a
 * loaded server answers in a second or two - this is a bound on hanging, not a
 * performance budget.
 */
const COMMAND_TIMEOUT_MS = 15_000;

/** The output of a command that could not even be started, which is a different
 *  failure from one the server refused - and the only case worth retrying. */
function couldNotStart(result: { code: number; output: string }): boolean {
    return result.code === 126 || result.code === 127 || /not found|no such file/i.test(result.output);
}

/**
 * Run one RCON command and hand back what the server said.
 *
 * Falls back to calling arkmanager directly when dropping to the `steam` account
 * is what failed: an image built without `gosu` would otherwise make every read
 * on the panel look like a server that is not answering.
 */
export async function runArkCommand(ownerId: string, installedAppId: string, command: string): Promise<string> {
    assertSafeCommand(command);
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const bounded = (argv: string[]): Promise<{ code: number; output: string }> =>
            withTimeout(server.run(argv), COMMAND_TIMEOUT_MS, "The server did not answer in time");
        let result = await bounded(rconArgv(command));
        if (result.code !== 0 && couldNotStart(result)) {
            result = await bounded(["arkmanager", "rconcmd", command]);
        }
        if (result.code !== 0 || isRconRefusal(result.output)) {
            const said = result.output.trim();
            throw new Error(
                said.length > 0 && !isRconRefusal(said)
                    ? said.slice(0, 300)
                    : "The server is not accepting commands yet"
            );
        }
        return result.output;
    });
}

/** The first line that says anything, short enough to put in a sentence on a
 *  screen. What a command actually printed is the only thing an operator can act
 *  on when Polaris could not make sense of it. */
function firstLine(output: string): string {
    const line = output
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
    return (line ?? "").slice(0, 200);
}

/** Who is on an ARK server, and whether it is answering at all. */
export interface ArkLive {
    readonly answering: boolean;
    /** Whether the container is actually up, when that can be seen from here. */
    readonly containerRunning: boolean | null;
    readonly players: readonly ArkPlayer[];
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
    /** Set when it is restarting without ever starting, or was stopped for doing
     *  so. The rule is a container rule, so ARK reads it the same way Minecraft
     *  does - see `crash-loop`. */
    readonly crashLoop: CrashLoop | null;
}

/**
 * Ask the running server who is on. A server that is stopped, still installing or
 * still loading its world is a reading that says so, never a throw - the callers
 * list servers.
 *
 * The container is looked at before it is spoken to, which costs one cheap call
 * and saves a page listing stopped servers from waiting out a failing exec for
 * each of them.
 */
export async function getArkPlayers(ownerId: string, installedAppId: string): Promise<ArkLive> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, config: true }
    });
    if (!install?.applicationId) {
        return {
            answering: false,
            containerRunning: null,
            players: [],
            message: "This server has not been deployed yet",
            crashLoop: null
        };
    }
    const app = await prisma.application.findFirst({
        where: { id: install.applicationId },
        select: { desiredState: true }
    });
    if (app?.desiredState !== "running") {
        // A server Polaris stopped for failing to start says so: by now nothing on
        // the container remembers, and "stopped" on its own is the state somebody
        // chose rather than the one that was forced.
        const halted = readCrashLoop(install.config);
        return {
            answering: false,
            containerRunning: null,
            players: [],
            message: halted
                ? `The server kept failing to start, so it has been stopped after ${halted.restarts} restarts.${halted.cause ? ` ${halted.cause}` : ""}`
                : "The server is stopped",
            crashLoop: halted
        };
    }
    const runtime = await readAppContainerRuntime(install.applicationId, ownerId);
    const state = runtime?.status ?? null;
    // Against the reading the sweep took a minute ago: a restart count on its own
    // cannot tell a server that is still looping from one that has just got out.
    if (runtime && isCrashLooping(runtime, readRestartWatch(install.config), new Date())) {
        const loop = crashLoopOf(runtime, await readAppRuntimeLog(install.applicationId, ownerId, CRASH_LOG_TAIL).catch(() => ""));
        return {
            answering: false,
            containerRunning: false,
            players: [],
            message: `The server kept failing to start, so it has been stopped after ${loop.restarts} restarts.${loop.cause ? ` ${loop.cause}` : ""}`,
            crashLoop: loop
        };
    }
    if (state !== null && state !== "running") {
        return {
            answering: false,
            containerRunning: false,
            players: [],
            message: "The container is not running. Redeploy it, or read the logs to see why it stopped.",
            crashLoop: null
        };
    }
    const containerRunning = state === null ? null : true;
    try {
        const said = await runArkCommand(ownerId, installedAppId, "ListPlayers");
        const players = parseArkPlayers(said);
        if (players === null) {
            return {
                answering: false,
                containerRunning,
                players: [],
                // Silence and an answer nobody can read are different faults, and
                // reading both as "still starting" is what hides the second one
                // forever: a server that has been up for an hour keeps reporting
                // that it is booting, and nobody has anything to go on. The first
                // start does take a long while - about thirty gigabytes - so that
                // is what silence means, and anything else is quoted back.
                message:
                    said.trim().length === 0
                        ? "The server is starting. A new one installs about 30 GB first, which takes a while."
                        : `The server answered something Polaris could not read: ${firstLine(said)}`,
                crashLoop: null
            };
        }
        return { answering: true, containerRunning, players, message: null, crashLoop: null };
    } catch (caught) {
        return {
            answering: false,
            containerRunning,
            players: [],
            message: caught instanceof Error ? caught.message : "The server is not answering",
            crashLoop: null
        };
    }
}

/** What is running, what it costs, and who is on it. */
export interface ArkStatus extends ArkLive {
    /** Polaris means it to be up. Not the same as it answering. */
    readonly running: boolean;
    /** Slots, from the setting rather than the running server, so a stopped one
     *  can still say what size it is. */
    readonly max: number | null;
    /**
     * The port a client connects on, and the port the server browser asks on.
     *
     * Both, because ARK is joined two ways and they take different numbers: the
     * console's `open` wants the game port and Steam's server list wants the query
     * port, and pasting one where the other belongs is answered with "server not
     * found" rather than with anything that names the mistake. Read from what the
     * server was actually launched with, not derived - a server whose ports were
     * changed by hand would otherwise be described wrongly by arithmetic.
     */
    readonly gamePort: number | null;
    readonly queryPort: number | null;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number | null;
}

/**
 * The numbers a server was launched with: how many it holds, and the two ports it
 * is joined on.
 *
 * Read from what the deploy actually pinned rather than derived from each other -
 * a server whose ports were changed by hand would otherwise be described wrongly
 * by arithmetic. Its own function because the page renders these before anything
 * has been asked of the server: they are settings, not live state, and a client
 * that waited for the container to answer before printing the address it should
 * connect to had the order exactly backwards.
 */
export async function readArkPorts(
    applicationId: string | null
): Promise<{ max: number | null; gamePort: number | null; queryPort: number | null }> {
    if (!applicationId) return { max: null, gamePort: null, queryPort: null };
    const vars = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: applicationId,
            key: { in: ["MAX_PLAYERS", "GAME_CLIENT_PORT", "SERVER_LIST_PORT"] }
        },
        select: { key: true, value: true }
    });
    const number = (key: string): number | null => {
        const parsed = Number.parseInt(vars.find((row) => row.key === key)?.value ?? "", 10);
        return Number.isFinite(parsed) ? parsed : null;
    };
    return { max: number("MAX_PLAYERS"), gamePort: number("GAME_CLIENT_PORT"), queryPort: number("SERVER_LIST_PORT") };
}

export async function getArkStatus(ownerId: string, installedAppId: string): Promise<ArkStatus> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    const applicationId = install?.applicationId ?? null;
    const [live, usage, app, ports] = await Promise.all([
        getArkPlayers(ownerId, installedAppId),
        applicationId ? readAppContainerMetricsOrNull(applicationId, ownerId) : null,
        applicationId
            ? prisma.application.findFirst({ where: { id: applicationId }, select: { desiredState: true } })
            : null,
        readArkPorts(applicationId)
    ]);
    return {
        ...live,
        running: app?.desiredState === "running",
        max: ports.max,
        gamePort: ports.gamePort,
        queryPort: ports.queryPort,
        cpuPercent: usage?.cpuPercent ?? null,
        memUsedBytes: usage?.memUsedBytes ?? null,
        memTotalBytes: usage?.memTotalBytes ?? null
    };
}

/** Who the server is meant to let in, and whether it is closed to everyone else. */
export interface ArkAccessView {
    /** Whether `-exclusivejoin` is on, which is what makes the list mean anything. */
    readonly closed: boolean;
    /** Whether the server records the chat and the admin commands that were run.
     *  Off, a command it declined leaves no trace to read. */
    readonly logging: boolean;
    readonly players: readonly arkAccess.ArkAllowedPlayer[];
}

export async function readArkAccess(ownerId: string, installedAppId: string): Promise<ArkAccessView> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { config: true, applicationId: true }
    });
    const options = install?.applicationId
        ? await prisma.envVar.findFirst({
              where: { scopeType: "application", scopeId: install.applicationId, key: "ARK_EXTRA_OPTS" },
              select: { value: true }
          })
        : null;
    return {
        closed: arkAccess.isExclusiveJoin(options?.value ?? undefined),
        logging: arkAccess.hasLaunchFlag(options?.value ?? undefined, arkAccess.GAME_LOG),
        players: arkAccess.readAllowList(readInstallConfig(install?.config))
    };
}

/** The allow list as the install holds it, without the ownership check - for the
 *  sweeps, which have already resolved whose server it is. */
async function storedAllowList(installedAppId: string): Promise<arkAccess.ArkAllowedPlayer[]> {
    const install = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return arkAccess.readAllowList(readInstallConfig(install?.config));
}

/**
 * Add a player to the allow list, and tell the server now if it is listening.
 *
 * Recorded first and applied second, deliberately. A server that is down or still
 * installing has to be able to take the decision anyway - it is exactly the moment
 * somebody sets their server up - and the sweep hands it over when it answers.
 */
export async function addAllowedPlayer(
    ownerId: string,
    installedAppId: string,
    player: { steamId: string; label: string }
): Promise<ArkAccessView> {
    if (!arkAccess.isSteamId(player.steamId)) throw new Error("That is not a Steam id");
    const steamId = player.steamId.trim();
    const list = arkAccess.withPlayer(await storedAllowList(installedAppId), { ...player, steamId }, new Date().toISOString());
    await patchInstallConfig(installedAppId, { [arkAccess.ALLOW_LIST_KEY]: list });
    await applyAllowList(ownerId, installedAppId).catch(() => 0);
    return readArkAccess(ownerId, installedAppId);
}

/**
 * Take a player off the list, and off the running server.
 *
 * The server is told first here, unlike adding: a row removed from Polaris while
 * the server still lets that account in is a moderator who thinks somebody is out
 * and is wrong. If the server cannot be told, the removal is refused rather than
 * recorded - the list has to describe the server, not contradict it.
 */
export async function removeAllowedPlayer(
    ownerId: string,
    installedAppId: string,
    steamId: string
): Promise<ArkAccessView> {
    if (!arkAccess.isSteamId(steamId)) throw new Error("That is not a Steam id");
    const access = await readArkAccess(ownerId, installedAppId);
    const known = access.players.find((entry) => entry.steamId === steamId);
    // Only a player the server was actually told about has to be untold. One that
    // never reached it can be dropped from the list whatever the server is doing.
    if (known?.appliedAt) {
        await runArkCommand(ownerId, installedAppId, `DisallowPlayerToJoinNoCheck ${steamId}`);
    }
    await patchInstallConfig(installedAppId, { [arkAccess.ALLOW_LIST_KEY]: arkAccess.withoutPlayer(access.players, steamId) });
    return readArkAccess(ownerId, installedAppId);
}

/**
 * Hand the running server every allowed player it has not been told about, and
 * report how many that was.
 *
 * This is what makes a server that was created closed joinable by the person who
 * created it: at create time there is no server to tell, so the first sweep after
 * it finishes installing is when the door actually opens. Nothing here throws for
 * a server that is not answering - the caller is a poll or a cron walk.
 */
export async function applyAllowList(ownerId: string, installedAppId: string): Promise<number> {
    const list = await storedAllowList(installedAppId);
    const pending = arkAccess.pendingPlayers(list);
    if (pending.length === 0) return 0;
    const applied: string[] = [];
    for (const player of pending) {
        try {
            await runArkCommand(ownerId, installedAppId, `AllowPlayerToJoinNoCheck ${player.steamId}`);
            applied.push(player.steamId);
        } catch {
            // Not answering yet. The next sweep tries again; nothing is marked as
            // told, which is the only state that would be a lie.
            break;
        }
    }
    if (applied.length === 0) return 0;
    const now = new Date().toISOString();
    await patchInstallConfig(installedAppId, {
        [arkAccess.ALLOW_LIST_KEY]: list.map((entry) => (applied.includes(entry.steamId) ? { ...entry, appliedAt: now } : entry))
    });
    return applied.length;
}

/** The application behind an install, refusing the same way for one that is not
 *  the caller's and one that was never deployed. */
async function requireApplication(ownerId: string, installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true }
    });
    if (!install) throw new Error("Server not found");
    if (install.catalogId !== ARK_CATALOG_ID) throw new Error("That is not an ARK server");
    if (!install.applicationId) throw new Error("This server has not been deployed yet");
    return install.applicationId;
}

/**
 * Open or close the server to everyone who is not on the allow list.
 *
 * The flag lives in the same string as every other launch option, so it is
 * rewritten rather than replaced - an operator who added their own flags keeps
 * them. It only takes effect on the next start, which is what the screen says.
 */
export async function setExclusiveJoin(ownerId: string, installedAppId: string, closed: boolean): Promise<void> {
    await setLaunchFlag(ownerId, installedAppId, arkAccess.EXCLUSIVE_JOIN, closed);
}

/**
 * Turn one launch flag on or off, keeping every other flag the server runs with.
 *
 * Both of the switches Polaris offers write into the same string, so they go
 * through one function: two of them each rewriting it from their own idea of what
 * it held would have the second quietly undo the first.
 */
export async function setLaunchFlag(
    ownerId: string,
    installedAppId: string,
    flag: string,
    on: boolean
): Promise<void> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    const current = await prisma.envVar.findFirst({
        where: { scopeType: "application", scopeId: applicationId, key: "ARK_EXTRA_OPTS" },
        select: { value: true }
    });
    await setEnvVars("application", applicationId, ownerId, [
        { key: "ARK_EXTRA_OPTS", value: arkAccess.withLaunchFlag(current?.value ?? "", flag, on), isSecret: false }
    ]);
}

/** Change the password players type to get in. Stored encrypted, and applied on
 *  the next start like every other value the image reads from its environment. */
export async function setJoinPassword(ownerId: string, installedAppId: string, password: string): Promise<void> {
    if (!arkAccess.isJoinPassword(password)) throw new Error("That password is not one ARK will carry");
    const applicationId = await requireApplication(ownerId, installedAppId);
    await setEnvVars("application", applicationId, ownerId, [
        { key: "SERVER_PASSWORD", value: password, isSecret: true }
    ]);
}

/**
 * Change the password that opens the in-game admin console, and RCON with it.
 *
 * The same rules as the join password, and for a sharper reason: this one is typed
 * at ARK's own `enablecheats` prompt, which refuses a long value outright. A
 * server whose admin password it will not take is one nobody can administer from
 * inside the game, and the only way back was to delete it.
 */
export async function setAdminPassword(ownerId: string, installedAppId: string, password: string): Promise<void> {
    if (!arkAccess.isJoinPassword(password)) throw new Error("That password is not one ARK will carry");
    const applicationId = await requireApplication(ownerId, installedAppId);
    await setEnvVars("application", applicationId, ownerId, [
        { key: "ADMIN_PASSWORD", value: password, isSecret: true }
    ]);
}

/** A password nobody had to invent, for the button that offers one and for the
 *  admin password the create flow mints. */
export function mintJoinPassword(): string {
    return arkAccess.generateJoinPassword((size) => new Uint8Array(randomBytes(size)));
}

/**
 * The two passwords the server runs on, decrypted for somebody who may already
 * read the server's secrets.
 *
 * Unlike Minecraft's RCON password these are not internal: the join password is
 * what the operator gives their friends, and the admin one is what they type into
 * the game to run a command. A server whose passwords cannot be read back is one
 * whose owner has to delete it to get in.
 */
export async function revealArkPasswords(
    ownerId: string,
    installedAppId: string
): Promise<{ joinPassword: string | null; adminPassword: string | null }> {
    const applicationId = await requireApplication(ownerId, installedAppId);
    const rows = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: applicationId,
            key: { in: ["SERVER_PASSWORD", "ADMIN_PASSWORD"] }
        },
        select: { id: true, key: true }
    });
    // Imported lazily so the reveal path is the only one that ever touches the
    // master key, and reuses the same owner-gated decrypt the env screen does.
    const { revealEnvVar } = await import("@/lib/env-var-service");
    const read = async (key: string): Promise<string | null> => {
        const row = rows.find((entry) => entry.key === key);
        return row ? revealEnvVar(row.id, ownerId).catch(() => null) : null;
    };
    const [joinPassword, adminPassword] = await Promise.all([read("SERVER_PASSWORD"), read("ADMIN_PASSWORD")]);
    return { joinPassword, adminPassword };
}

/** Write the world to disk now, for before a stop or a settings change. */
export async function saveArkWorld(ownerId: string, installedAppId: string): Promise<void> {
    await runArkCommand(ownerId, installedAppId, "SaveWorld");
}

/** Say something to everyone who is playing. */
export async function broadcastToArk(ownerId: string, installedAppId: string, message: string): Promise<void> {
    await runArkCommand(ownerId, installedAppId, `Broadcast ${message}`);
}

/**
 * Say something to one player.
 *
 * By Steam id rather than by name, deliberately: the by-name form breaks on a
 * name with a space in it, and a moderation message that silently went nowhere is
 * worse than none. The id also cannot be two people.
 */
export async function messageArkPlayer(
    ownerId: string,
    installedAppId: string,
    steamId: string,
    message: string
): Promise<void> {
    if (!arkAccess.isSteamId(steamId)) throw new Error("That is not a Steam id");
    await runArkCommand(ownerId, installedAppId, `ServerChatTo ${steamId.trim()} ${message}`);
}

/** Throw somebody off. They can come straight back unless the allow list or a ban
 *  says otherwise, which is what makes it the mild one of the two. */
export async function kickArkPlayer(ownerId: string, installedAppId: string, steamId: string): Promise<void> {
    if (!arkAccess.isSteamId(steamId)) throw new Error("That is not a Steam id");
    await runArkCommand(ownerId, installedAppId, `KickPlayer ${steamId.trim()}`);
}

/** Refuse them from now on. Separate from the allow list: a ban holds even on a
 *  server that was opened to everybody. */
export async function banArkPlayer(ownerId: string, installedAppId: string, steamId: string): Promise<void> {
    if (!arkAccess.isSteamId(steamId)) throw new Error("That is not a Steam id");
    await runArkCommand(ownerId, installedAppId, `BanPlayer ${steamId.trim()}`);
}

export async function unbanArkPlayer(ownerId: string, installedAppId: string, steamId: string): Promise<void> {
    if (!arkAccess.isSteamId(steamId)) throw new Error("That is not a Steam id");
    await runArkCommand(ownerId, installedAppId, `UnbanPlayer ${steamId.trim()}`);
}

/** Where the game keeps the world, the profiles and the admin list. */
const SAVE_DIR = `${ARK_ROOT}/ShooterGame/Saved`;

const ADMIN_FILE = `${ARK_ROOT}/${arkAdmins.ADMIN_LIST_PATH}`;

/** How many survivors one read will fetch. A profile is a few kilobytes and they
 *  come back in one string, so this is a bound on that string rather than on
 *  anybody's server. */
const MAX_PROFILE_READS = 40;

/**
 * The Steam ids the server lets administer it without the password.
 *
 * Empty for a server that has never been given one, which is also what a server
 * that cannot be reached reports - the caller decides whether that matters. The
 * game reads this file when it starts, so what is in it and what is in force can
 * differ until the next restart; the screen says so.
 */
export async function readArkAdmins(ownerId: string, installedAppId: string): Promise<string[]> {
    return withServerContainer(ownerId, installedAppId, async (server) =>
        arkAdmins.parseAdminList((await readArkFile(server, ADMIN_FILE)) ?? "")
    );
}

/**
 * Make somebody an admin of this server, or take it back.
 *
 * Read, changed and written rather than appended to: the file is edited by hand on
 * plenty of servers, and appending to one that already holds a name would list
 * them twice. Hands back the list as it now stands so the screen never has to
 * guess.
 */
export async function setArkAdmin(
    ownerId: string,
    installedAppId: string,
    steamId: string,
    admin: boolean
): Promise<string[]> {
    if (!arkAccess.isSteamId(steamId)) throw new Error("That is not a Steam id");
    const id = steamId.trim();
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const current = arkAdmins.parseAdminList((await readArkFile(server, ADMIN_FILE)) ?? "");
        const next = admin ? arkAdmins.withAdmin(current, id) : arkAdmins.withoutAdmin(current, id);
        await writeArkFile(server, ADMIN_FILE, arkAdmins.formatAdminList(next));
        return next;
    });
}

/**
 * What level each of these survivors is on, and what they called themselves.
 *
 * Read out of the per-player files the server writes, because ARK has no command
 * that answers it. Only the ids asked for are looked up - the folder also holds
 * the world and every tribe - and a player who has never joined has no file and is
 * simply absent from the result.
 *
 * One shell for all of them: on a registered machine each exec is its own SSH
 * handshake, and a full server would be twenty of them for one column.
 */
export async function readArkProfiles(
    ownerId: string,
    installedAppId: string,
    steamIds: readonly string[]
): Promise<Record<string, ArkProfile>> {
    const wanted = [...new Set(steamIds)].filter((id) => arkAccess.isSteamId(id)).slice(0, MAX_PROFILE_READS);
    if (wanted.length === 0) return {};
    return withServerContainer(ownerId, installedAppId, async (server) => {
        // The ids are seventeen digits and nothing else, which is what makes them
        // safe to name in the loop below.
        const script = [
            `for id in ${wanted.join(" ")}; do`,
            `f=$(find ${SAVE_DIR} -maxdepth 3 -name "$id.arkprofile" 2>/dev/null | head -n 1);`,
            'if [ -n "$f" ]; then echo "== $id"; base64 "$f" | tr -d \'\\n\'; echo; fi;',
            "done"
        ].join(" ");
        const result = await server.run(["sh", "-c", script]);
        if (result.code !== 0) return {};
        return readProfileDump(result.output);
    });
}

/** The profiles out of that dump: a line naming the player, then one line of
 *  base64. Anything else in the output - a warning from `find`, a shell notice -
 *  is skipped rather than parsed. */
function readProfileDump(output: string): Record<string, ArkProfile> {
    const found: Record<string, ArkProfile> = {};
    const lines = output.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const header = /^== (\d{17})$/.exec(lines[index] ?? "");
        if (!header?.[1]) continue;
        const encoded = (lines[index + 1] ?? "").trim();
        index += 1;
        if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) continue;
        try {
            found[header[1]] = parseArkProfile(Buffer.from(encoded, "base64"));
        } catch {
            // A file that cannot be read is a player with no level, not a screen
            // that fails to draw.
        }
    }
    return found;
}

/** Whether an install is an ARK server, for the callers that dispatch on it. */
export function isArkServer(catalogId: string): boolean {
    return catalogId === ARK_CATALOG_ID && findApp(catalogId) !== undefined;
}

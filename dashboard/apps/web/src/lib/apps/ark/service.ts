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
import { findApp } from "@/lib/apps/catalog";
import { setEnvVars } from "@/lib/env-var-service";
import * as arkAccess from "@/lib/apps/ark/access";
import { withServerContainer } from "@/lib/apps/minecraft/service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { isRconRefusal, parseArkPlayers, type ArkPlayer } from "@/lib/apps/ark/parse";
import { readAppContainerMetricsOrNull, readAppContainerState } from "@/lib/app-container-metrics";

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
        let result = await server.run(rconArgv(command));
        if (result.code !== 0 && couldNotStart(result)) {
            result = await server.run(["arkmanager", "rconcmd", command]);
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
        select: { applicationId: true }
    });
    if (!install?.applicationId) {
        return { answering: false, containerRunning: null, players: [], message: "This server has not been deployed yet" };
    }
    const app = await prisma.application.findFirst({
        where: { id: install.applicationId },
        select: { desiredState: true }
    });
    if (app?.desiredState !== "running") {
        return { answering: false, containerRunning: null, players: [], message: "The server is stopped" };
    }
    const state = await readAppContainerState(install.applicationId, ownerId);
    if (state !== null && state !== "running") {
        return {
            answering: false,
            containerRunning: false,
            players: [],
            message: "The container is not running. Redeploy it, or read the logs to see why it stopped."
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
                        : `The server answered something Polaris could not read: ${firstLine(said)}`
            };
        }
        return { answering: true, containerRunning, players, message: null };
    } catch (caught) {
        return {
            answering: false,
            containerRunning,
            players: [],
            message: caught instanceof Error ? caught.message : "The server is not answering"
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
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number | null;
}

export async function getArkStatus(ownerId: string, installedAppId: string): Promise<ArkStatus> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    const applicationId = install?.applicationId ?? null;
    const [live, usage, app, slots] = await Promise.all([
        getArkPlayers(ownerId, installedAppId),
        applicationId ? readAppContainerMetricsOrNull(applicationId, ownerId) : null,
        applicationId
            ? prisma.application.findFirst({ where: { id: applicationId }, select: { desiredState: true } })
            : null,
        applicationId
            ? prisma.envVar.findFirst({
                  where: { scopeType: "application", scopeId: applicationId, key: "MAX_PLAYERS" },
                  select: { value: true }
              })
            : null
    ]);
    const max = Number.parseInt(slots?.value ?? "", 10);
    return {
        ...live,
        running: app?.desiredState === "running",
        max: Number.isFinite(max) ? max : null,
        cpuPercent: usage?.cpuPercent ?? null,
        memUsedBytes: usage?.memUsedBytes ?? null,
        memTotalBytes: usage?.memTotalBytes ?? null
    };
}

/** Who the server is meant to let in, and whether it is closed to everyone else. */
export interface ArkAccessView {
    /** Whether `-exclusivejoin` is on, which is what makes the list mean anything. */
    readonly closed: boolean;
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
    const applicationId = await requireApplication(ownerId, installedAppId);
    const current = await prisma.envVar.findFirst({
        where: { scopeType: "application", scopeId: applicationId, key: "ARK_EXTRA_OPTS" },
        select: { value: true }
    });
    await setEnvVars("application", applicationId, ownerId, [
        { key: "ARK_EXTRA_OPTS", value: arkAccess.withExclusiveJoin(current?.value ?? "", closed), isSecret: false }
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

/** Whether an install is an ARK server, for the callers that dispatch on it. */
export function isArkServer(catalogId: string): boolean {
    return catalogId === ARK_CATALOG_ID && findApp(catalogId) !== undefined;
}

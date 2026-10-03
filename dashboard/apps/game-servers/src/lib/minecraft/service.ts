/**
 * Driving an installed Minecraft server from the dashboard.
 *
 * Every read and every moderation action goes through the server's own RCON,
 * reached by running the `rcon-cli` the image already ships inside the running
 * container - the same seam Polaris provisions a database through, so it works
 * on the local host (via the daemon) and on a registered server (over SSH)
 * without this file knowing which. Nothing is exposed on the network for it: no
 * RCON port is published, and the password is the one the install minted for
 * that container and nothing else.
 *
 * The roster (ops, whitelist, bans) is read from the server's own JSON files
 * instead of scraped from command output, because those files are a schema and
 * the console text is prose that changes between versions.
 */

import * as parse from "./parse";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { inRconTurn } from "./rcon-turn";
import { keyedTurns } from "../turns";
import { liveContext } from "./live-values";
import { gameMessage } from "../game-message";
import { gameServerAddress } from "./address";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppHostTypes } from "@polaris/app-host";
import { readContainerFile } from "../container-files";
import { gameOfServer, withTimeout } from "@polaris/core";
import { readsPlayerList, readsServer } from "./text-vars";
import { sayEachReplies, sayEachScript } from "./say-each";
import { hiddenFromPending, hiddenFromPendingArgv, PENDING_READ, pendingNames, withoutPending } from "./prelogin";
import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";
import { readCrashLoop, readRestartWatch } from "../games-health";
import { experienceCommand, type ExperienceChange } from "./experience";
import { parsePlayerSessions, type PlayerSessionEvent } from "./sessions";
import { broadcastArgv, consoleBroadcastArgv, sayArgv } from "./broadcast";
import { crashLoopOf, isCrashLooping, type CrashLoop } from "../crash-loop";
import type { ExecResult, RuntimePorts, WorldTrimOptions } from "@polaris/deploy";
import { audienceNames, namedByPolaris, parseTarget, type Roster } from "./announce-target";
import { announcementCommands, announcementProblems, type Announcement } from "./announcement";
import { NO_PLAYER_LOG, nextPlayerLog, playerLogScript, type PlayerLogState } from "./player-log";

const { resolveWaf } = host.wafService;
const { getHostLanIp } = host.hostAddress;
const { currentReleaseRef } = host.deployReleases;
const { getPorts } = host.deployRuntime;
const { hostPortForApp, readAppRuntimeLog } = host.deployService;
const { readAppContainerMetricsOrNull, readAppContainerRuntime } = host.appContainerMetrics;
type TargetRow = AppHostTypes["TargetRow"];

/** Where the server's data lives inside the container (the image's own /data). */
const DATA_DIR = "/data";

/**
 * Which Minecraft this is. The two editions are managed the same way from the
 * outside and differently underneath: Java answers commands over RCON, while
 * Bedrock has no RCON at all - its commands go to the server's console and its
 * answers come back only in the log.
 */
export type MinecraftEdition = "java" | "bedrock";

export function editionOf(catalogId: string): MinecraftEdition {
    return catalogId === "minecraft-bedrock" ? "bedrock" : "java";
}

/** How long to give the Bedrock console to print an answer we then read back. */
const CONSOLE_ANSWER_MS = 700;

/**
 * How long the server gets to answer one command.
 *
 * A refused command comes back with an error; a container whose connection has
 * wedged never comes back at all, and every caller of this is a screen or a sweep
 * waiting on it. A bound turns that into a failure somebody can read instead of a
 * page that loads forever.
 */
const COMMAND_TIMEOUT_MS = 15_000;

/** More words than any command the panel builds, and far fewer than a list
 *  somebody assembled. */
const MAX_COMMAND_ARGUMENTS = 24;

export interface MinecraftStatus {
    /** Which Minecraft this is; the screens offer what the edition supports. */
    readonly edition: MinecraftEdition;
    /** Polaris is meant to be keeping it up. Not the same as it being up: a
     *  container that crashed, was killed, or was stopped outside Polaris leaves
     *  this true and `containerRunning` false, and reporting only this is what had
     *  a dead server showing "Starting" for as long as anybody watched it. */
    readonly running: boolean;
    /** Whether the container is actually up. Null when it cannot be seen from
     *  here - a server on a registered machine, which the daemon proxy does not
     *  reach. */
    readonly containerRunning: boolean | null;
    /** The server answered RCON - it is up AND past its startup. */
    readonly answering: boolean;
    readonly players: parse.PlayerList;
    /** host:port a player types into their client, when it can be determined. */
    readonly address: string | null;
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
    /** What the container is using, from the same sampling the rest of Polaris
     *  does. Null on a remote target, where the daemon proxy does not reach. */
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number | null;
    /** Set when the server is restarting without ever starting, or was stopped for
     *  doing so. The one state that used to be indistinguishable from a slow boot. */
    readonly crashLoop: CrashLoop | null;
}

/** Addresses the Polaris firewall blocks for this server, and whether the server
 *  itself has been told about them. Minecraft bans one address at a time, so a
 *  range the firewall holds cannot be handed to it. */
export interface MinecraftFirewall {
    readonly blocked: readonly string[];
    readonly applied: readonly string[];
    /** Firewall entries that are ranges, which the game cannot ban. */
    readonly ranges: readonly string[];
}

export interface MinecraftRoster {
    readonly ops: readonly string[];
    readonly whitelist: readonly string[];
    readonly bans: readonly parse.BanEntry[];
    /** Whether the whitelist is actually being enforced (`white-list` in
     *  server.properties). A list that is not enforced lets everyone in. */
    readonly whitelistEnforced: boolean;
}

/** The install, its application and the target it runs on. */
export interface MinecraftInstall {
    readonly installedAppId: string;
    /** What Polaris calls the server: the value of `{server.name}`. */
    readonly name: string;
    readonly applicationId: string;
    readonly container: string;
    readonly portSubject: string;
    readonly target: TargetRow & { hostId: string | null };
    readonly running: boolean;
    readonly edition: MinecraftEdition;
    /** The host port the deploy published this server on, when it pinned one. */
    readonly hostPort: number | null;
    /** The name on the operator's domain this server answers to, when it has one. */
    readonly hostname: string | null;
    /** Whether that name carries the port for the client (a Java SRV record). */
    readonly portless: boolean;
    /** The install's own config, as stored. Carried so a stopped server can still
     *  say why Polaris stopped it, which nothing on the container knows any more. */
    readonly config: string | null;
}

/**
 * Installs already resolved in this scope, by owner and id.
 *
 * One poll of a server's page asks the same install for its status, its roster,
 * its firewall and its log, and each of those used to resolve it on its own -
 * the same three queries four times over for one answer. Inside a scope opened
 * by `sharingInstallReads` the first resolution is handed to the rest. Outside
 * one nothing is shared, so a verb never acts on a reading older than itself.
 */
const sharedInstalls = new AsyncLocalStorage<Map<string, Promise<MinecraftInstall>>>();

/** Run `work` with every install it resolves resolved once. For a poll that
 *  gathers several answers about the same server at the same moment, and the
 *  upkeep that rides on it - never around a change somebody asked for, which has
 *  to see the state it is changing. */
export function sharingInstallReads<T>(work: () => Promise<T>): Promise<T> {
    return sharedInstalls.run(new Map(), work);
}

/** Resolve an installed app to the container its server runs in, asserting the
 *  caller owns it. Throws a client-safe message when it has no deployment yet. */
async function resolveInstall(ownerId: string, installedAppId: string): Promise<MinecraftInstall> {
    const shared = sharedInstalls.getStore();
    if (!shared) return loadInstall(ownerId, installedAppId);
    const key = `${ownerId}|${installedAppId}`;
    const held = shared.get(key) ?? loadInstall(ownerId, installedAppId);
    shared.set(key, held);
    return held;
}

async function loadInstall(ownerId: string, installedAppId: string): Promise<MinecraftInstall> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: INSTALL_FIELDS
    });
    if (!install) throw new Error(gameMessage("games", "lib.appNotFound"));
    if (!install.applicationId) throw new Error(gameMessage("games", "lib.notDeployed"));
    const app = await prisma.application.findFirst({
        where: { id: install.applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) throw new Error(gameMessage("games", "lib.deploymentGone"));
    return installFrom(install, app, await currentReleaseRef(app));
}

/**
 * The same for many servers at once, for the watcher that asks every one of an
 * owner's servers who is on it every few seconds: two queries for the lot
 * rather than two per server. A server that cannot be resolved is simply absent,
 * and the caller asks for it on its own, which is what says why.
 */
export async function resolveInstalls(
    ownerId: string,
    installedAppIds: readonly string[]
): Promise<Map<string, MinecraftInstall>> {
    if (installedAppIds.length === 0) return new Map();
    const installs = await prisma.installedApp.findMany({
        where: { id: { in: [...installedAppIds] }, ownerId, status: { not: "removed" } },
        select: INSTALL_FIELDS
    });
    const deployed = installs.filter(
        (install): install is typeof install & { applicationId: string } =>
            install.applicationId !== null
    );
    if (deployed.length === 0) return new Map();
    const apps = await prisma.application.findMany({
        where: {
            id: { in: deployed.map((install) => install.applicationId) },
            environment: { project: { ownerId } }
        },
        include: { environment: { include: { project: true } }, target: true }
    });
    const appOf = new Map(apps.map((app) => [app.id, app]));
    const resolved = await Promise.all(
        deployed.map(async (install) => {
            const app = appOf.get(install.applicationId);
            if (!app) return null;
            try {
                return installFrom(install, app, await currentReleaseRef(app));
            } catch {
                return null;
            }
        })
    );
    return new Map(
        resolved
            .filter((install): install is MinecraftInstall => install !== null)
            .map((install) => [install.installedAppId, install])
    );
}

/** The columns of the install row a server is resolved from. */
const INSTALL_FIELDS = {
    id: true,
    name: true,
    catalogId: true,
    applicationId: true,
    config: true
} as const;

function installFrom(
    install: { id: string; name: string; catalogId: string; config: string },
    app: {
        id: string;
        sourceConfig: string;
        desiredState: string;
        target: MinecraftInstall["target"];
    },
    release: { name: string; portSubject: string }
): MinecraftInstall {
    let hostPort: number | null = null;
    try {
        const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
        if (typeof config.hostPort === "number") hostPort = config.hostPort;
    } catch {
        // An unreadable config pins no port; the derived one still applies.
    }
    let hostname: string | null = null;
    let portless = false;
    try {
        const config = JSON.parse(install.config) as { hostname?: unknown; portless?: unknown };
        if (typeof config.hostname === "string") hostname = config.hostname;
        portless = config.portless === true;
    } catch {
        // No name recorded; the address falls back to the machine's own.
    }
    return {
        installedAppId: install.id,
        name: install.name,
        applicationId: app.id,
        container: release.name,
        portSubject: release.portSubject,
        target: app.target,
        running: app.desiredState === "running",
        edition: editionOf(install.catalogId),
        hostPort,
        hostname,
        portless,
        config: install.config
    };
}

/** The container as the host's container reader takes it, so it is not resolved
 *  a second time there. */
function containerOf(install: MinecraftInstall): { name: string; targetKind: string } {
    return { name: install.container, targetKind: install.target.kind };
}

/** Open the target's ports, run one piece of work, and always close them. */
async function withPorts<T>(
    install: MinecraftInstall,
    ownerId: string,
    run: (ports: RuntimePorts) => Promise<T>
): Promise<T> {
    const ports = await getPorts(install.target, ownerId);
    try {
        return await run(ports);
    } finally {
        await ports.dispose();
    }
}

/** Reject anything that would turn one command into two, or smuggle a newline
 *  into the console. Arguments are passed as argv, never through a shell, so
 *  this is belt and braces - but a moderation screen is exactly where a crafted
 *  player name would arrive. */
function assertSafeArgument(value: string): void {
    if (value.length === 0 || commandBytes(value) > COMMAND_BYTES_MAX)
        throw new Error(gameMessage("games", "lib.commandInvalid"));
    if (/[\0\r\n]/.test(value)) throw new Error(gameMessage("games", "lib.commandInvalid"));
}

/**
 * The same, over a whole command, asserted where every command actually leaves.
 *
 * On the way out rather than on the callers, because there is more than one way
 * in and only one way out: a moderation verb reaches the game through
 * `ServerContainer.say` as well as through `runServerCommand`, and a reason
 * field is trimmed at its ends and may still carry a newline in the middle. On
 * Bedrock a command is written to the server's console, so that newline is a
 * second console line: a line of the reader's choosing, run by a server that
 * only meant to say why somebody was banned. Moderating and using the console
 * are two separate permissions, and this is what keeps them that way.
 */
function assertSafeCommand(argv: readonly string[]): void {
    if (argv.length === 0 || argv.length > MAX_COMMAND_ARGUMENTS)
        throw new Error(gameMessage("games", "lib.commandInvalid"));
    for (const argument of argv) assertSafeArgument(argument);
}

/**
 * Run one server command and hand back what the server said. `argv` is the
 * command as the server sees it ("whitelist", "add", "Alice"), not a line to be
 * split - so a player name with a space in it can never become two arguments.
 */
export async function runServerCommand(
    ownerId: string,
    installedAppId: string,
    argv: readonly string[]
): Promise<string> {
    assertSafeCommand(argv);
    const install = await resolveInstall(ownerId, installedAppId);
    return execCommand(install, ownerId, argv);
}

/**
 * Say something to everybody on the server, from Polaris.
 *
 * Written rather than said (`broadcast.ts`): `say` quotes whoever sent it, and
 * over RCON that is a source the server calls `Rcon`, so a scheduled warning
 * reached players as `[Rcon] ...`.
 *
 * Falls back to `say` if the server will not take the written form - a server old
 * enough or odd enough to refuse `tellraw` still has to be able to warn the people
 * on it that it is going down, and an announcement that did not arrive is worse
 * than one that arrives with the wrong name on it.
 */
export async function broadcastToMinecraft(
    ownerId: string,
    installedAppId: string,
    message: string
): Promise<void> {
    const install = await resolveInstall(ownerId, installedAppId);
    try {
        await execCommand(install, ownerId, broadcastArgv(install.edition, message));
    } catch {
        await execCommand(install, ownerId, sayArgv(message));
    }
}

/**
 * Send an announcement: its title, subtitle, action bar, chat line and sound, as
 * the commands `announcement.ts` builds for this server's edition, in order.
 *
 * Built here from what was asked for rather than taken as commands from the
 * browser, so the only thing a screen can send through this is an announcement.
 * Each command is one argument, like a console line, and a command the server
 * refuses stops the rest: a subtitle with no title after it is a subtitle
 * nobody sees.
 */
export async function sendAnnouncement(
    ownerId: string,
    installedAppId: string,
    announcement: Announcement,
    /** Who sent it, for the line that repeats it in the linked chat. None
     *  repeats it nowhere. */
    actorId: string | null = null
): Promise<number> {
    const install = await resolveInstall(ownerId, installedAppId);
    // The editor runs the same check as it is typed; this is the one that
    // decides, with the edition the editor may not have been told.
    const problem = Object.values(
        announcementProblems(announcement, install.edition, Date.now(), {
            "server.name": install.name
        })
    )[0];
    if (problem) throw new Error(problem);

    const texts = [
        announcement.title,
        announcement.subtitle,
        announcement.actionbar,
        announcement.chat
    ];
    const players = texts.some((text) => readsPlayerList(text))
        ? await shownPlayerList(install, ownerId).catch(() => null)
        : null;
    // Every player's figures, for a leaderboard. Loaded when asked for: the
    // module that reads them reads the server through this one.
    const figures = async () =>
        (await import("./stats-service")).readAllPlayerStats(ownerId, installedAppId);
    // The log and everybody's level only for a text that reads them.
    const context = texts.some((text) => readsServer(text))
        ? await withServerContainer(ownerId, installedAppId, (server) =>
              liveContext(installedAppId, texts, players, server.running ? server : null, figures)
          ).catch(() => liveContext(installedAppId, texts, players, null, figures))
        : await liveContext(installedAppId, texts, players);
    // Operators, and everybody but them, are Polaris's word, not the game's:
    // they become the names of the ones on the server now.
    const audience = parseTarget(announcement.target);
    const withNames =
        audience && namedByPolaris(audience)
            ? {
                  ...context,
                  named: audienceNames(audience, await rosterOnline(install, ownerId, players))
              }
            : context;
    const lines = announcementCommands(install.edition, announcement, withNames);
    if (lines.length === 0) throw new Error(gameMessage("games", "lib.nothingToSend"));
    for (const line of lines) {
        if (commandBytes(line) > COMMAND_BYTES_MAX) {
            throw new Error(gameMessage("games", "lib.tooMuchFormatting"));
        }
        assertSafeArgument(line);
        await execCommand(install, ownerId, [line]);
    }
    // Repeated in the chat the server is linked to, where the link asks for it,
    // with the values the players were shown.
    if (actorId) {
        await (
            await import("./chat-link-service")
        ).mirrorAnnouncement(
            installedAppId,
            install.name,
            install.config,
            announcement,
            context.values,
            actorId
        );
    }
    return lines.length;
}

/**
 * A console line the operator typed - except a line that talks to players, which
 * is written as Polaris rather than as `Rcon` (`consoleBroadcastArgv`).
 *
 * Sent as ONE argument, not split on whitespace. Both ways into the game join
 * their arguments with a space anyway, so splitting bought nothing - and it cost
 * every long `tellraw`: its JSON is dozens of words, and past the argument cap
 * the guard refused the whole line as "not valid" before it left.
 */
export async function runConsoleLine(
    ownerId: string,
    installedAppId: string,
    line: string
): Promise<string> {
    const trimmed = line.trim().replace(/^\//, "");
    assertSafeArgument(trimmed);
    const install = await resolveInstall(ownerId, installedAppId);
    const written = consoleBroadcastArgv(install.edition, trimmed);
    if (written) {
        try {
            return await execCommand(install, ownerId, written);
        } catch {
            // A server that will not take the written form still gets the line
            // as typed: arriving as `[Rcon]` beats not arriving.
        }
    }
    return runServerCommand(ownerId, installedAppId, [trimmed]);
}

/**
 * Run a command on the server and hand back whatever came back.
 *
 * Java answers over RCON, so the answer is the return value. Bedrock has no RCON:
 * the command is written to the server's console and the answer is only printed
 * to its log, so there is nothing to return - which is why anything that needs an
 * answer (the player list) reads the log on Bedrock instead of this.
 */
async function execCommand(
    install: MinecraftInstall,
    ownerId: string,
    argv: readonly string[]
): Promise<string> {
    return withPorts(install, ownerId, (ports) => sendGameCommand(ports, install, argv));
}

/** A command in the container, in the server's RCON turn when it talks to the game. */
function runInContainer(
    ports: RuntimePorts,
    install: MinecraftInstall,
    argv: readonly string[]
): Promise<ExecResult> {
    return argv.some((part) => part.includes("rcon-cli"))
        ? inRconTurn(install.installedAppId, () => ports.runIn(install.container, argv))
        : ports.runIn(install.container, argv);
}

/**
 * A command as the players should get it: on Java, whatever shows something to
 * somebody is narrowed to the players who have logged in (`prelogin.ts`), so a
 * player still at Polaris login's prompt sees that prompt and nothing else.
 * Bedrock has no Polaris login, and its lines are sent as they are.
 */
function forThePlayersIn(install: MinecraftInstall, argv: readonly string[]): readonly string[] {
    return install.edition === "java" ? hiddenFromPendingArgv(argv) : argv;
}

/** The same, on ports that are already open. */
async function sendGameCommand(
    ports: RuntimePorts,
    install: MinecraftInstall,
    given: readonly string[]
): Promise<string> {
    const argv = forThePlayersIn(install, given);
    assertSafeCommand(argv);
    const command =
        install.edition === "bedrock" ? ["send-command", ...argv] : ["rcon-cli", ...argv];
    const result = await inRconTurn(install.installedAppId, () =>
        withTimeout(
            ports.runIn(install.container, command),
            COMMAND_TIMEOUT_MS,
            gameMessage("games", "lib.noAnswerInTime")
        )
    );
    if (result.code !== 0) {
        // rcon-cli fails the same way for a server that is still generating its
        // world and for one that has crashed; say what an operator can act on.
        throw new Error(
            result.output.trim().length > 0 && !/connection refused/i.test(result.output)
                ? result.output.trim().slice(0, 300)
                : gameMessage("games", "lib.notAcceptingCommands")
        );
    }
    return result.output;
}

/**
 * A running server's container, held open for a piece of work that needs several
 * commands.
 *
 * Everything above runs one command and closes the connection behind it, which is
 * right for a poll and wrong for anything that has to flush the world, read a
 * directory, unpack an archive and move folders - on a registered machine each of
 * those would be its own SSH handshake. So the work that comes in bursts gets the
 * ports once and keeps them for as long as it needs.
 *
 * `run` is the container itself (`tar`, `mv`, `du`) and `say` is the game inside
 * it (RCON on Java, the console on Bedrock). Both refuse the same way the rest of
 * this file does: a message an operator can act on, never a daemon's own.
 */
export interface ServerContainer {
    readonly installedAppId: string;
    readonly applicationId: string;
    readonly edition: MinecraftEdition;
    /** Whether Polaris means it to be up. Not the same as it answering. */
    readonly running: boolean;
    /** Run a command in the container and hand back how it went. */
    run(argv: readonly string[]): Promise<ExecResult>;
    /** Run one and refuse unless it worked, with the output as the reason. */
    runOk(argv: readonly string[], failure: string): Promise<string>;
    /** Send a command to the game and hand back what it said. */
    say(argv: readonly string[]): Promise<string>;
    /**
     * Send several whole command lines to the game, as few trips to the
     * container as it takes: on Java the console tool reads them one per line
     * from its input. Each line is held to the same checks as `say`, and one
     * the batch did not take is sent again on its own.
     */
    sayAll(lines: readonly string[]): Promise<void>;
    /**
     * Send several commands and hand back each one's answer, in as few trips to
     * the container as fit (see `say-each`). Null for an answer that did not
     * arrive whole - ask that one again with `say`. Optional so a stand-in for a
     * server can leave it out; everything that uses it falls back to `say`.
     */
    sayEach?(commands: readonly (readonly string[])[]): Promise<(string | null)[]>;
    /**
     * Stream a file out of the container, as bytes.
     *
     * `run` collects its output into a string, which is right for a command's
     * answer and wrong for a world archive - so copying one off the server to
     * somewhere it survives the disk uses this instead. Works on a remote target
     * as well as the local host, which reading through the daemon directly does
     * not.
     */
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    /**
     * Run the world optimizer against this server's files, with the server down.
     *
     * Not a use of `run`: that is a command inside a container that is up, and the
     * whole safety of this one is that the container is not. The machine checks
     * that itself - the daemon on the local host, the engine over SSH - rather
     * than taking this side's word for it.
     *
     * Null where the machine has no route for it, which is an older host daemon
     * and nothing worse: the world is then left exactly as it is.
     */
    trimWorld: null | ((script: string, options: WorldTrimOptions) => Promise<ExecResult>);
}

export async function withServerContainer<T>(
    ownerId: string,
    installedAppId: string,
    work: (server: ServerContainer) => Promise<T>
): Promise<T> {
    const install = await resolveInstall(ownerId, installedAppId);
    return withPorts(install, ownerId, async (ports) => work(containerOn(install, ports)));
}

/**
 * The same container, held open until `close` rather than for one piece of
 * work: for a caller that sends to it several times a second, where opening the
 * ports each time would be a query and, on a registered machine, a handshake a
 * frame. The caller owns the lifetime and must close it.
 */
export async function openServerContainer(
    ownerId: string,
    installedAppId: string
): Promise<{ server: ServerContainer; close: () => Promise<void> }> {
    const install = await resolveInstall(ownerId, installedAppId);
    const ports = await getPorts(install.target, ownerId);
    return { server: containerOn(install, ports), close: () => ports.dispose() };
}

function containerOn(install: MinecraftInstall, ports: RuntimePorts): ServerContainer {
    return {
        installedAppId: install.installedAppId,
        applicationId: install.applicationId,
        edition: install.edition,
        running: install.running,
        run: (argv) => runInContainer(ports, install, argv),
        runOk: async (argv, failure) => {
            const result = await runInContainer(ports, install, argv);
            if (result.code !== 0) throw new Error(containerFailure(result.output, failure));
            return result.output;
        },
        say: (argv) => sendGameCommand(ports, install, argv),
        sayAll: (lines) => sendGameLines(ports, install, lines),
        sayEach: (commands) => sendGameCommands(ports, install, commands),
        readFile: (path) => ports.readFile(install.container, path),
        trimWorld: ports.trimWorld
            ? (script, options) => ports.trimWorld!(install.container, script, options)
            : null
    };
}

/**
 * Several commands and their answers, one trip into the container per batch.
 *
 * Java only: Bedrock's console answers nowhere a command can read back, so it
 * takes them one at a time. In one RCON turn, so nothing else's answer lands in
 * between. A batch the container refused is answered as missing, which the
 * caller asks again one command at a time.
 */
async function sendGameCommands(
    ports: RuntimePorts,
    install: MinecraftInstall,
    given: readonly (readonly string[])[]
): Promise<(string | null)[]> {
    const commands = given.map((argv) => forThePlayersIn(install, argv));
    for (const argv of commands) assertSafeCommand(argv);
    if (commands.length === 0) return [];
    if (install.edition !== "java") {
        const answers: (string | null)[] = [];
        for (const argv of commands)
            answers.push(await sendGameCommand(ports, install, argv).catch(() => null));
        return answers;
    }
    const result = await inRconTurn(install.installedAppId, () =>
        withTimeout(
            ports.runIn(install.container, ["sh", "-c", sayEachScript(commands)]),
            COMMAND_TIMEOUT_MS * 2,
            gameMessage("games", "lib.noAnswerInTime")
        )
    );
    return sayEachReplies(result.output, commands.length);
}

/** Room for one batch in a command's arguments, in base64 characters. */
const BATCH_MAX = 12_000;

async function sendGameLines(
    ports: RuntimePorts,
    install: MinecraftInstall,
    given: readonly string[]
): Promise<void> {
    const lines =
        install.edition === "java" ? given.map((line) => hiddenFromPending(line)) : given;
    for (const line of lines) assertSafeCommand([line]);
    if (install.edition !== "java") {
        for (const line of lines) await sendGameCommand(ports, install, [line]);
        return;
    }
    const batches: string[][] = [];
    let current: string[] = [];
    for (const line of lines) {
        const size = Buffer.byteLength([...current, line].join("\n")) * 1.4;
        if (current.length > 0 && size > BATCH_MAX) {
            batches.push(current);
            current = [];
        }
        current.push(line);
    }
    if (current.length > 0) batches.push(current);
    for (const batch of batches) {
        const encoded = Buffer.from(`${batch.join("\n")}\n`, "utf8").toString("base64");
        const result = await inRconTurn(install.installedAppId, () =>
            withTimeout(
                ports.runIn(install.container, [
                    "sh",
                    "-c",
                    `printf %s ${encoded} | base64 -d | rcon-cli`
                ]),
                COMMAND_TIMEOUT_MS,
                gameMessage("games", "lib.noAnswerInTime")
            )
        );
        if (result.code !== 0) {
            for (const line of batch) await sendGameCommand(ports, install, [line]);
        }
    }
}

/**
 * Why a command in the container failed, in a sentence.
 *
 * The container's own output is worth showing when there is any - "No space left
 * on device" is the whole answer to a backup that would not write - but the
 * daemon's refusal for a container that is not up names a hash nobody has seen,
 * so that one is replaced.
 */
function containerFailure(output: string, failure: string): string {
    const said = output.trim();
    if (said.length === 0 || /is not running|no such container/i.test(said)) {
        return gameMessage("games", "lib.startFirst", { failure });
    }
    return gameMessage("games", "lib.failureSaid", { failure, said: said.slice(0, 200) });
}

/** Read one of the server's own files out of the container. Empty when it does
 *  not exist yet - a server that has never had an op has no ops.json. */
async function readServerFile(
    install: MinecraftInstall,
    ownerId: string,
    name: string
): Promise<string> {
    // Through the reader that finishes what one command cannot carry: a
    // whitelist or a ban list is past that limit long before anybody notices.
    const content = await withPorts(install, ownerId, (ports) =>
        readContainerFile(
            {
                run: (argv) => runInContainer(ports, install, argv),
                readFile: (path) => ports.readFile(install.container, path)
            },
            `${DATA_DIR}/${name}`
        )
    );
    return content ?? "";
}

/** Who is on and whether the server is answering at all. */
export interface MinecraftPlayers {
    readonly answering: boolean;
    readonly players: parse.PlayerList;
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
    /** Whether the container was up when it was asked. Null when that cannot be
     *  seen from here. */
    readonly containerRunning: boolean | null;
    /** Why it will not start, when it is failing to rather than taking its time. */
    readonly crashLoop: CrashLoop | null;
}

/** Who is on, where to reach the server, and whether it is answering at all. */
export async function getServerStatus(
    ownerId: string,
    installedAppId: string
): Promise<MinecraftStatus> {
    const install = await resolveInstall(ownerId, installedAppId);
    const [address, usage, live] = await Promise.all([
        serverAddress(install, ownerId),
        readAppContainerMetricsOrNull(install.applicationId, ownerId, containerOf(install)),
        readLivePlayers(install, ownerId)
    ]);
    return {
        edition: install.edition,
        running: install.running,
        containerRunning: live.containerRunning ?? (usage ? usage.state === "running" : null),
        answering: live.answering,
        players: live.players,
        address,
        message: live.message,
        cpuPercent: usage?.cpuPercent ?? null,
        memUsedBytes: usage?.memUsedBytes ?? null,
        memTotalBytes: usage?.memTotalBytes ?? null,
        crashLoop: live.crashLoop
    };
}

/**
 * Only who is on, for the callers that only want that.
 *
 * The list of servers and the firewall pass both ask this of every server they
 * touch, and neither shows the container's CPU or its address - sampling a
 * container costs about a second each, which on a page listing servers is the
 * whole wait.
 */
export async function getServerPlayers(
    ownerId: string,
    installedAppId: string,
    /** The install, when the caller resolved it along with others (see
     *  `resolveInstalls`). */
    resolved?: MinecraftInstall
): Promise<MinecraftPlayers> {
    return readLivePlayers(resolved ?? (await resolveInstall(ownerId, installedAppId)), ownerId);
}

/**
 * Whether the server is meant to be up, and who is on when it answered - what a
 * question asked about it in Chat is answered from. Nothing about why it is not
 * answering: that names containers and logs, and the answer is read by
 * everybody in a conversation, not only by whoever runs the server.
 */
export async function serverReading(
    ownerId: string,
    installedAppId: string
): Promise<{ running: boolean; players: parse.PlayerList | null }> {
    const install = await resolveInstall(ownerId, installedAppId);
    if (!install.running) return { running: false, players: null };
    const live = await readLivePlayers(install, ownerId);
    return { running: true, players: live.answering ? live.players : null };
}

/**
 * Ask the running server who is on. A server that is stopped or still coming up is
 * a reading that says so, never a throw - the callers list servers.
 *
 * The container is looked at before it is spoken to, which costs one cheap call
 * and saves two things. A container that is down is not asked at all, so a page
 * listing stopped servers does not wait out a failing exec for each of them; and
 * what the reader is told is that it is not running, rather than the daemon's own
 * "Error response from daemon: container 1ef6df9... is not running", which names
 * a container nobody has ever seen and says nothing about what to do.
 */
async function readLivePlayers(
    install: MinecraftInstall,
    ownerId: string
): Promise<MinecraftPlayers> {
    const empty: parse.PlayerList = { online: 0, max: 0, players: [] };
    if (!install.running) {
        // A server Polaris stopped because it could not start is stopped for a
        // reason worth carrying: by now the container is not restarting any more,
        // so this record is the only thing left that knows why it is off.
        const halted = readCrashLoop(install.config ?? null);
        return {
            answering: false,
            players: empty,
            message: halted ? crashLoopMessage(halted) : gameMessage("games", "lib.stopped"),
            containerRunning: null,
            crashLoop: halted
        };
    }
    const runtime = await readAppContainerRuntime(
        install.applicationId,
        ownerId,
        containerOf(install)
    );
    const state = runtime?.status ?? null;
    // A container being restarted over and over is the one state that looks
    // exactly like a server that is merely slow to boot, and the one nobody can
    // wait out: it never comes up, and the reason is in a log the person watching
    // a blank panel has no reason to open. Read off the restart count rather than
    // off the status, because the status only says "restarting" during the
    // engine's backoff and a poll almost never lands there. The reading the sweep
    // took a minute ago comes with it: without something to compare against, a
    // server that has just recovered reads exactly like one still going round.
    if (runtime && isCrashLooping(runtime, readRestartWatch(install.config ?? null), new Date())) {
        const loop = crashLoopOf(
            runtime,
            await tail(install.applicationId, ownerId, CRASH_LOG_TAIL)
        );
        return {
            answering: false,
            players: empty,
            message: crashLoopMessage(loop),
            containerRunning: false,
            crashLoop: loop
        };
    }
    if (state !== null && state !== "running") {
        return {
            answering: false,
            players: empty,
            // Polaris is meant to be keeping it up and it is not: something took
            // it down from outside, or it fell over.
            message: await withReason(
                install.applicationId,
                ownerId,
                gameMessage("games", "lib.containerDown")
            ),
            containerRunning: false,
            crashLoop: null
        };
    }
    const containerRunning = state === null ? null : true;
    try {
        const players = await readPlayerList(install, ownerId);
        if (!players) {
            // Starting covers a real span of minutes on a new server - the image
            // is downloading its jar and its plugins - so what it is doing right
            // now is worth more than the word "starting".
            return {
                answering: false,
                players: empty,
                message: await withReason(
                    install.applicationId,
                    ownerId,
                    gameMessage("games", "lib.starting")
                ),
                containerRunning,
                crashLoop: null
            };
        }
        return { answering: true, players, message: null, containerRunning, crashLoop: null };
    } catch (caught) {
        return {
            answering: false,
            players: empty,
            message:
                caught instanceof Error ? caught.message : gameMessage("games", "lib.notAnswering"),
            containerRunning,
            crashLoop: null
        };
    }
}

/** Enough of the log to find the last thing worth repeating, and no more: this is
 *  read on a poll, on every server on the page. */
const LOG_TAIL = 60;

/** Enough to reach past a stack trace to the line under it. Paid only for a
 *  container already judged to be looping, never on the ordinary poll. */
const CRASH_LOG_TAIL = 600;

/** A line on a status card, not a log viewer. The console screen has the rest. */
const LOG_LINE_MAX = 200;

/** The log, or nothing. A cause that cannot be read is a loop reported without
 *  one, which is still the useful half. */
async function tail(applicationId: string, ownerId: string, lines: number): Promise<string> {
    return readAppRuntimeLog(applicationId, ownerId, lines).catch(() => "");
}

/** What the panel says about a server that will not start. The cause carries the
 *  sentence when there is one, because it is more specific than anything here. */
function crashLoopMessage(loop: CrashLoop): string {
    return loop.cause
        ? gameMessage("games", "lib.crashLoopCause", { count: loop.restarts, cause: loop.cause })
        : gameMessage("games", "lib.crashLoop", { count: loop.restarts });
}

/**
 * A message with what the container is actually doing appended to it.
 *
 * Two answers, and the first one is the one people want. The step it is on -
 * downloading, unpacking, building the world - is a sentence anybody can read, and
 * on a server built from a map it is the difference between a long download and a
 * server that is stuck. Failing that, the last line the container said, which is
 * where the plugin it could not install gets named.
 *
 * Best effort in every direction: a log that cannot be read leaves the message as
 * it was, because a sentence about the server's state is still better than an error
 * about fetching a log.
 */
async function withReason(
    applicationId: string,
    ownerId: string,
    message: string
): Promise<string> {
    try {
        const log = await readAppRuntimeLog(applicationId, ownerId, LOG_TAIL);
        const phase = parse.startupPhase(log);
        if (phase) return gameMessage("games", "lib.withPhase", { message, phase });
        const line = parse.lastStartupSignal(log);
        return line
            ? gameMessage("games", "lib.withLast", { message, line: line.slice(0, LOG_LINE_MAX) })
            : message;
    } catch {
        return message;
    }
}

/**
 * What the Polaris firewall blocks, against what this server has actually been
 * told to refuse. The firewall is an HTTP guard and a game server is not HTTP, so
 * the two are joined here rather than by the edge: the addresses it holds are
 * handed to the server's own ban list, which is the only thing a game client is
 * refused by.
 */
export async function getServerFirewall(
    ownerId: string,
    installedAppId: string
): Promise<MinecraftFirewall> {
    const install = await resolveInstall(ownerId, installedAppId);
    const [waf, banned] = await Promise.all([
        resolveWaf(install.applicationId),
        readServerFile(install, ownerId, "banned-ips.json")
    ]);
    const applied = new Set(parse.parseBannedIps(banned));
    const blocked = waf.deny.filter((entry) => !entry.includes("/"));
    return {
        blocked,
        applied: blocked.filter((entry) => applied.has(entry)),
        ranges: waf.deny.filter((entry) => entry.includes("/"))
    };
}

/**
 * Ban every address the firewall blocks that the server does not already refuse,
 * and report how many that was. Bedrock has no ban command at all, so there it
 * changes nothing and says so.
 */
export async function applyFirewallBans(ownerId: string, installedAppId: string): Promise<number> {
    const install = await resolveInstall(ownerId, installedAppId);
    if (install.edition === "bedrock")
        throw new Error(gameMessage("games", "lib.bedrockNoAddressBan"));
    const firewall = await getServerFirewall(ownerId, installedAppId);
    const pending = firewall.blocked.filter((entry) => !firewall.applied.includes(entry));
    let banned = 0;
    for (const address of pending) {
        // i18n-ignore: the ban reason is shown in the game, to the player
        await execCommand(install, ownerId, ["ban-ip", address, "Blocked by the Polaris firewall"]);
        banned += 1;
    }
    return banned;
}

/**
 * Who is online right now, including anybody still at Polaris login's prompt -
 * for operator tooling (inventory transfer, X-Ray review) that means every
 * connected player, not just the ones let in. Null for a server that is not
 * meant to be up or did not answer. A text shown in the game uses
 * {@link shownPlayers} instead, which leaves pending players out.
 */
export async function onlinePlayers(
    ownerId: string,
    installedAppId: string
): Promise<parse.PlayerList | null> {
    const install = await resolveInstall(ownerId, installedAppId);
    if (!install.running) return null;
    return readPlayerList(install, ownerId).catch(() => null);
}

/**
 * Who is online for the players' own eyes - the names and the count a text in
 * the game fills in - which leaves out anybody still at Polaris login's prompt:
 * they are not in yet. Java only; Bedrock has no Polaris login.
 */
export async function shownPlayers(
    ownerId: string,
    installedAppId: string
): Promise<parse.PlayerList | null> {
    const install = await resolveInstall(ownerId, installedAppId);
    if (!install.running) return null;
    return shownPlayerList(install, ownerId).catch(() => null);
}

async function shownPlayerList(
    install: MinecraftInstall,
    ownerId: string
): Promise<parse.PlayerList | null> {
    const list = await readPlayerList(install, ownerId);
    if (!list || install.edition !== "java" || list.players.length === 0) return list;
    const held = await execCommand(install, ownerId, [PENDING_READ]).catch(() => "");
    return withoutPending(list, pendingNames(held, list.players));
}

/**
 * Who is online. Java asks and is answered; Bedrock is asked and answers into its
 * own console, so there the command is sent and the log is read back a moment
 * later for the newest answer it printed.
 */
async function readPlayerList(
    install: MinecraftInstall,
    ownerId: string
): Promise<parse.PlayerList | null> {
    if (install.edition !== "bedrock")
        return parse.parsePlayerList(await execCommand(install, ownerId, ["list"]));
    await execCommand(install, ownerId, ["list"]);
    await new Promise((resolve) => setTimeout(resolve, CONSOLE_ANSWER_MS));
    return parse.parsePlayerListFromLog(
        await readAppRuntimeLog(install.applicationId, ownerId, 80)
    );
}

/** Who is on the server now and who the operators are, by name. Java only:
 *  Bedrock keeps its operators by xuid, so there it is nobody. `known` is a
 *  player list already read for this send. */
async function rosterOnline(
    install: MinecraftInstall,
    ownerId: string,
    known: parse.PlayerList | null = null
): Promise<Roster> {
    if (install.edition === "bedrock") return { players: [], operators: [] };
    const [ops, players] = await Promise.all([
        readServerFile(install, ownerId, "ops.json"),
        known ?? readPlayerList(install, ownerId)
    ]);
    return { players: players?.players ?? [], operators: parse.parseNameFile(ops) };
}

/** The same, by the install's id, for the loop that keeps an announcement up. */
export async function onlineRoster(ownerId: string, installedAppId: string): Promise<Roster> {
    return rosterOnline(await resolveInstall(ownerId, installedAppId), ownerId);
}

/** How far back to read for the arrivals and departures. Enough to cover an
 *  evening on a quiet server; a busy one prints past it, and the history is then
 *  as long as the log is - which is what it says on the screen. */
const SESSION_LOG_TAIL = 1500;

/** A name the game will take as an argument, and this module's own guard before
 *  one is put in a shell command. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** How many players one read will ask about. A full server is twenty; the cap is
 *  there so a server with an unusual slot count cannot turn one screen into a
 *  hundred commands. */
const MAX_LEVEL_READS = 40;

/**
 * What experience level each of these players is on.
 *
 * Asked of the server rather than read from disk, because the number wanted is the
 * one they are on right now - a level read out of a player file is whatever it was
 * when they last logged out.
 *
 * One shell inside the container rather than one exec per player: on a registered
 * machine each exec is its own SSH handshake, and a full server would be twenty of
 * them for one column. A player who is not standing on the server answers with a
 * refusal and is absent from the result, which is the honest answer for somebody
 * who left while the screen was open.
 *
 * Empty for Bedrock, which has no `data get` and no way to be asked this.
 */
export async function getPlayerLevels(
    ownerId: string,
    installedAppId: string,
    names: readonly string[]
): Promise<Record<string, number>> {
    const wanted = [...new Set(names)]
        .filter((name) => PLAYER_NAME.test(name))
        .slice(0, MAX_LEVEL_READS);
    if (wanted.length === 0) return {};
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (server.edition !== "java") return {};
        const script = wanted.map((name) => `rcon-cli data get entity ${name} XpLevel`).join("; ");
        const result = await server.run(["sh", "-c", script]);
        return Object.fromEntries(parse.parsePlayerLevels(result.output, wanted));
    });
}

/**
 * Give somebody experience, take it away, or say what they are on.
 *
 * Java only, like everything else that goes through a command with a subcommand:
 * Bedrock's console has `xp` but not the `add`/`set` split, and guessing at the
 * older spelling would be a command that silently does nothing.
 *
 * Hands back whatever the server said, which is the sentence a screen shows: the
 * game answers this one properly, including when it refuses because a player
 * cannot go below nothing.
 */
export async function setPlayerExperience(
    ownerId: string,
    installedAppId: string,
    change: ExperienceChange
): Promise<string> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (server.edition !== "java") {
            throw new Error(gameMessage("games", "lib.bedrockNoXp"));
        }
        return parse.stripFormatting(await server.say(experienceCommand(change))).trim();
    });
}

/**
 * The server's lines about players arriving and leaving, as container-log lines
 * (`<RFC3339> <line>`), oldest first.
 *
 * Picked out of the server's own log files inside the container (see
 * `player-log`), because the container's log is where every RCON command Polaris
 * sends leaves two lines, and its tail can hold nothing else. The container's log
 * is still read when that finds no files - Bedrock writes none - or the container
 * cannot be asked, which is also the only record of a server that is not running.
 */
export async function readPlayerLog(ownerId: string, installedAppId: string): Promise<string> {
    const install = await resolveInstall(ownerId, installedAppId);
    if (install.edition === "java" && install.running) {
        const picked = await inPlayerLogTurn(installedAppId, async () => {
            const state = playerLogs.get(installedAppId) ?? NO_PLAYER_LOG;
            const next = await withPorts(install, ownerId, (ports) =>
                ports.runIn(install.container, ["sh", "-c", playerLogScript(state.cursor)])
            )
                .then((result) => (result.code === 0 ? nextPlayerLog(state, result.output) : null))
                .catch(() => null);
            if (!next) return null;
            playerLogs.set(installedAppId, next);
            return next.lines.join("\n");
        });
        if (picked !== null) return picked;
    }
    return readAppRuntimeLog(install.applicationId, ownerId, SESSION_LOG_TAIL);
}

/** Where each server's log was last read to, and what it held (see `player-log`). */
const playerLogs = new Map<string, PlayerLogState>();
/** One read of a server's log at a time, so two readers never start from the same cursor. */
const inPlayerLogTurn = keyedTurns();

/** Every join and leave the server's log still holds, oldest first. */
export async function getPlayerSessions(
    ownerId: string,
    installedAppId: string
): Promise<readonly PlayerSessionEvent[]> {
    return parsePlayerSessions(await readPlayerLog(ownerId, installedAppId));
}

/**
 * The same, for a record keeper that looks at every kind of game server: null for
 * an install that is not a Minecraft server, whose log is not in this format and
 * is not worth reading for it.
 *
 * Read on the install's own owner, whoever is watching: the callers are the sweep
 * and the live feed, both of which only ever reach servers their reader may see,
 * and a server somebody was invited to keeps its record like any other.
 */
export async function getPlayerSessionsIfMinecraft(
    installedAppId: string
): Promise<readonly PlayerSessionEvent[] | null> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installedAppId, status: { not: "removed" } },
        select: { catalogId: true, ownerId: true }
    });
    if (!row || gameOfServer(row.catalogId)?.id !== "minecraft") return null;
    return getPlayerSessions(row.ownerId, installedAppId);
}

/** Operators, whitelisted players and bans, as the server has them on disk. */
export async function getServerRoster(
    ownerId: string,
    installedAppId: string
): Promise<MinecraftRoster> {
    const install = await resolveInstall(ownerId, installedAppId);
    // Bedrock keeps an allow list instead of a whitelist, has no ban list at all,
    // and records operators by xuid rather than by name - so it reports the one
    // roster it actually has, and the screen offers only what can be acted on.
    if (install.edition === "bedrock") {
        const [allowList, properties] = await Promise.all([
            readServerFile(install, ownerId, "allowlist.json"),
            readServerFile(install, ownerId, "server.properties")
        ]);
        return {
            ops: [],
            whitelist: parse.parseNameFile(allowList),
            bans: [],
            whitelistEnforced: parse.parseProperties(properties)["allow-list"] === "true"
        };
    }
    const [ops, whitelist, bans, properties] = await Promise.all([
        readServerFile(install, ownerId, "ops.json"),
        readServerFile(install, ownerId, "whitelist.json"),
        readServerFile(install, ownerId, "banned-players.json"),
        readServerFile(install, ownerId, "server.properties")
    ]);
    return {
        ops: parse.parseNameFile(ops),
        whitelist: parse.parseNameFile(whitelist),
        bans: parse.parseBansFile(bans),
        whitelistEnforced: parse.parseProperties(properties)["white-list"] === "true"
    };
}

/**
 * The address a player connects to: the target's own IP and the host port the
 * deploy published the game port on. Null when the IP cannot be determined -
 * better an absent address than one that does not resolve.
 */
async function serverAddress(install: MinecraftInstall, ownerId: string): Promise<string | null> {
    // A name on the operator's domain is the address when there is one, so the
    // machine's own is only looked up for a server that has no name.
    const ip = install.hostname
        ? null
        : install.target.kind === "local" || !install.target.hostId
          ? await getHostLanIp()
          : await hostIp(install.target.hostId, ownerId);
    return gameServerAddress({
        hostname: install.hostname,
        portless: install.portless,
        ip,
        // A game server publishes on the port its clients assume, pinned at
        // install. The derived port is the fallback for one installed before that
        // existed.
        port: install.hostPort ?? hostPortForApp(install.portSubject)
    });
}

/** A registered server's address, as it was enrolled. */
async function hostIp(hostId: string, ownerId: string): Promise<string | null> {
    const host = await prisma.host.findFirst({
        where: { id: hostId, ownerId },
        select: { address: true }
    });
    return host?.address ?? null;
}

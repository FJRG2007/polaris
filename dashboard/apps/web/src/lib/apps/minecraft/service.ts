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

import { prisma } from "@polaris/db";
import { withTimeout } from "@polaris/core";
import { gameServerAddress } from "./address";
import { resolveWaf } from "@/lib/waf-service";
import { getHostLanIp } from "@/lib/host-address";
import { readCrashLoop } from "@/lib/apps/games-health";
import { currentReleaseRef } from "@/lib/deploy/releases";
import type { ExecResult, RuntimePorts } from "@polaris/deploy";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { hostPortForApp, readAppRuntimeLog } from "@/lib/deploy-service";
import { parsePlayerSessions, type PlayerSessionEvent } from "./sessions";
import { crashLoopOf, isCrashLooping, type CrashLoop } from "@/lib/apps/crash-loop";
import { readAppContainerMetricsOrNull, readAppContainerRuntime } from "@/lib/app-container-metrics";
import {
    lastStartupSignal,
    parseBannedIps,
    parseBansFile,
    parseNameFile,
    parsePlayerList,
    parsePlayerListFromLog,
    parseProperties,
    type BanEntry,
    type PlayerList
} from "./parse";

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

/** Long enough for a ban reason, short enough that no single field can carry a
 *  script into the console. */
const MAX_COMMAND_LENGTH = 512;

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
    readonly players: PlayerList;
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
    readonly bans: readonly BanEntry[];
    /** Whether the whitelist is actually being enforced (`white-list` in
     *  server.properties). A list that is not enforced lets everyone in. */
    readonly whitelistEnforced: boolean;
}

/** The install, its application and the target it runs on. */
interface MinecraftInstall {
    readonly installedAppId: string;
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

/** Resolve an installed app to the container its server runs in, asserting the
 *  caller owns it. Throws a client-safe message when it has no deployment yet. */
async function resolveInstall(ownerId: string, installedAppId: string): Promise<MinecraftInstall> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } }
    });
    if (!install) throw new Error("Installed app not found");
    if (!install.applicationId) throw new Error("This server has not been deployed yet");
    const app = await prisma.application.findFirst({
        where: { id: install.applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) throw new Error("This server's deployment is gone");
    const release = await currentReleaseRef(app);
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
    if (value.length === 0 || value.length > MAX_COMMAND_LENGTH) throw new Error("That command is not valid");
    if (/[\0\r\n]/.test(value)) throw new Error("That command is not valid");
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
    if (argv.length === 0 || argv.length > 24) throw new Error("That command is not valid");
    for (const argument of argv) assertSafeArgument(argument);
    const install = await resolveInstall(ownerId, installedAppId);
    return execCommand(install, ownerId, argv);
}

/** A console line the operator typed. Split on whitespace, because that is what
 *  the in-game console does with it too. */
export async function runConsoleLine(ownerId: string, installedAppId: string, line: string): Promise<string> {
    const trimmed = line.trim().replace(/^\//, "");
    assertSafeArgument(trimmed);
    return runServerCommand(ownerId, installedAppId, trimmed.split(/\s+/));
}

/**
 * Run a command on the server and hand back whatever came back.
 *
 * Java answers over RCON, so the answer is the return value. Bedrock has no RCON:
 * the command is written to the server's console and the answer is only printed
 * to its log, so there is nothing to return - which is why anything that needs an
 * answer (the player list) reads the log on Bedrock instead of this.
 */
async function execCommand(install: MinecraftInstall, ownerId: string, argv: readonly string[]): Promise<string> {
    return withPorts(install, ownerId, (ports) => sendGameCommand(ports, install, argv));
}

/** The same, on ports that are already open. */
async function sendGameCommand(
    ports: RuntimePorts,
    install: MinecraftInstall,
    argv: readonly string[]
): Promise<string> {
    const command = install.edition === "bedrock" ? ["send-command", ...argv] : ["rcon-cli", ...argv];
    const result = await withTimeout(
        ports.runIn(install.container, command),
        COMMAND_TIMEOUT_MS,
        "The server did not answer in time"
    );
    if (result.code !== 0) {
        // rcon-cli fails the same way for a server that is still generating its
        // world and for one that has crashed; say what an operator can act on.
        throw new Error(
            result.output.trim().length > 0 && !/connection refused/i.test(result.output)
                ? result.output.trim().slice(0, 300)
                : "The server is not accepting commands yet"
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
     * Stream a file out of the container, as bytes.
     *
     * `run` collects its output into a string, which is right for a command's
     * answer and wrong for a world archive - so copying one off the server to
     * somewhere it survives the disk uses this instead. Works on a remote target
     * as well as the local host, which reading through the daemon directly does
     * not.
     */
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
}

export async function withServerContainer<T>(
    ownerId: string,
    installedAppId: string,
    work: (server: ServerContainer) => Promise<T>
): Promise<T> {
    const install = await resolveInstall(ownerId, installedAppId);
    return withPorts(install, ownerId, async (ports) => {
        const server: ServerContainer = {
            installedAppId: install.installedAppId,
            applicationId: install.applicationId,
            edition: install.edition,
            running: install.running,
            run: (argv) => ports.runIn(install.container, argv),
            runOk: async (argv, failure) => {
                const result = await ports.runIn(install.container, argv);
                if (result.code !== 0) throw new Error(containerFailure(result.output, failure));
                return result.output;
            },
            say: (argv) => sendGameCommand(ports, install, argv),
            readFile: (path) => ports.readFile(install.container, path)
        };
        return work(server);
    });
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
        return `${failure} - start the server first`;
    }
    return `${failure}: ${said.slice(0, 200)}`;
}

/** Read one of the server's own files out of the container. Empty when it does
 *  not exist yet - a server that has never had an op has no ops.json. */
async function readServerFile(install: MinecraftInstall, ownerId: string, name: string): Promise<string> {
    const result = await withPorts(install, ownerId, (ports) =>
        ports.runIn(install.container, ["cat", `${DATA_DIR}/${name}`])
    );
    return result.code === 0 ? result.output : "";
}

/** Who is on and whether the server is answering at all. */
export interface MinecraftPlayers {
    readonly answering: boolean;
    readonly players: PlayerList;
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
    /** Whether the container was up when it was asked. Null when that cannot be
     *  seen from here. */
    readonly containerRunning: boolean | null;
    /** Why it will not start, when it is failing to rather than taking its time. */
    readonly crashLoop: CrashLoop | null;
}

/** Who is on, where to reach the server, and whether it is answering at all. */
export async function getServerStatus(ownerId: string, installedAppId: string): Promise<MinecraftStatus> {
    const install = await resolveInstall(ownerId, installedAppId);
    const [address, usage, live] = await Promise.all([
        serverAddress(install, ownerId),
        readAppContainerMetricsOrNull(install.applicationId, ownerId),
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
export async function getServerPlayers(ownerId: string, installedAppId: string): Promise<MinecraftPlayers> {
    return readLivePlayers(await resolveInstall(ownerId, installedAppId), ownerId);
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
async function readLivePlayers(install: MinecraftInstall, ownerId: string): Promise<MinecraftPlayers> {
    const empty: PlayerList = { online: 0, max: 0, players: [] };
    if (!install.running) {
        // A server Polaris stopped because it could not start is stopped for a
        // reason worth carrying: by now the container is not restarting any more,
        // so this record is the only thing left that knows why it is off.
        const halted = readCrashLoop(install.config ?? null);
        return {
            answering: false,
            players: empty,
            message: halted ? crashLoopMessage(halted) : "The server is stopped",
            containerRunning: null,
            crashLoop: halted
        };
    }
    const runtime = await readAppContainerRuntime(install.applicationId, ownerId);
    const state = runtime?.status ?? null;
    // A container being restarted over and over is the one state that looks
    // exactly like a server that is merely slow to boot, and the one nobody can
    // wait out: it never comes up, and the reason is in a log the person watching
    // a blank panel has no reason to open. Read off the restart count rather than
    // off the status, because the status only says "restarting" during the
    // engine's backoff and a poll almost never lands there.
    if (runtime && isCrashLooping(runtime, new Date())) {
        const loop = crashLoopOf(runtime, await tail(install.applicationId, ownerId, CRASH_LOG_TAIL));
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
                "The container is not running. Redeploy it, or read the logs to see why it stopped."
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
                message: await withReason(install.applicationId, ownerId, "The server is starting."),
                containerRunning,
                crashLoop: null
            };
        }
        return { answering: true, players, message: null, containerRunning, crashLoop: null };
    } catch (caught) {
        return {
            answering: false,
            players: empty,
            message: caught instanceof Error ? caught.message : "The server is not answering",
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
    const opening = `The server kept failing to start, so it has been stopped after ${loop.restarts} restarts.`;
    return loop.cause ? `${opening} ${loop.cause}` : opening;
}

/**
 * A message with the last thing the container actually said appended to it.
 *
 * Best effort in every direction: a log that cannot be read leaves the message
 * as it was, because a sentence about the server's state is still better than an
 * error about fetching a log. What it adds is the difference between "the server
 * is starting" - which was also what a server stuck in a boot loop said, forever
 * - and the line naming the plugin it could not install.
 */
async function withReason(applicationId: string, ownerId: string, message: string): Promise<string> {
    try {
        const line = lastStartupSignal(await readAppRuntimeLog(applicationId, ownerId, LOG_TAIL));
        return line ? `${message} Last: ${line.slice(0, LOG_LINE_MAX)}` : message;
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
export async function getServerFirewall(ownerId: string, installedAppId: string): Promise<MinecraftFirewall> {
    const install = await resolveInstall(ownerId, installedAppId);
    const [waf, banned] = await Promise.all([
        resolveWaf(install.applicationId),
        readServerFile(install, ownerId, "banned-ips.json")
    ]);
    const applied = new Set(parseBannedIps(banned));
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
    if (install.edition === "bedrock") throw new Error("Bedrock servers cannot ban an address");
    const firewall = await getServerFirewall(ownerId, installedAppId);
    const pending = firewall.blocked.filter((entry) => !firewall.applied.includes(entry));
    let banned = 0;
    for (const address of pending) {
        await execCommand(install, ownerId, ["ban-ip", address, "Blocked by the Polaris firewall"]);
        banned += 1;
    }
    return banned;
}

/**
 * Who is online. Java asks and is answered; Bedrock is asked and answers into its
 * own console, so there the command is sent and the log is read back a moment
 * later for the newest answer it printed.
 */
async function readPlayerList(install: MinecraftInstall, ownerId: string): Promise<PlayerList | null> {
    if (install.edition !== "bedrock") return parsePlayerList(await execCommand(install, ownerId, ["list"]));
    await execCommand(install, ownerId, ["list"]);
    await new Promise((resolve) => setTimeout(resolve, CONSOLE_ANSWER_MS));
    return parsePlayerListFromLog(await readAppRuntimeLog(install.applicationId, ownerId, 80));
}

/** How far back to read for the arrivals and departures. Enough to cover an
 *  evening on a quiet server; a busy one prints past it, and the history is then
 *  as long as the log is - which is what it says on the screen. */
const SESSION_LOG_TAIL = 1500;

/** Every join and leave the server's log still holds, oldest first. */
export async function getPlayerSessions(
    ownerId: string,
    installedAppId: string
): Promise<readonly PlayerSessionEvent[]> {
    const install = await resolveInstall(ownerId, installedAppId);
    return parsePlayerSessions(await readAppRuntimeLog(install.applicationId, ownerId, SESSION_LOG_TAIL));
}

/** Operators, whitelisted players and bans, as the server has them on disk. */
export async function getServerRoster(ownerId: string, installedAppId: string): Promise<MinecraftRoster> {
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
            whitelist: parseNameFile(allowList),
            bans: [],
            whitelistEnforced: parseProperties(properties)["allow-list"] === "true"
        };
    }
    const [ops, whitelist, bans, properties] = await Promise.all([
        readServerFile(install, ownerId, "ops.json"),
        readServerFile(install, ownerId, "whitelist.json"),
        readServerFile(install, ownerId, "banned-players.json"),
        readServerFile(install, ownerId, "server.properties")
    ]);
    return {
        ops: parseNameFile(ops),
        whitelist: parseNameFile(whitelist),
        bans: parseBansFile(bans),
        whitelistEnforced: parseProperties(properties)["white-list"] === "true"
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
    const host = await prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { address: true } });
    return host?.address ?? null;
}

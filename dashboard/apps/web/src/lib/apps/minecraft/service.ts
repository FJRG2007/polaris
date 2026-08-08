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
import { getHostLanIp } from "@/lib/host-address";
import type { RuntimePorts } from "@polaris/deploy";
import { currentReleaseRef } from "@/lib/deploy/releases";
import { resolveWaf } from "@/lib/waf-service";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { readAppContainerMetricsOrNull } from "@/lib/app-container-metrics";
import { hostPortForApp, readAppRuntimeLog } from "@/lib/deploy-service";
import {
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

/** Long enough for a ban reason, short enough that no single field can carry a
 *  script into the console. */
const MAX_COMMAND_LENGTH = 512;

export interface MinecraftStatus {
    /** Which Minecraft this is; the screens offer what the edition supports. */
    readonly edition: MinecraftEdition;
    /** The container is up. */
    readonly running: boolean;
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
        portless
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
    const command = install.edition === "bedrock" ? ["send-command", ...argv] : ["rcon-cli", ...argv];
    const result = await withPorts(install, ownerId, (ports) => ports.runIn(install.container, command));
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

/** Read one of the server's own files out of the container. Empty when it does
 *  not exist yet - a server that has never had an op has no ops.json. */
async function readServerFile(install: MinecraftInstall, ownerId: string, name: string): Promise<string> {
    const result = await withPorts(install, ownerId, (ports) =>
        ports.runIn(install.container, ["cat", `${DATA_DIR}/${name}`])
    );
    return result.code === 0 ? result.output : "";
}

/** Who is on, where to reach the server, and whether it is answering at all. */
export async function getServerStatus(ownerId: string, installedAppId: string): Promise<MinecraftStatus> {
    const install = await resolveInstall(ownerId, installedAppId);
    const [address, usage] = await Promise.all([
        serverAddress(install, ownerId),
        readAppContainerMetricsOrNull(install.applicationId, ownerId)
    ]);
    const empty: PlayerList = { online: 0, max: 0, players: [] };
    const resources = {
        edition: install.edition,
        cpuPercent: usage?.cpuPercent ?? null,
        memUsedBytes: usage?.memUsedBytes ?? null,
        memTotalBytes: usage?.memTotalBytes ?? null
    };
    if (!install.running) {
        return {
            running: false,
            answering: false,
            players: empty,
            address,
            message: "The server is stopped",
            ...resources
        };
    }
    try {
        const players = await readPlayerList(install, ownerId);
        if (!players) {
            return {
                running: true,
                answering: false,
                players: empty,
                address,
                message: "The server is starting",
                ...resources
            };
        }
        return { running: true, answering: true, players, address, message: null, ...resources };
    } catch (caught) {
        return {
            running: true,
            answering: false,
            players: empty,
            address,
            message: caught instanceof Error ? caught.message : "The server is not answering",
            ...resources
        };
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
    // A name on the operator's domain is the address when there is one: it is what
    // players are given, and it keeps working when the machine's own changes.
    if (install.hostname) {
        const port = install.hostPort ?? hostPortForApp(install.portSubject);
        return install.portless ? install.hostname : `${install.hostname}:${port}`;
    }
    const ip =
        install.target.kind === "local" || !install.target.hostId
            ? await getHostLanIp()
            : await hostIp(install.target.hostId, ownerId);
    if (!ip) return null;
    // A game server publishes on the port its clients assume, pinned at install.
    // The derived port is the fallback for one installed before that existed.
    const port = install.hostPort ?? hostPortForApp(install.portSubject);
    // 25565 and 19132 are what a client tries when no port is typed, so an address
    // that is already on it is shorter and less to get wrong.
    return port === 25565 || port === 19132 ? ip : `${ip}:${port}`;
}

/** A registered server's address, as it was enrolled. */
async function hostIp(hostId: string, ownerId: string): Promise<string | null> {
    const host = await prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { address: true } });
    return host?.address ?? null;
}

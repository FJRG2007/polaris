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
import { hostPortForApp } from "@/lib/deploy-service";
import { currentReleaseRef } from "@/lib/deploy/releases";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { parseBansFile, parseNameFile, parsePlayerList, parseProperties, type BanEntry, type PlayerList } from "./parse";

/** Where the server's data lives inside the container (the image's own /data). */
const DATA_DIR = "/data";

/** Long enough for a ban reason, short enough that no single field can carry a
 *  script into the console. */
const MAX_COMMAND_LENGTH = 512;

export interface MinecraftStatus {
    /** The container is up. */
    readonly running: boolean;
    /** The server answered RCON - it is up AND past its startup. */
    readonly answering: boolean;
    readonly players: PlayerList;
    /** host:port a player types into their client, when it can be determined. */
    readonly address: string | null;
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
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
    return {
        installedAppId: install.id,
        applicationId: app.id,
        container: release.name,
        portSubject: release.portSubject,
        target: app.target,
        running: app.desiredState === "running"
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
    return execRcon(install, ownerId, argv);
}

/** A console line the operator typed. Split on whitespace, because that is what
 *  the in-game console does with it too. */
export async function runConsoleLine(ownerId: string, installedAppId: string, line: string): Promise<string> {
    const trimmed = line.trim().replace(/^\//, "");
    assertSafeArgument(trimmed);
    return runServerCommand(ownerId, installedAppId, trimmed.split(/\s+/));
}

async function execRcon(install: MinecraftInstall, ownerId: string, argv: readonly string[]): Promise<string> {
    const result = await withPorts(install, ownerId, (ports) =>
        ports.runIn(install.container, ["rcon-cli", ...argv])
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
    const address = await serverAddress(install, ownerId);
    const empty: PlayerList = { online: 0, max: 0, players: [] };
    if (!install.running) {
        return { running: false, answering: false, players: empty, address, message: "The server is stopped" };
    }
    try {
        const players = parsePlayerList(await execRcon(install, ownerId, ["list"]));
        if (!players) {
            return { running: true, answering: false, players: empty, address, message: "The server is starting" };
        }
        return { running: true, answering: true, players, address, message: null };
    } catch (caught) {
        return {
            running: true,
            answering: false,
            players: empty,
            address,
            message: caught instanceof Error ? caught.message : "The server is not answering"
        };
    }
}

/** Operators, whitelisted players and bans, as the server has them on disk. */
export async function getServerRoster(ownerId: string, installedAppId: string): Promise<MinecraftRoster> {
    const install = await resolveInstall(ownerId, installedAppId);
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
    const ip =
        install.target.kind === "local" || !install.target.hostId
            ? await getHostLanIp()
            : await hostIp(install.target.hostId, ownerId);
    return ip ? `${ip}:${hostPortForApp(install.portSubject)}` : null;
}

/** A registered server's address, as it was enrolled. */
async function hostIp(hostId: string, ownerId: string): Promise<string | null> {
    const host = await prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { address: true } });
    return host?.address ?? null;
}

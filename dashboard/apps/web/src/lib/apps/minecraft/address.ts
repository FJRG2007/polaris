/**
 * A game server's address, as something a player types rather than an IP and a
 * port they have to be told.
 *
 * A Minecraft client resolves `_minecraft._tcp.<host>` before connecting, so a
 * SRV record pointing at the published port lets the address be just the name -
 * which is what a domain is for and why the server does not need to be on 25565
 * to look like it is. Bedrock clients do not resolve SRV, so there the name
 * still carries its port; the name is worth having anyway, because it survives
 * the machine's address changing.
 *
 * Everything here is best effort. A server whose DNS could not be written is
 * still a server: it falls back to the address it always had.
 */

import { prisma } from "@polaris/db";
import { getPublicIp } from "@/lib/domain-service";
import { getDomainZones } from "@/lib/domain-zones";
import { normalizeZoneName } from "@polaris/deploy";
import { provisionHostnameDns } from "@/lib/domain-dns";
import { patchInstallConfig } from "@/lib/apps/install-config";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import { resolveZoneForHostname, upsertSrvRecord } from "@/lib/integrations/cloudflare-api";

/** The label game servers live under, so they never collide with a deployed
 *  service's name: `survival.mc.example.com`. One per game, because two games'
 *  servers would otherwise be competing for the same subdomain - and "survival"
 *  is a name somebody will pick twice. */
const GAME_LABEL = "mc";

export interface GameAddress {
    /** The hostname a player connects to, when there is one. */
    readonly hostname: string | null;
    /** Whether a client reaches it without also being told the port. */
    readonly portless: boolean;
}

/** The hostname a server would take on this Polaris, or null when no domain is
 *  configured. Deterministic from the name, so it survives a redeploy. */
export async function gameHostname(name: string, subdomain?: string, gameLabel: string = GAME_LABEL): Promise<string | null> {
    const { baseDomain } = await getDomainZones();
    if (!baseDomain) return null;
    const label = normalizeZoneName(subdomain?.trim() || name);
    return label ? `${label}.${gameLabel}.${baseDomain}` : null;
}

/** Whether a hostname is already taken by another of this owner's servers. */
export async function hostnameTaken(ownerId: string, hostname: string, exceptInstallId?: string): Promise<boolean> {
    const rows = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { id: true, config: true }
    });
    return rows.some((row) => {
        if (row.id === exceptInstallId) return false;
        try {
            return (JSON.parse(row.config) as { hostname?: unknown }).hostname === hostname;
        } catch {
            return false;
        }
    });
}

/**
 * Point a hostname at this machine and, for Java, at the port too.
 *
 * The A record is the same one a custom domain gets, conflicts and all - a name
 * already pointing somewhere else is left alone rather than taken over. The SRV
 * record is what removes the port from what a player has to type, and it is only
 * written once the A record it targets exists.
 */
export async function provisionGameDns(hostname: string, port: number, srv: boolean): Promise<GameAddress> {
    const result = await provisionHostnameDns(hostname);
    if (result.status === "conflict" || result.status === "manual") return { hostname: null, portless: false };
    // Only a Minecraft: Java client looks a SRV record up. Bedrock does not, and
    // neither does ARK - there the name is still worth having, it just carries its
    // port the way it always did.
    if (!srv) return { hostname, portless: false };
    try {
        const token = await loadCloudflareToken();
        if (!token) return { hostname, portless: false };
        const zone = await resolveZoneForHostname(token, hostname);
        await upsertSrvRecord(token, zone.id, `_minecraft._tcp.${hostname}`, hostname, port);
        return { hostname, portless: true };
    } catch {
        // The name resolves either way; only the port stays part of the address.
        return { hostname, portless: false };
    }
}

/** The address to show, from what the server has: its name when it has one, and
 *  the port when the name alone does not carry it. */
export function formatGameAddress(address: GameAddress | null, fallback: string | null, port: number): string | null {
    if (!address?.hostname) return fallback;
    return address.portless ? address.hostname : `${address.hostname}:${port}`;
}

/** The ports a client tries when the player types no port at all, Java then
 *  Bedrock. An address already on one of them is shorter and less to get wrong. */
const IMPLIED_PORTS = [25565, 19132];

/**
 * What a player types to connect, from what Polaris knows about the server: its
 * name on the operator's domain when it has one, otherwise the machine's own
 * address. Null when neither is known - better no address than one that does not
 * resolve.
 *
 * Pure, and the only place the rule lives: the list builds it for every server
 * from one batch of records, and a server's own page builds it from that
 * server's, and the two must not be able to disagree.
 */
export function gameServerAddress(server: {
    hostname: string | null;
    portless: boolean;
    /** The machine's address, for a server with no name of its own. */
    ip: string | null;
    port: number;
}): string | null {
    if (server.hostname) return server.portless ? server.hostname : `${server.hostname}:${server.port}`;
    if (!server.ip) return null;
    return IMPLIED_PORTS.includes(server.port) ? server.ip : `${server.ip}:${server.port}`;
}

/**
 * Give a server its name on the operator's domain, and record it.
 *
 * Shared by creating a server and by changing its address afterwards, because they
 * are the same act: work out the name, refuse one already spoken for, point it at
 * this machine and at the port, and write down what a player has to type. A server
 * with no domain configured, or no published port to point a record at, keeps the
 * address it already had rather than losing one.
 *
 * The config is merged rather than replaced - it also carries the server's access
 * settings, and a rename must not quietly reopen it.
 */
export async function setGameHostname(
    ownerId: string,
    installedAppId: string,
    input: {
        name: string;
        subdomain?: string;
        /** Whether the client finds the port for itself once the name resolves. */
        srv: boolean;
        /** The game's own label, so two games' servers cannot take the same name. */
        gameLabel?: string;
    }
): Promise<string | null> {
    const wanted = await gameHostname(input.name, input.subdomain, input.gameLabel);
    if (!wanted) return null;
    if (await hostnameTaken(ownerId, wanted, installedAppId)) {
        throw new Error(`${wanted} is already taken by another server - pick a different subdomain`);
    }
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true }
    });
    const port = install?.applicationId ? await publishedPort(install.applicationId) : null;
    if (!port) return null;
    const address = await provisionGameDns(wanted, port, input.srv);
    if (!address.hostname) return null;
    await patchInstallConfig(installedAppId, { hostname: address.hostname, portless: address.portless });
    return address.hostname;
}

/** The host port the install pinned for this application, which is what a SRV
 *  record has to name. */
async function publishedPort(applicationId: string): Promise<number | null> {
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { sourceConfig: true } });
    if (!app) return null;
    try {
        const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
        return typeof config.hostPort === "number" ? config.hostPort : null;
    } catch {
        return null;
    }
}

/** The suffix every game server's name ends in on this Polaris (".mc.example.com"),
 *  so a screen can show what a chosen label will become. Null with no domain. */
export async function gameDomainSuffix(gameLabel?: string): Promise<string | null> {
    const example = await gameHostname("server", undefined, gameLabel);
    return example ? example.slice("server".length) : null;
}

/** What Polaris could not detect: the public address a name has to point at. */
export async function publicAddressKnown(): Promise<boolean> {
    return Boolean(await getPublicIp());
}

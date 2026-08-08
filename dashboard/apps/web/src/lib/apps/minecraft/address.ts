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
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import { resolveZoneForHostname, upsertSrvRecord } from "@/lib/integrations/cloudflare-api";

/** The label game servers live under, so they never collide with a deployed
 *  service's name: `survival.mc.example.com`. */
const GAME_LABEL = "mc";

export interface GameAddress {
    /** The hostname a player connects to, when there is one. */
    readonly hostname: string | null;
    /** Whether a client reaches it without also being told the port. */
    readonly portless: boolean;
}

/** The hostname a server would take on this Polaris, or null when no domain is
 *  configured. Deterministic from the name, so it survives a redeploy. */
export async function gameHostname(name: string, subdomain?: string): Promise<string | null> {
    const { baseDomain } = await getDomainZones();
    if (!baseDomain) return null;
    const label = normalizeZoneName(subdomain?.trim() || name);
    return label ? `${label}.${GAME_LABEL}.${baseDomain}` : null;
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
export async function provisionGameDns(
    hostname: string,
    port: number,
    edition: "java" | "bedrock"
): Promise<GameAddress> {
    const result = await provisionHostnameDns(hostname);
    if (result.status === "conflict" || result.status === "manual") return { hostname: null, portless: false };
    if (edition === "bedrock") return { hostname, portless: false };
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

/** What Polaris could not detect: the public address a name has to point at. */
export async function publicAddressKnown(): Promise<boolean> {
    return Boolean(await getPublicIp());
}

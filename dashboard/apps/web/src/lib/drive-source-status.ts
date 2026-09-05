/**
 * Whether the sources in Drive's rail are answering.
 *
 * Every source Drive lists - a registered server over SFTP, a NAS over SMB, a
 * UNAS, a WebDAV endpoint - is a machine somewhere that can be off, and one that
 * is off answers a browse with a connect timeout and then a failure that names
 * nothing, after holding the request open for it. The rail asks this first, so a
 * device that is down is marked and never browsed.
 *
 * The probe is a TCP connect to the port that source is actually reached on,
 * which is the same question the browse asks. A port is only ever used when the
 * connection names it or the protocol defines it: guessing a vendor's console
 * port would report a live device as off, which is worse than not knowing.
 * Sources with no machine to reach (a bucket, a local path, a container on this
 * box) are not probed and simply do not appear in the answer.
 */

import { probeTcp } from "./server-status";
import type { SourceStatus } from "@/app/(app)/drive/types";
import { listAccessibleConnections } from "./storage-service";

/** Ports the protocol itself defines, used when a connection names none. */
const PROTOCOL_PORTS: Record<string, number> = {
    sftp: 22,
    smb: 445,
    nfs: 2049
};

/** Parse a stored config JSON string into a plain object (empty on any error). */
function parseConfig(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** Host and port from a WebDAV base URL, whose scheme carries the default port. */
function webdavEndpoint(baseUrl: unknown): { host: string; port: number } | null {
    if (typeof baseUrl !== "string") return null;
    try {
        const url = new URL(baseUrl);
        const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
        return { host: url.hostname, port };
    } catch {
        return null;
    }
}

/**
 * Where a source's config says it is reached, or null when there is nothing to
 * probe: no machine (a bucket, a local path), no address, or a port only a guess
 * could supply.
 */
export function sourceEndpoint(config: Record<string, unknown>): { host: string; port: number } | null {
    const kind = typeof config.kind === "string" ? config.kind : "";
    if (kind === "webdav") return webdavEndpoint(config.baseUrl);

    const host = typeof config.host === "string" ? config.host.trim() : "";
    if (!host) return null;
    const named = typeof config.port === "number" ? config.port : null;
    if (named !== null) return { host, port: named };
    // The UNAS is reached through its UniFi OS console, so that is what answers
    // for the device being on - including while SMB is still to be enabled on it.
    if (kind === "unifi-unas") return { host, port: config.secure === false ? 80 : 443 };
    const protocol = PROTOCOL_PORTS[kind];
    return protocol ? { host, port: protocol } : null;
}

/**
 * Reachability of every source the user can browse, keyed by the id the rail
 * uses. Probed in parallel: one unreachable device must not add its timeout to
 * the next one's wait. Sources that cannot be probed are left out rather than
 * reported up, so the browser treats them as unknown and browses as before.
 */
export async function driveSourceStatuses(userId: string): Promise<SourceStatus[]> {
    const connections = await listAccessibleConnections(userId);
    const probed = await Promise.all(
        connections.map(async (connection): Promise<SourceStatus | null> => {
            const endpoint = sourceEndpoint(parseConfig(connection.config));
            if (!endpoint) return null;
            const { detail } = await probeTcp(endpoint.host, endpoint.port);
            return {
                id: connection.id,
                state: detail === null ? "up" : "down",
                detail,
                // What was dialled, so a refusal names something the reader can
                // act on rather than only what went wrong.
                endpoint: `${endpoint.host}:${endpoint.port}`
            };
        })
    );
    return probed.filter((status): status is SourceStatus => status !== null);
}

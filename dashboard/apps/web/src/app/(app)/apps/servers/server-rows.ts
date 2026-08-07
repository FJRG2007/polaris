import "server-only";

/**
 * Every server as the Servers app describes one, resolved once for the list and
 * for a single server's page.
 *
 * The box Polaris runs on is a managed server too, and it is the awkward one: it
 * has no Host row until somebody enrolls it, so its row is assembled from settings
 * and detection instead. Enrolled, it is a Host like any other and must not also
 * appear as a second server further down the list. Working that out is the same
 * job for both screens, so it is done here rather than twice.
 *
 * Everything read here is the database or a setting, which is what keeps both
 * screens paintable before anything is asked of a machine: whether a server
 * answers, and what the local box calls itself, arrive from /api/servers/status
 * after the page is on screen.
 */

import type { ServerRow } from "./types";
import { listHosts } from "@/lib/host-service";
import { getPublicIp } from "@/lib/domain-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { environmentFromAddress, serverEnvironmentSchema } from "@polaris/core";
import { getLocalHostId, getLocalServerName, LOCAL_SERVER_FALLBACK_NAME, LOCAL_SERVER_ID } from "@/lib/local-server";

export async function listServerRows(userId: string): Promise<ServerRow[]> {
    const [hosts, local, localIp, localName, localHostId] = await Promise.all([
        listHosts(userId),
        getLocalEnvironment(),
        getPublicIp(),
        getLocalServerName(),
        getLocalHostId()
    ]);

    // The machine Polaris runs on, once somebody has enrolled it. Until then there
    // is no login to reach it by, and the row is built from detection alone.
    const localHost = localHostId ? (hosts.find((host) => host.id === localHostId) ?? null) : null;

    return [
        {
            id: LOCAL_SERVER_ID,
            kind: "local",
            name: localName || localHost?.name || LOCAL_SERVER_FALLBACK_NAME,
            detail: localHost?.username ?? "",
            os: localHost?.os ?? "",
            address: localHost?.address ?? localIp ?? "127.0.0.1",
            port: localHost?.port ?? null,
            authMethod: localHost?.authMethod ?? null,
            sudo: localHost?.sudo ?? false,
            hostId: localHost?.id ?? null,
            environment: local.environment,
            // The Polaris box's own zones are richer than one wildcard and are set up
            // under Domains, so this column is for registered servers only.
            wildcardDomain: "",
            suggested: local.detected,
            confirmed: local.confirmed
        },
        // Everything else, minus the one that turned out to be this machine.
        ...hosts
            .filter((host) => host.id !== localHostId)
            .map((host) => {
                // The column is free-form TEXT: an unrecognised value reads as unset
                // rather than taking the page down on a missing copy entry.
                const environment = serverEnvironmentSchema.catch("unknown").parse(host.environment);
                return {
                    id: host.id,
                    kind: "host" as const,
                    name: host.name,
                    detail: host.username,
                    os: host.os ?? "",
                    address: host.address,
                    port: host.port,
                    authMethod: host.authMethod,
                    sudo: host.sudo,
                    hostId: host.id,
                    environment,
                    wildcardDomain: host.wildcardDomain ?? "",
                    suggested: environmentFromAddress(host.address),
                    // The add-server form prefills this from the address, but shows
                    // the value and its routing note before submit - so a stored
                    // value was at least seen and accepted, unlike the local box's
                    // silent guess.
                    confirmed: environment !== "unknown"
                };
            })
    ];
}

/** One server by the id it is addressed as, or null when the caller has no such
 *  server. `local` is always somebody's, because it is the machine answering. */
export async function findServerRow(userId: string, serverId: string): Promise<ServerRow | null> {
    return (await listServerRows(userId)).find((server) => server.id === serverId) ?? null;
}

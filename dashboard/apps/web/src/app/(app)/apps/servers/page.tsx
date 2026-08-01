import { PageHeader } from "@polaris/ui";
import type { ServerRow } from "./types";
import { ServersView } from "./servers-view";
import { listHosts } from "@/lib/host-service";
import { requirePermission } from "@/lib/session";
import { getPublicIp } from "@/lib/domain-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { environmentFromAddress, serverEnvironmentSchema } from "@polaris/core";
import {
    getLocalHostId,
    getLocalServerName,
    LOCAL_SERVER_FALLBACK_NAME,
    LOCAL_SERVER_ID
} from "@/lib/local-server";

export const dynamic = "force-dynamic";

/**
 * Everything here is a database or settings read, so the table is on screen at
 * once. What the local machine calls itself needs the container engine, and
 * whether each server answers needs a socket per server; both arrive from
 * /api/servers/status after the page has painted.
 */
export default async function ServersPage() {
    const user = await requirePermission("system.manage");
    const [hosts, local, localIp, localName, localHostId] = await Promise.all([
        listHosts(user.id),
        getLocalEnvironment(),
        getPublicIp(),
        getLocalServerName(),
        getLocalHostId()
    ]);

    // The machine Polaris runs on, once somebody has enrolled it. Until then there
    // is no login to reach it by, and the row is built from detection alone.
    const localHost = localHostId ? (hosts.find((host) => host.id === localHostId) ?? null) : null;

    // The box Polaris runs on is a managed server too. Enrolled, it is a Host like
    // any other and can offer a shell and its files; unenrolled, it is listed from
    // detection because there are no credentials to store for the machine that is
    // serving this request.
    const servers: ServerRow[] = [
        {
            id: LOCAL_SERVER_ID,
            kind: "local",
            name: localName || localHost?.name || LOCAL_SERVER_FALLBACK_NAME,
            detail: localHost?.username ?? "",
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

    return (
        <>
            <PageHeader
                title="Servers"
                description="The box Polaris runs on and every SSH host it manages, reused across Containers (Docker) and Drive (SFTP)."
            />
            <ServersView servers={servers} />
        </>
    );
}

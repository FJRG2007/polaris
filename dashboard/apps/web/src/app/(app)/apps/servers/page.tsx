import { PageHeader } from "@polaris/ui";
import type { ServerRow } from "./types";
import { ServersView } from "./servers-view";
import { listHosts } from "@/lib/host-service";
import { requirePermission } from "@/lib/session";
import { getPublicIp } from "@/lib/domain-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { environmentFromAddress, serverEnvironmentSchema } from "@polaris/core";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME, LOCAL_SERVER_ID } from "@/lib/local-server";

export const dynamic = "force-dynamic";

/**
 * Everything here is a database or settings read, so the table is on screen at
 * once. What the local machine calls itself needs the container engine, and
 * whether each server answers needs a socket per server; both arrive from
 * /api/servers/status after the page has painted.
 */
export default async function ServersPage() {
    const user = await requirePermission("system.manage");
    const [hosts, local, localIp, localName] = await Promise.all([
        listHosts(user.id),
        getLocalEnvironment(),
        getPublicIp(),
        getLocalServerName()
    ]);

    // The box Polaris runs on is a managed server too - it just needs no SSH
    // credentials, so it is listed from detection instead of a Host row.
    const servers: ServerRow[] = [
        {
            id: LOCAL_SERVER_ID,
            kind: "local",
            name: localName || LOCAL_SERVER_FALLBACK_NAME,
            detail: "",
            address: localIp ?? "127.0.0.1",
            port: null,
            authMethod: null,
            environment: local.environment,
            // The Polaris box's own zones are richer than one wildcard and are set up
            // under Domains, so this column is for registered servers only.
            wildcardDomain: "",
            suggested: local.detected,
            confirmed: local.confirmed
        },
        ...hosts.map((host) => {
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
                environment,
                wildcardDomain: host.wildcardDomain ?? "",
                suggested: environmentFromAddress(host.address),
                // The add-server form prefills this from the address, but shows the
                // value and its routing note before submit - so a stored value was
                // at least seen and accepted, unlike the local box's silent guess.
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

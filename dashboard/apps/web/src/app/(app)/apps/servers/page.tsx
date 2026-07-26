import { hostname } from "node:os";
import { PageHeader } from "@polaris/ui";
import { environmentFromAddress, serverEnvironmentSchema } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { listHosts } from "@/lib/host-service";
import { getPublicIp } from "@/lib/domain-service";
import { localDockerDriver } from "@/lib/docker-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { ServersView, type ServerRow } from "./servers-view";

export const dynamic = "force-dynamic";

/** How long the Engine gets to answer before the page settles for os.hostname(). */
const NAME_TIMEOUT_MS = 2000;

/**
 * The machine name to show for the local box. Inside a container `os.hostname()`
 * is the container id, so the Engine's own host name is preferred - it is the name
 * the operator knows the box by. Best-effort and time-boxed: a wedged Docker daemon
 * answers neither success nor error, and this label is not worth a page that hangs.
 */
async function localMachineName(): Promise<string> {
    try {
        const driver = localDockerDriver();
        try {
            const info = await Promise.race([
                driver.info(),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), NAME_TIMEOUT_MS))
            ]);
            return info?.name || hostname();
        } finally {
            await driver.dispose();
        }
    } catch {
        return hostname();
    }
}

export default async function ServersPage() {
    const user = await requirePermission("system.manage");
    const [hosts, local, localIp, machineName] = await Promise.all([
        listHosts(user.id),
        getLocalEnvironment(),
        getPublicIp(),
        localMachineName()
    ]);

    // The box Polaris runs on is a managed server too - it just needs no SSH
    // credentials, so it is listed from detection instead of a Host row.
    const servers: ServerRow[] = [
        {
            id: "local",
            kind: "local",
            name: "This server",
            detail: machineName,
            address: localIp ?? "127.0.0.1",
            port: null,
            authMethod: null,
            environment: local.environment,
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
                suggested: environmentFromAddress(host.address),
                // A host's stored environment only ever comes from the operator.
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

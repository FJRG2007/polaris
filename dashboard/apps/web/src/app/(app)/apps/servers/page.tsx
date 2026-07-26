import { hostname } from "node:os";
import { PageHeader } from "@polaris/ui";
import { environmentFromAddress, type ServerEnvironment } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { listHosts } from "@/lib/host-service";
import { getPublicIp } from "@/lib/domain-service";
import { localDockerDriver } from "@/lib/docker-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { ServersView, type ServerRow } from "./servers-view";

export const dynamic = "force-dynamic";

/**
 * The machine name to show for the local box. Inside a container `os.hostname()`
 * is the container id, so the Engine's own host name is preferred - it is the name
 * the operator knows the box by. Best-effort: the label is not worth an error.
 */
async function localMachineName(): Promise<string> {
    try {
        const driver = localDockerDriver();
        try {
            return (await driver.info()).name || hostname();
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
        ...hosts.map((host) => ({
            id: host.id,
            kind: "host" as const,
            name: host.name,
            detail: host.username,
            address: host.address,
            port: host.port,
            authMethod: host.authMethod,
            environment: host.environment as ServerEnvironment,
            suggested: environmentFromAddress(host.address),
            // A host's stored environment only ever comes from the operator.
            confirmed: host.environment !== "unknown"
        }))
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

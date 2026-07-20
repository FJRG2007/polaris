import { getCapabilities, loadEnv } from "@polaris/config";
import type { DockerTransport } from "@polaris/docker";
import { PageHeader } from "@polaris/ui";
import { requireUser, userHasManage } from "@/lib/session";
import {
    getDockerDriver,
    hostDockerDriver,
    HOST_DOCKER_PREFIX,
    listDockerConnections,
    localDockerDriver,
    LOCAL_DOCKER_CONNECTION_ID
} from "@/lib/docker-service";
import { listHosts } from "@/lib/host-service";
import { ContainersView } from "./containers-view";
import type { ContainerRow, DockerConnectionSummary, OverviewData } from "./types";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function ContainersPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requireUser();
    const params = await searchParams;
    const sshEnabled = loadEnv().POLARIS_SSH_ENABLED;

    // The local host is host-wide, so it is only offered to operators who may
    // manage the system, and only in the full edition (hostd reports docker).
    const canManage = await userHasManage(user, "system.manage");
    const localAvailable = canManage && getCapabilities().docker;

    const stored: DockerConnectionSummary[] = (await listDockerConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        transport: row.transport as DockerTransport,
        status: row.status
    }));
    const localHost: DockerConnectionSummary[] = localAvailable
        ? [{ id: LOCAL_DOCKER_CONNECTION_ID, name: "Local host", transport: "socket", status: "active", local: true }]
        : [];
    // Global Hosts (managed in the Servers app) appear here as Docker-over-SSH
    // targets - a server registered once is usable in Containers too.
    const hostTargets: DockerConnectionSummary[] = (await listHosts(user.id)).map((host) => ({
        id: `${HOST_DOCKER_PREFIX}${host.id}`,
        name: host.name,
        transport: "ssh",
        status: host.status,
        host: true
    }));
    const connections = [...localHost, ...stored, ...hostTargets];

    const connectionId = pick(params.c) ?? connections[0]?.id ?? null;

    let overview: OverviewData | null = null;
    let containers: ContainerRow[] = [];
    let error: string | null = null;

    const isLocal = connectionId === LOCAL_DOCKER_CONNECTION_ID;
    const isHost = connectionId?.startsWith(HOST_DOCKER_PREFIX) ?? false;
    if (connectionId && isLocal && !canManage) {
        // A non-manager forced ?c=local via the URL: deny, never resolve the driver.
        error = "You do not have access to the local host.";
    } else if (connectionId) {
        try {
            const driver = isLocal
                ? localDockerDriver()
                : isHost
                  ? await hostDockerDriver(connectionId.slice(HOST_DOCKER_PREFIX.length), user.id)
                  : await getDockerDriver(connectionId, user.id);
            try {
                const info = await driver.info();
                const list = await driver.listContainers();
                const samples = await Promise.all(
                    list.map(async (container) =>
                        container.state === "running"
                            ? { id: container.id, stats: await driver.stats(container.id).catch(() => null) }
                            : { id: container.id, stats: null }
                    )
                );
                const byId = new Map(samples.map((sample) => [sample.id, sample.stats]));
                containers = list.map((container) => {
                    const stats = byId.get(container.id) ?? null;
                    return {
                        ...container,
                        cpuPercent: stats?.cpuPercent ?? null,
                        memUsage: stats?.memUsage ?? null,
                        memPercent: stats?.memPercent ?? null
                    };
                });
                overview = {
                    name: info.name,
                    serverVersion: info.serverVersion,
                    containers: info.containers,
                    running: info.containersRunning,
                    stopped: info.containersStopped,
                    images: info.images,
                    ncpu: info.ncpu,
                    memTotal: info.memTotal,
                    aggregateCpuPercent:
                        Math.round(containers.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0) * 100) / 100,
                    aggregateMemUsage: containers.reduce((sum, row) => sum + (row.memUsage ?? 0), 0)
                };
            } finally {
                await driver.dispose();
            }
        } catch (caught) {
            error = caught instanceof Error ? caught.message : "Unable to reach this Docker host";
        }
    }

    return (
        <>
            <PageHeader
                title="Containers"
                description="Monitor and manage Docker across your hosts - usage, state, and lifecycle."
            />
            <ContainersView
                connections={connections}
                connectionId={connectionId}
                sshEnabled={sshEnabled}
                overview={overview}
                containers={containers}
                error={error}
            />
        </>
    );
}

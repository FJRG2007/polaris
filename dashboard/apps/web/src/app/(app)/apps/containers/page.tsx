import { loadEnv } from "@polaris/config";
import type { DockerTransport } from "@polaris/docker";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { getDockerDriver, listDockerConnections } from "@/lib/docker-service";
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

    const connections: DockerConnectionSummary[] = (await listDockerConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        transport: row.transport as DockerTransport,
        status: row.status
    }));

    const connectionId = pick(params.c) ?? connections[0]?.id ?? null;

    let overview: OverviewData | null = null;
    let containers: ContainerRow[] = [];
    let error: string | null = null;

    if (connectionId) {
        try {
            const driver = await getDockerDriver(connectionId, user.id);
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

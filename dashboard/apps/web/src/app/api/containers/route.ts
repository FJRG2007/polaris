/**
 * The container listing for one Docker host, as JSON. This is what makes the
 * Containers page paint before it has any data: the shell, the host list and the
 * table chrome render immediately and this fills them in, instead of a
 * navigation that blocks until a possibly-remote engine has answered a listing
 * and a stats sample per container. It is also the refresh path, so live updates
 * and the first load run the same code.
 *
 * Node runtime because the Docker transports and Prisma need it.
 */

import { accessFor, withDockerDriver } from "@/lib/container-service";
import { authorizeConnection, listQuerySchema, parseQuery } from "./query";
import type { ContainerRow, OverviewData } from "@/app/(app)/apps/containers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, listQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        const payload = await withDockerDriver(parsed.data.c, caller.userId, async (driver) => {
            const info = await driver.info();
            const list = await driver.listContainers();
            // One stats sample per running container - a stopped one has nothing
            // to sample. Through the driver's batch rather than all at once: over
            // SSH each sample is its own channel and a server allows a bounded
            // number of them, so a host with a dozen running containers was
            // asking for more than it was allowed and losing the overflow.
            const byId = await driver.statsMany(
                list.filter((container) => container.state === "running").map((container) => container.id)
            );
            const containers: ContainerRow[] = list.map((container) => {
                const stats = byId.get(container.id) ?? null;
                return {
                    ...container,
                    cpuPercent: stats?.cpuPercent ?? null,
                    memUsage: stats?.memUsage ?? null,
                    memPercent: stats?.memPercent ?? null
                };
            });
            const overview: OverviewData = {
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
            // A console exists either way the engine is reached: over a hijacked
            // Docker connection, or through the daemon's own exec endpoint on the
            // local host, which the driver knows nothing about.
            return { overview, containers, canAttach: accessFor(parsed.data.c) === "hostd" || driver.canAttach };
        });
        return Response.json(payload);
    } catch (caught) {
        // The engine's own reason is what makes an unreachable host diagnosable
        // (a refused socket, a pinned host key that changed), so it is passed on
        // rather than replaced with a generic failure.
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Unable to reach this Docker host" },
            { status: 502 }
        );
    }
}

/**
 * The container listing for one Docker host, as JSON. This is what makes the
 * Containers page paint before it has any data: the shell, the host list and the
 * table chrome render immediately and this fills them in, instead of a
 * navigation that blocks until a possibly-remote engine has answered a listing
 * and a stats sample per container. It is also the refresh path, so live updates
 * and the first load run the same code.
 *
 * Two calls to the engine, both cheap: what the host is, and what it is running.
 * Usage is not one of them - the daemon holds a stats request open for about a
 * second per container, which is what used to make this answer in seconds. The
 * last sample taken is attached instead, along with when it was taken, and a
 * fresh pass is started behind the response once that has aged out.
 *
 * Node runtime because the Docker transports and Prisma need it.
 */

import { accessFor, withDockerDriver } from "@/lib/container-service";
import { authorizeConnection, listQuerySchema, parseQuery } from "./query";
import type { ContainerRow, OverviewData } from "@/app/(app)/apps/containers/types";
import {
    cachedSamples,
    oldestSampleAt,
    refreshSamples,
    STATS_TTL_MS
} from "@/lib/container-stats-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, listQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        const payload = await withDockerDriver(parsed.data.c, caller.userId, async (driver) => {
            const [info, list] = await Promise.all([driver.info(), driver.listContainers()]);
            // A stopped container has nothing to sample, so it is neither read nor
            // waited for; the sampler is only ever pointed at the running ones.
            const running = list.filter((container) => container.state === "running");
            const samples = cachedSamples(parsed.data.c);
            const containers: ContainerRow[] = list.map((container) => {
                const sample =
                    container.state === "running" ? samples.get(container.id) : undefined;
                return {
                    ...container,
                    cpuPercent: sample?.stats.cpuPercent ?? null,
                    memUsage: sample?.stats.memUsage ?? null,
                    memPercent: sample?.stats.memPercent ?? null,
                    statsAt: sample?.at ?? null
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
                    Math.round(
                        containers.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0) * 100
                    ) / 100,
                aggregateMemUsage: containers.reduce((sum, row) => sum + (row.memUsage ?? 0), 0)
            };
            // A console exists either way the engine is reached: over a hijacked
            // Docker connection, or through the daemon's own exec endpoint on the
            // local host, which the driver knows nothing about.
            return {
                snapshot: {
                    overview,
                    containers,
                    canAttach: accessFor(parsed.data.c) === "hostd" || driver.canAttach,
                    // The oldest of the running containers' samples, and null
                    // while any of them is still unsampled: the totals below add
                    // up only when every one of them has been read, and a screen
                    // that is told "sampled" shows them as a figure. A host with
                    // nothing running has nothing to sample, which is a complete
                    // picture as of now rather than a missing one.
                    statsAt:
                        running.length === 0
                            ? Date.now()
                            : oldestSampleAt(
                                  samples,
                                  running.map((container) => container.id)
                              )
                },
                running: running.map((container) => ({ id: container.id, name: container.name }))
            };
        });

        // Behind the response, never in front of it. A host whose samples are
        // all still warm is left alone, which is what keeps a page open in two
        // tabs from sampling the same engine twice as often. With nothing
        // running there is nothing to sample and the pass only drops what the
        // engine no longer lists.
        const { statsAt } = payload.snapshot;
        if (
            payload.running.length === 0 ||
            statsAt === null ||
            Date.now() - statsAt > STATS_TTL_MS
        ) {
            refreshSamples(parsed.data.c, caller.userId, payload.running, { prune: true });
        }

        return Response.json(payload.snapshot);
    } catch (caught) {
        // The engine's own reason is what makes an unreachable host diagnosable
        // (a refused socket, a pinned host key that changed), so it is passed on
        // rather than replaced with a generic failure.
        return Response.json(
            {
                error: caught instanceof Error ? caught.message : "Unable to reach this Docker host"
            },
            { status: 502 }
        );
    }
}

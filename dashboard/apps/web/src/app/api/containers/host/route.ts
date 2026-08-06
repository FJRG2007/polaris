/**
 * What a Docker host is, without asking it about its containers: the engine's
 * name and version, how much machine it has, and whether it can open an
 * interactive session at all.
 *
 * The container listing answers this too, but it pays a stats sample per running
 * container to do it. A page about ONE container wants the host it runs on named
 * and nothing else, so it asks here instead - one call to /info.
 */

import { accessFor, withDockerDriver } from "@/lib/container-service";
import type { OverviewData } from "@/app/(app)/apps/containers/types";
import { authorizeConnection, listQuerySchema, parseQuery } from "../query";

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
            const overview: OverviewData = {
                name: info.name,
                serverVersion: info.serverVersion,
                containers: info.containers,
                running: info.containersRunning,
                stopped: info.containersStopped,
                images: info.images,
                ncpu: info.ncpu,
                memTotal: info.memTotal,
                // No sample was taken, so there is nothing to aggregate. The
                // shape is shared with the listing; these two are its only
                // fields that mean "of the containers", and this call is not
                // about them.
                aggregateCpuPercent: 0,
                aggregateMemUsage: 0
            };
            return { overview, canAttach: accessFor(parsed.data.c) === "hostd" || driver.canAttach };
        });
        return Response.json(payload);
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Unable to reach this Docker host" },
            { status: 502 }
        );
    }
}

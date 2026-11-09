/**
 * What Polar Code's administrator settings show: where sessions run, how full
 * each machine is, and how spares are kept. Read for an administrator only.
 */

import { prisma } from "@polaris/db";
import { ALIVE_STATES, totalCeiling } from "@/lib/agents/session-capacity";
import { readPool } from "@/lib/agents/session-placement";
import { readWarm, type WarmSettings } from "@/lib/agents/session-spares";

export interface PoolServerRow {
    readonly hostId: string;
    readonly name: string;
    readonly address: string;
    readonly sessions: number;
    readonly live: number;
    /** Enrolled, switched on, answering and with a container engine. A server
     *  that is not is skipped by placement until it is again. */
    readonly usable: boolean;
}

export interface PolarCodeAdmin {
    readonly box: boolean;
    readonly boxSessions: number;
    readonly boxLive: number;
    readonly servers: PoolServerRow[];
    readonly warm: WarmSettings;
}

export async function polarCodeAdmin(): Promise<PolarCodeAdmin> {
    const [pool, boxSessions, warm] = await Promise.all([readPool(), totalCeiling(), readWarm()]);
    const ids = pool.servers.map((server) => server.hostId);
    const [hosts, counts] = await Promise.all([
        ids.length
            ? prisma.host.findMany({
                  where: { id: { in: ids } },
                  select: {
                      id: true,
                      name: true,
                      address: true,
                      status: true,
                      offlineSince: true,
                      dockerId: true
                  }
              })
            : Promise.resolve([]),
        prisma.agentSession.groupBy({
            by: ["hostId"],
            where: { place: "local", state: { in: [...ALIVE_STATES] } },
            _count: { _all: true }
        })
    ]);
    const live = new Map(counts.map((row) => [row.hostId, row._count._all]));
    const byId = new Map(hosts.map((host) => [host.id, host]));
    return {
        box: pool.box,
        boxSessions,
        boxLive: live.get(null) ?? 0,
        warm,
        // A server removed from Polaris drops out here, as it does from placement.
        servers: pool.servers.flatMap((server) => {
            const host = byId.get(server.hostId);
            if (!host) return [];
            return [
                {
                    hostId: host.id,
                    name: host.name,
                    address: host.address,
                    sessions: server.sessions,
                    live: live.get(host.id) ?? 0,
                    usable:
                        host.status === "active" && host.offlineSince === null && host.dockerId !== null
                }
            ];
        })
    };
}

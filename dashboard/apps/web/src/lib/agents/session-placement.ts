/**
 * Which machine a container session runs on.
 *
 * One box was the ceiling: every container session started on the machine
 * Polaris runs on, so the most sessions a deployment could hold was whatever
 * that one machine took. Administrators now give Polar Code a pool - this box,
 * and any enrolled server with container access - with a number of sessions
 * each may hold, and every new session is placed on one of them.
 *
 * How, after E2B's orchestrator (`placement_best_of_K.go`): filter the servers
 * that can take one at all, sample K of them, score each by how full it is
 * counting the starts still in flight, and take the lowest. Sampling rather
 * than scanning keeps the choice constant-time however large the pool grows,
 * and two dashboards placing at once rarely pick the same server. Like E2B's
 * resume, a session prefers the server its account's home is already on, while
 * that one still has room: the home is where the installed tools and the
 * machine's own sign-in live, and a session elsewhere starts on an empty one.
 *
 * What never leaves the box: a session on the machine everybody shares (its
 * home is on the box), and one that runs on the machine's own login (that login
 * is in the box's home and nowhere else).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";

/** Where the pool is stored. */
export const POOL_KEY = "polar.code.pool";

/** One enrolled server in the pool, and how many sessions it may hold. */
const poolServerSchema = z.object({
    hostId: z.string().uuid(),
    sessions: z.number().int().min(1).max(10_000)
});

export const poolSchema = z.object({
    /** Whether this box takes sessions too. On unless an administrator moved
     *  every session off it. */
    box: z.boolean(),
    servers: z.array(poolServerSchema).max(1000)
})
    // Somewhere has to take sessions.
    .refine((pool) => pool.box || pool.servers.length > 0, { path: ["box"] });

export type SessionPool = z.infer<typeof poolSchema>;

/** The pool before an administrator changes it: this box alone, as before. */
export const DEFAULT_POOL: SessionPool = { box: true, servers: [] };

/** The pool as stored, or the default when nothing readable is. A pool nobody
 *  can read must not quietly become "nowhere" and refuse every session. */
export async function readPool(): Promise<SessionPool> {
    const stored = await getSetting(POOL_KEY).catch(() => null);
    if (!stored) return DEFAULT_POOL;
    try {
        const parsed = poolSchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : DEFAULT_POOL;
    } catch {
        return DEFAULT_POOL;
    }
}

export async function writePool(pool: SessionPool): Promise<void> {
    const parsed = poolSchema.parse(pool);
    // One server once: a second row for it would count its sessions twice.
    const seen = new Set<string>();
    const servers = parsed.servers.filter((server) => {
        if (seen.has(server.hostId)) return false;
        seen.add(server.hostId);
        return true;
    });
    await setSetting(POOL_KEY, JSON.stringify({ box: parsed.box, servers }));
}

/** A machine that may take a session, with what it holds right now. `hostId`
 *  null is this box. */
export interface Candidate {
    readonly hostId: string | null;
    readonly ceiling: number;
    readonly live: number;
}

/** How many servers are sampled. Three is E2B's K: enough that the lowest of
 *  them is nearly always a good choice, few enough that two placements at the
 *  same moment rarely collide on one server. */
export const SAMPLE = 3;

/**
 * The machine to place on, or undefined when every one is full.
 *
 * Pure, with the randomness passed in, so it can be asserted. `preferred` is
 * where the account's home already is; it wins while it has room.
 */
export function choosePlacement(
    candidates: readonly Candidate[],
    preferred: string | null | undefined,
    random: () => number = Math.random
): string | null | undefined {
    const open = candidates.filter((candidate) => candidate.live < candidate.ceiling);
    if (open.length === 0) return undefined;
    if (preferred !== undefined) {
        const home = open.find((candidate) => candidate.hostId === preferred);
        if (home) return home.hostId;
    }
    const sampled = sample(open, SAMPLE, random);
    let best = sampled[0]!;
    for (const candidate of sampled) {
        if (load(candidate) < load(best)) best = candidate;
    }
    return best.hostId;
}

function load(candidate: Candidate): number {
    return candidate.live / candidate.ceiling;
}

/** K distinct entries, or all of them when there are no more than K. */
function sample<T>(items: readonly T[], k: number, random: () => number): T[] {
    if (items.length <= k) return [...items];
    const pool = [...items];
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, k);
}

/** The states that hold a container. Same list as `session-capacity`'s, kept
 *  here as a literal so this file does not import that one's settings. */
const ALIVE = ["starting", "working", "waiting", "idle"];

/**
 * The machines that may take a session now, with what each holds.
 *
 * A server counts only while it is enrolled, active, reachable when last
 * looked at, and has a container engine Polaris reached. One that went away is
 * skipped rather than failed on, which is the whole of "a node going away":
 * the next session goes elsewhere.
 */
export async function poolCandidates(
    pool: SessionPool,
    boxCeiling: number
): Promise<Candidate[]> {
    const ids = pool.servers.map((server) => server.hostId);
    const [hosts, counts] = await Promise.all([
        ids.length
            ? prisma.host.findMany({
                  where: {
                      id: { in: ids },
                      status: "active",
                      offlineSince: null,
                      dockerId: { not: null }
                  },
                  select: { id: true }
              })
            : Promise.resolve([]),
        prisma.agentSession.groupBy({
            by: ["hostId"],
            where: { place: "local", state: { in: ALIVE } },
            _count: { _all: true }
        })
    ]);
    const live = new Map(counts.map((row) => [row.hostId, row._count._all]));
    const usable = new Set(hosts.map((host) => host.id));
    const candidates: Candidate[] = [];
    if (pool.box) candidates.push({ hostId: null, ceiling: boxCeiling, live: live.get(null) ?? 0 });
    for (const server of pool.servers) {
        if (!usable.has(server.hostId)) continue;
        candidates.push({
            hostId: server.hostId,
            ceiling: server.sessions,
            live: live.get(server.hostId) ?? 0
        });
    }
    return candidates;
}

/** How many sessions the whole pool may hold: the deployment-wide ceiling
 *  `session-capacity` enforces. The box's own number when it is alone. */
export async function poolCeiling(boxCeiling: number): Promise<number> {
    const pool = await readPool();
    if (pool.servers.length === 0) return boxCeiling;
    const candidates = await poolCandidates(pool, boxCeiling);
    return candidates.reduce((sum, candidate) => sum + candidate.ceiling, 0);
}

/** Where the account's home already is: the machine its newest container
 *  session ran on. Undefined when it has never had one. */
async function homeOf(
    userId: string | null,
    exceptId: string
): Promise<string | null | undefined> {
    if (!userId) return undefined;
    const last = await prisma.agentSession.findFirst({
        where: { startedById: userId, place: "local", sharedHome: false, id: { not: exceptId } },
        orderBy: { createdAt: "desc" },
        select: { hostId: true }
    });
    return last ? last.hostId : undefined;
}

export class PoolFull extends Error {}

/**
 * Place one session, and write where on its row.
 *
 * Returns the server, or null for this box. Throws `PoolFull` when no machine
 * has room - which the queue in front of this normally prevents, since its
 * ceiling is the pool's sum, so it is the race of two starts at once on the
 * last seat.
 */
export async function placeSession(
    session: {
        readonly id: string;
        readonly place: string;
        readonly sharedHome: boolean;
        readonly useMachineLogin: boolean;
        readonly ownerId: string | null;
        readonly hostId: string | null;
    },
    boxCeiling: number,
    /** Servers that just refused this session: it goes elsewhere, as E2B
     *  retries a refused start on another node. */
    exclude: readonly string[] = []
): Promise<string | null> {
    if (session.place !== "local") return session.hostId;
    if (session.sharedHome || session.useMachineLogin) return null;
    const pool = await readPool();
    if (pool.servers.length === 0) return null;
    // Placed once: a session that already names a server stays on it, where
    // its checkout is.
    if (session.hostId) return session.hostId;
    const [candidates, home] = await Promise.all([
        poolCandidates(pool, boxCeiling),
        homeOf(session.ownerId, session.id)
    ]);
    const open = candidates.filter(
        (candidate) => !candidate.hostId || !exclude.includes(candidate.hostId)
    );
    const chosen = choosePlacement(open, home);
    if (chosen === undefined) throw new PoolFull("Every server Polar Code may use is full.");
    if (chosen !== session.hostId || exclude.length > 0) {
        await prisma.agentSession.update({ where: { id: session.id }, data: { hostId: chosen } });
    }
    return chosen;
}

/**
 * Spare containers: a session's machine started while its first message is
 * still being typed.
 *
 * A session used to start from nothing when it was sent: a container, then
 * tmux installed into it (a package install, measured at 2.7 s on a home
 * server), then the repository and the agent. The first two depend on nothing
 * about the session, so they can happen before it exists. When somebody opens
 * Code, Polaris starts one container for them on the machine their session
 * would go to (`session-placement`), running `SPARE_BOOT`: it does the slow,
 * session-free part and then waits. Sending the message takes that container:
 * the session is created under the spare's id, so it already has the name the
 * runtime finds it by, and its environment is written to `CLAIM_FILE`.
 *
 * Shaped after Coder's prebuilt workspaces (an administrator's count, an
 * expiry, a loop that keeps them true) and OpenHands' deferred init (a spare
 * knows nothing until one call hands it the session), with one difference the
 * container engine forces: a running container cannot be given a mount, and
 * every session mounts its account's home, so a spare is started for one
 * person rather than for anybody. That is also what keeps the cost honest - a
 * spare exists only while somebody is in Code, never as an idle fleet.
 *
 * What a spare costs, measured on a home server: the container is 2.8 MB of
 * memory and no CPU while it waits (tmux is installed and asleep); the image is
 * the one sessions already use. Bounded per server by the administrator, and
 * gone after its expiry unless the person is still in Code.
 *
 * Kept in `AgentSpare`, one row per account, so a reservation is read by key
 * and taken by a conditional delete: two tabs sending at once cannot both take
 * one. Counted per server and swept by expiry through its indexes, so neither
 * reads every spare there is.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { shellQuote } from "./session-hooks";
import * as commands from "./session-commands";
import { totalCeiling } from "./session-capacity";
import { startContainer } from "./session-container";
import { getSetting, setSetting } from "@/lib/setting-store";
import { containerState, withContainerPorts } from "./session-ports";
import { choosePlacement, poolCandidates, readPool } from "./session-placement";

/** The administrator's settings. */
export const WARM_KEY = "polar.code.warm";

export const warmSchema = z.object({
    enabled: z.boolean(),
    /** How long a spare waits for its message before it is taken down. Kept
     *  alive for as long as the person stays in Code. */
    minutes: z.number().int().min(1).max(120),
    /** The most spares one server holds at once. */
    perServer: z.number().int().min(0).max(1000)
});

export type WarmSettings = z.infer<typeof warmSchema>;

/** On, ten minutes, four a server: a spare is nearly free while it waits, and
 *  four people opening Code on one server at once is a busy one. */
export const DEFAULT_WARM: WarmSettings = { enabled: true, minutes: 10, perServer: 4 };

export async function readWarm(): Promise<WarmSettings> {
    const stored = await getSetting(WARM_KEY).catch(() => null);
    if (!stored) return DEFAULT_WARM;
    try {
        const parsed = warmSchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : DEFAULT_WARM;
    } catch {
        return DEFAULT_WARM;
    }
}

export async function writeWarm(settings: WarmSettings): Promise<void> {
    await setSetting(WARM_KEY, JSON.stringify(warmSchema.parse(settings)));
}

/** Where spares were kept before they had a table; removed by the sweep. */
const LEGACY_PREFIX = "polar.code.spare.u.";

/** How many expired spares one sweep takes down. The next sweep takes the rest. */
const SWEEP_BATCH = 200;

interface Spare {
    readonly sessionId: string;
    readonly hostId: string | null;
    readonly expiresAt: Date;
}

const SPARE_FIELDS = { sessionId: true, hostId: true, expiresAt: true } as const;

/** Which of these container ids are spares still waiting for a session, for
 *  the sweep of leftover containers, which would otherwise take a spare for a
 *  container nobody owns. */
export async function reservedSpareIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await prisma.agentSpare.findMany({
        where: { sessionId: { in: [...ids] } },
        select: { sessionId: true }
    });
    return new Set(rows.map((row) => row.sessionId));
}

/** Spares still waiting, per server. One grouped read over the index. */
async function waitingPerServer(now: number): Promise<Map<string | null, number>> {
    const groups = await prisma.agentSpare.groupBy({
        by: ["hostId"],
        where: { expiresAt: { gt: new Date(now) } },
        _count: { _all: true }
    });
    return new Map(groups.map((group) => [group.hostId, group._count._all]));
}

/**
 * Have a spare ready for this person, or keep the one they have.
 *
 * Called when they open Code and again while they stay there, which is what
 * keeps it alive; when they leave, it expires. Answers whether one is ready or
 * on its way. Never throws: a spare that could not be started is a session that
 * starts the ordinary way.
 */
export async function keepSpare(userId: string, now = Date.now()): Promise<boolean> {
    try {
        const warm = await readWarm();
        if (!warm.enabled || warm.perServer === 0) return false;
        const expiresAt = new Date(now + warm.minutes * 60_000);
        const held = await prisma.agentSpare.findUnique({ where: { userId }, select: SPARE_FIELDS });
        if (held && held.expiresAt.getTime() > now) {
            // Pushed back only once half of it has run: Code asks every minute
            // while it is open, and a write per open tab per minute is a write
            // nobody needed.
            if (held.expiresAt.getTime() - now < (warm.minutes * 60_000) / 2) {
                await prisma.agentSpare.updateMany({
                    where: { userId, sessionId: held.sessionId },
                    data: { expiresAt }
                });
            }
            return true;
        }

        const [pool, box, perServer, home] = await Promise.all([
            readPool(),
            totalCeiling(),
            waitingPerServer(now),
            homeOf(userId)
        ]);
        // Where a session would go, among the machines with room for a spare.
        const candidates = (await poolCandidates(pool, box)).filter(
            (candidate) => (perServer.get(candidate.hostId) ?? 0) < warm.perServer
        );
        const hostId = choosePlacement(candidates, home);
        if (hostId === undefined) return false;

        const spare: Spare = { sessionId: randomUUID(), hostId, expiresAt };
        // Only if nothing took the row since it was read: two tabs opening Code
        // at once start one spare, not two.
        const { count } = held
            ? await prisma.agentSpare.updateMany({
                  where: { userId, sessionId: held.sessionId },
                  data: { ...spare, createdAt: new Date(now) }
              })
            : await prisma.agentSpare.createMany({
                  data: [{ userId, ...spare }],
                  skipDuplicates: true
              });
        if (count !== 1) return true;
        // The one it replaced had expired; its container goes now rather than
        // at the next sweep - unless a session was made of it meanwhile.
        if (held) await removeUnclaimed(held);
        await startContainer(
            { id: spare.sessionId, hostId, ownerId: userId, sharedHome: false },
            {},
            commands.SPARE_BOOT
        );
        return true;
    } catch (error) {
        console.error(`[agent-spare] could not prepare a spare for ${userId}:`, error);
        return false;
    }
}

/** Where the account's home already is. Same rule as placement's. */
async function homeOf(userId: string): Promise<string | null | undefined> {
    const last = await prisma.agentSession.findFirst({
        where: { startedById: userId, place: "local", sharedHome: false },
        orderBy: { createdAt: "desc" },
        select: { hostId: true }
    });
    return last ? last.hostId : undefined;
}

/**
 * Take this person's spare for a session about to be created: its id and its
 * server, or null when there is none to take.
 *
 * Only for a session the spare can be: a container on its account's own home.
 * One on the machine everybody shares, or on the box's own login, mounts
 * something else, and is started the ordinary way.
 */
export async function takeSpare(
    userId: string,
    session: { place: string; sharedHome: boolean; useMachineLogin: boolean },
    now = Date.now()
): Promise<{ id: string; hostId: string | null } | null> {
    if (session.place !== "local" || session.sharedHome) return null;
    try {
        const spare = await prisma.agentSpare.findUnique({ where: { userId }, select: SPARE_FIELDS });
        if (!spare || spare.expiresAt.getTime() <= now) return null;
        if (session.useMachineLogin && spare.hostId !== null) return null;
        const { count } = await prisma.agentSpare.deleteMany({
            where: { userId, sessionId: spare.sessionId }
        });
        return count === 1 ? { id: spare.sessionId, hostId: spare.hostId } : null;
    } catch {
        return null;
    }
}

/**
 * Hand a waiting spare its session. True when it took it; false when there is
 * no waiting spare under that name, and the session is started the ordinary
 * way - which, on the same name, replaces whatever container was there.
 *
 * Written next to its final name and then moved, so the spare never reads half
 * of it.
 */
export async function claimSpare(
    target: { id: string; hostId: string | null },
    env: Record<string, string>
): Promise<boolean> {
    const name = commands.sessionContainerName(target.id);
    const body = Object.entries(env)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join("\n");
    const bytes = Buffer.from(`${body}\n`, "utf8");
    try {
        return await withContainerPorts(target.hostId, async (ports) => {
            if ((await containerState(ports, name)) !== "running" || !ports.writeFile) return false;
            const part = `${commands.CLAIM_FILE}.part`;
            await ports.writeFile(name, part, Readable.from([bytes]), bytes.length);
            const moved = await ports.runIn(name, [
                "sh",
                "-c",
                `chmod 0600 ${part} && mv ${part} ${commands.CLAIM_FILE}`
            ]);
            return moved.code === 0;
        });
    } catch (error) {
        console.error(`[agent-spare] ${target.id}: the spare could not be claimed:`, error);
        return false;
    }
}

/** Take a spare's container down, unless a session was created under its id
 *  in the meantime - then the container is that session's. */
async function removeUnclaimed(spare: Spare): Promise<void> {
    const session = await prisma.agentSession.findUnique({
        where: { id: spare.sessionId },
        select: { id: true }
    });
    if (session) return;
    await withContainerPorts(spare.hostId, (ports) =>
        ports.composeDown(commands.sessionContainerName(spare.sessionId))
    ).catch(() => undefined);
}

const legacySchema = z.object({ id: z.string().uuid(), hostId: z.string().uuid().nullable() });

/**
 * Reservations from before the table, kept as settings rows. Their containers
 * go with them: one on a pool server is found by nothing else, since the pool's
 * leftover sweep reads session rows and a spare has none. Bounded per run.
 */
async function sweepLegacy(): Promise<void> {
    const rows = await prisma.setting.findMany({
        where: { key: { startsWith: LEGACY_PREFIX } },
        select: { key: true, value: true },
        take: SWEEP_BATCH
    });
    for (const row of rows) {
        let parsed: z.infer<typeof legacySchema> | null = null;
        try {
            const result = legacySchema.safeParse(JSON.parse(row.value));
            parsed = result.success ? result.data : null;
        } catch {
            parsed = null;
        }
        if (parsed) {
            await removeUnclaimed({ sessionId: parsed.id, hostId: parsed.hostId, expiresAt: new Date(0) });
        }
        await prisma.setting.deleteMany({ where: { key: row.key } });
    }
}

/**
 * Take down the spares nobody used: a reservation past its expiry goes, and
 * its container with it. Bounded per run; the rest wait for the next one.
 */
export async function sweepSpares(now = Date.now()): Promise<number> {
    await sweepLegacy().catch(() => undefined);
    const cutoff = new Date(now);
    const expired = await prisma.agentSpare.findMany({
        where: { expiresAt: { lte: cutoff } },
        select: { userId: true, ...SPARE_FIELDS },
        orderBy: { expiresAt: "asc" },
        take: SWEEP_BATCH
    });
    let removed = 0;
    for (const spare of expired) {
        // Only if it was not pushed back or replaced since it was read.
        const { count } = await prisma.agentSpare.deleteMany({
            where: { userId: spare.userId, sessionId: spare.sessionId, expiresAt: { lte: cutoff } }
        });
        if (count !== 1) continue;
        await removeUnclaimed(spare);
        removed += 1;
    }
    return removed;
}

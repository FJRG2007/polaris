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
 * What a spare costs, measured on a home server: the container is 0.5 MB of
 * memory and no CPU while it waits (tmux is installed and asleep); the image is
 * the one sessions already use. Bounded per server by the administrator, and
 * gone after its expiry unless the person is still in Code.
 *
 * Kept in the settings table, one row per account (`polar.code.spare.u.<id>`),
 * so a reservation is read by key and taken by a conditional delete: two tabs
 * sending at once cannot both take one.
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

const SPARE_PREFIX = "polar.code.spare.u.";

const spareSchema = z.object({
    id: z.string().uuid(),
    hostId: z.string().uuid().nullable(),
    expiresAt: z.number()
});

type Spare = z.infer<typeof spareSchema>;

function spareKey(userId: string): string {
    return `${SPARE_PREFIX}${userId}`;
}

function parseSpare(value: string | null): Spare | null {
    if (!value) return null;
    try {
        const parsed = spareSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * Every reservation, with its account. Bounded: there is at most one per
 * person in Code, and `perServer` caps them per machine.
 */
// enigma: a settings-table prefix scan; a table of its own with an index on
// (hostId, expiresAt) when spares are counted in the tens of thousands.
async function allSpares(take = 5000): Promise<{ userId: string; spare: Spare; raw: string }[]> {
    const rows = await prisma.setting.findMany({
        where: { key: { startsWith: SPARE_PREFIX } },
        select: { key: true, value: true },
        take
    });
    return rows.flatMap((row) => {
        const spare = parseSpare(row.value);
        return spare ? [{ userId: row.key.slice(SPARE_PREFIX.length), spare, raw: row.value }] : [];
    });
}

/** The ids of every reserved spare, for the sweep of leftover containers,
 *  which would otherwise take a spare for a container nobody owns. */
export async function reservedSpareIds(): Promise<Set<string>> {
    return new Set((await allSpares()).map((entry) => entry.spare.id));
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
        const expiresAt = now + warm.minutes * 60_000;
        const key = spareKey(userId);
        const current = await getSetting(key);
        const held = parseSpare(current);
        if (held && held.expiresAt > now) {
            // Pushed back only once half of it has run: Code asks every minute
            // while it is open, and a write per open tab per minute is a write
            // nobody needed.
            if (held.expiresAt - now < (warm.minutes * 60_000) / 2)
                await setSetting(key, JSON.stringify({ ...held, expiresAt }));
            return true;
        }

        const [pool, box, spares, home] = await Promise.all([
            readPool(),
            totalCeiling(),
            allSpares(),
            homeOf(userId)
        ]);
        const perServer = new Map<string | null, number>();
        for (const { spare } of spares) {
            if (spare.expiresAt > now)
                perServer.set(spare.hostId, (perServer.get(spare.hostId) ?? 0) + 1);
        }
        // Where a session would go, among the machines with room for a spare.
        const candidates = (await poolCandidates(pool, box)).filter(
            (candidate) => (perServer.get(candidate.hostId) ?? 0) < warm.perServer
        );
        const hostId = choosePlacement(candidates, home);
        if (hostId === undefined) return false;

        const spare: Spare = { id: randomUUID(), hostId, expiresAt };
        // Only if nothing took the key since it was read: two tabs opening Code
        // at once start one spare, not two.
        const { count } = current
            ? await prisma.setting.updateMany({
                  where: { key, value: current },
                  data: { value: JSON.stringify(spare) }
              })
            : await prisma.setting.createMany({
                  data: [{ key, value: JSON.stringify(spare), scope: "global" }],
                  skipDuplicates: true
              });
        if (count !== 1) return true;
        // The one it replaced had expired; its container goes now rather than
        // at the next sweep.
        if (held) await removeSpareContainer(held);
        await startContainer({ id: spare.id, hostId, ownerId: userId, sharedHome: false }, {}, commands.SPARE_BOOT);
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
        const key = spareKey(userId);
        const raw = await getSetting(key);
        const spare = parseSpare(raw);
        if (!raw || !spare || spare.expiresAt <= now) return null;
        if (session.useMachineLogin && spare.hostId !== null) return null;
        const { count } = await prisma.setting.deleteMany({ where: { key, value: raw } });
        return count === 1 ? { id: spare.id, hostId: spare.hostId } : null;
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

async function removeSpareContainer(spare: Spare): Promise<void> {
    await withContainerPorts(spare.hostId, (ports) =>
        ports.composeDown(commands.sessionContainerName(spare.id))
    ).catch(() => undefined);
}

/**
 * Take down the spares nobody used. A reservation past its expiry goes, and
 * its container with it - unless a session was created under its id in the
 * meantime, in which case the container is that session's.
 */
export async function sweepSpares(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const { userId, spare, raw } of await allSpares()) {
        if (spare.expiresAt > now) continue;
        const { count } = await prisma.setting.deleteMany({
            where: { key: spareKey(userId), value: raw }
        });
        if (count !== 1) continue;
        const session = await prisma.agentSession.findUnique({
            where: { id: spare.id },
            select: { id: true }
        });
        if (!session) await removeSpareContainer(spare);
        removed += 1;
    }
    return removed;
}

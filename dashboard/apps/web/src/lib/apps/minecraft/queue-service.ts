/**
 * Writing a decision down, and carrying it out when the server can hear it.
 *
 * Draining runs from the two places every other deferred pass in this app runs
 * from: the cron walk, and the players screen being read. So an instance with no
 * cron configured still applies what is waiting - it just applies it when somebody
 * is looking, which for a screen about who is playing is most of the time.
 *
 * Nothing here retries forever. An entry that has been waiting thirty days is
 * dropped, because a decision taken a month ago and executed the moment somebody
 * logs back in is a surprise rather than a service.
 */

import { prisma } from "@polaris/db";
import { giveItem, giveToSlot } from "./item-service";
import { withServerContainer, type ServerContainer } from "./service";
import {
    NEEDS_PLAYER,
    QUEUE_TTL_MS,
    parseQueuedPayload,
    type QueuedAction,
    type QueuedKind,
    type QueuedPayload
} from "./queue";

const FIELDS = {
    id: true,
    username: true,
    kind: true,
    payload: true,
    needsPlayer: true,
    expiresAt: true,
    lastError: true,
    createdAt: true
} as const;

interface StoredRow {
    id: string;
    username: string;
    kind: string;
    payload: string;
    needsPlayer: boolean;
    expiresAt: Date;
    lastError: string | null;
    createdAt: Date;
}

/** A stored row in the shape a screen reads, or null when it cannot be read. */
function toAction(row: StoredRow): QueuedAction | null {
    const payload = parseQueuedPayload(row.kind, row.payload);
    if (!payload) return null;
    return {
        id: row.id,
        username: row.username,
        kind: row.kind as QueuedKind,
        payload,
        needsPlayer: row.needsPlayer,
        expiresAt: row.expiresAt.toISOString(),
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString()
    };
}

/** Write a decision down. */
export async function queueAction(input: {
    installedAppId: string;
    username: string;
    payload: QueuedPayload;
    requestedById: string;
}): Promise<QueuedAction | null> {
    const { kind, ...rest } = input.payload;
    const row = await prisma.playerActionQueue.create({
        data: {
            installedAppId: input.installedAppId,
            username: input.username,
            kind,
            payload: JSON.stringify(rest),
            needsPlayer: NEEDS_PLAYER[kind],
            requestedById: input.requestedById,
            expiresAt: new Date(Date.now() + QUEUE_TTL_MS)
        },
        select: FIELDS
    });
    return toAction(row);
}

/** What is still waiting on this server, oldest first. */
export async function pendingFor(installedAppId: string, username?: string): Promise<QueuedAction[]> {
    const rows = await prisma.playerActionQueue.findMany({
        where: {
            installedAppId,
            appliedAt: null,
            ...(username ? { username: { equals: username, mode: "insensitive" as const } } : {})
        },
        orderBy: { createdAt: "asc" },
        select: FIELDS
    });
    return rows.flatMap((row) => toAction(row) ?? []);
}

/** Change your mind. */
export async function cancelAction(installedAppId: string, id: string): Promise<void> {
    await prisma.playerActionQueue.deleteMany({ where: { id, installedAppId, appliedAt: null } });
}

/** Forget everything waiting on a server. Called when the server itself goes. */
export async function clearQueue(installedAppId: string): Promise<void> {
    await prisma.playerActionQueue.deleteMany({ where: { installedAppId } });
}

/** The command one waiting entry becomes, for everything that is a plain verb. */
function commandFor(username: string, payload: QueuedPayload): string[] | null {
    switch (payload.kind) {
        case "give":
            return ["give", username, payload.item, String(payload.count)];
        case "clear":
            return ["clear", username, payload.item, String(payload.count)];
        case "ban":
            return ["ban", username, ...(payload.reason ? [payload.reason] : [])];
        case "pardon":
            return ["pardon", username];
        case "op":
            return ["op", username];
        case "deop":
            return ["deop", username];
        case "whitelist-add":
            return ["whitelist", "add", username];
        case "whitelist-remove":
            return ["whitelist", "remove", username];
        // A slot write is not one command and goes through the service that knows
        // which spelling this server takes.
        case "set-slot":
            return null;
    }
}

export interface DrainReport {
    readonly applied: number;
    readonly expired: number;
    readonly failed: number;
}

/**
 * Apply everything that can be applied right now.
 *
 * `online` is the player list the caller has already read - the poll asks for it
 * every few seconds anyway, so a join is noticed without a second watcher and
 * without a log parse of its own.
 */
export async function drainQueue(
    ownerId: string,
    installedAppId: string,
    online: readonly string[],
    now: Date = new Date()
): Promise<DrainReport> {
    const rows = await prisma.playerActionQueue.findMany({
        where: { installedAppId, appliedAt: null },
        orderBy: { createdAt: "asc" },
        select: { ...FIELDS, requestedById: true }
    });
    if (rows.length === 0) return { applied: 0, expired: 0, failed: 0 };

    const lapsed = rows.filter((row) => row.expiresAt <= now);
    for (const row of lapsed) {
        await prisma.playerActionQueue.delete({ where: { id: row.id } }).catch(() => null);
        // Recorded rather than dropped quietly: somebody asked for this, and the
        // answer "it never happened" is one they are owed an entry for.
        //
        // Imported here rather than at the top on purpose. The audit trail reaches
        // the auth instance, which validates the whole environment the moment it
        // is loaded - and this module is reached from games-service, which is
        // imported by code that has no business needing a database URL. One line
        // inside the branch that almost never runs keeps that graph clean.
        if (row.requestedById) {
            const { recordAudit } = await import("@/lib/audit-service");
            await recordAudit({
                actorId: row.requestedById,
                action: "minecraft.queued-expired",
                targetType: "installedApp",
                targetId: installedAppId,
                metadata: { player: row.username, kind: row.kind }
            }).catch(() => undefined);
        }
    }

    const present = new Set(online.map((player) => player.toLowerCase()));
    const ready = rows
        .filter((row) => row.expiresAt > now)
        .filter((row) => !row.needsPlayer || present.has(row.username.toLowerCase()));
    if (ready.length === 0) return { applied: 0, expired: lapsed.length, failed: 0 };

    let applied = 0;
    let failed = 0;
    await withServerContainer(ownerId, installedAppId, async (server) => {
        for (const row of ready) {
            const action = toAction(row);
            if (!action) {
                // A row nobody can read applies nothing, ever. Dropping it is the
                // only outcome that does not leave it retried forever.
                await prisma.playerActionQueue.delete({ where: { id: row.id } }).catch(() => null);
                continue;
            }
            try {
                await apply(server, ownerId, installedAppId, action);
                await prisma.playerActionQueue.update({
                    where: { id: row.id },
                    data: { appliedAt: new Date(), lastError: null }
                });
                applied += 1;
            } catch (caught) {
                failed += 1;
                await prisma.playerActionQueue
                    .update({
                        where: { id: row.id },
                        data: { lastError: caught instanceof Error ? caught.message.slice(0, 200) : "Refused" }
                    })
                    .catch(() => null);
            }
        }
    });
    return { applied, expired: lapsed.length, failed };
}

async function apply(
    server: ServerContainer,
    ownerId: string,
    installedAppId: string,
    action: QueuedAction
): Promise<void> {
    if (action.payload.kind === "set-slot") {
        await giveToSlot(
            ownerId,
            installedAppId,
            action.username,
            action.payload.slot,
            action.payload.item,
            action.payload.count
        );
        return;
    }
    // A waiting give carries a total, which arrives as stacks - the same split the
    // give itself does, rather than one command with a number the server may
    // refuse once nobody is watching.
    if (action.payload.kind === "give") {
        await giveItem(ownerId, installedAppId, action.username, action.payload.item, action.payload.count);
        return;
    }
    const argv = commandFor(action.username, action.payload);
    if (!argv) throw new Error("Nothing to run");
    await server.say(argv);
}

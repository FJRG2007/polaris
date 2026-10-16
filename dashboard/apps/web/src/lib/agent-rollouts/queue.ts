/**
 * The offline command queue's rules, as pure functions: what a command may say,
 * how long it waits, how many may wait, and in which order they go out.
 */

import { z } from "zod";

/** No server may have more than this many commands waiting. */
export const QUEUE_LIMIT = 50;
/** A command left in "delivering" this long was cut off mid-delivery. */
export const DELIVERY_STALE_MS = 10 * 60_000;
/** Attempts before an interrupted command is given up on. */
export const MAX_ATTEMPTS = 3;

export const EXPIRY_CHOICES = { "1h": 3_600_000, "1d": 86_400_000, "7d": 604_800_000 } as const;
export type ExpiryChoice = keyof typeof EXPIRY_CHOICES;

const containerName = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

export const commandSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("container.restart"), container: containerName }),
    z.object({ kind: z.literal("container.start"), container: containerName }),
    z.object({ kind: z.literal("container.stop"), container: containerName }),
    z.object({ kind: z.literal("template.apply"), assignmentId: z.string().uuid() }),
    z.object({ kind: z.literal("agent.update"), version: z.string().trim().min(1).max(64) })
]);
export type CommandSpec = z.infer<typeof commandSchema>;
export type CommandKind = CommandSpec["kind"];
export const COMMAND_KINDS: readonly CommandKind[] = [
    "container.restart",
    "container.start",
    "container.stop",
    "template.apply",
    "agent.update"
];

export const serverIdSchema = z.union([z.literal("local"), z.string().uuid()]);

export const enqueueSchema = z.object({
    id: z.string().uuid(),
    serverId: serverIdSchema,
    expiry: z.enum(["1h", "1d", "7d"]).default("1d"),
    command: commandSchema
});

/** What a queued row's payload says, read total: a stored row is older than
 *  this code, so a payload that no longer parses is refused, not trusted. */
export function readCommand(kind: string, payload: string): CommandSpec | null {
    try {
        const parsed = commandSchema.safeParse({ ...JSON.parse(payload), kind });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function payloadOf(command: CommandSpec): string {
    const { kind: _kind, ...rest } = command;
    return JSON.stringify(rest);
}

export interface QueuedRow {
    readonly id: string;
    readonly status: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly startedAt: Date | null;
    readonly attempts: number;
}

/**
 * Split a server's waiting commands into the ones to expire, the ones to give up
 * on and the ones to deliver now, oldest first (ties by id, which is
 * time-ordered). A command cut off mid-delivery goes out again while it has
 * attempts left; every kind is safe to repeat.
 */
export function drainOrder<T extends QueuedRow>(
    rows: readonly T[],
    now: Date
): { deliver: T[]; expire: T[]; abandon: T[] } {
    const deliver: T[] = [];
    const expire: T[] = [];
    const abandon: T[] = [];
    for (const row of rows) {
        if (row.status === "delivering") {
            const stale =
                row.startedAt !== null &&
                now.getTime() - row.startedAt.getTime() >= DELIVERY_STALE_MS;
            if (!stale) continue;
            if (row.attempts >= MAX_ATTEMPTS) abandon.push(row);
            else if (row.expiresAt <= now) expire.push(row);
            else deliver.push(row);
            continue;
        }
        if (row.status !== "queued") continue;
        if (row.expiresAt <= now) expire.push(row);
        else deliver.push(row);
    }
    deliver.sort(
        (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return { deliver, expire, abandon };
}

export function hasRoom(waiting: number): boolean {
    return waiting < QUEUE_LIMIT;
}

/** Only a waiting command can be cancelled; one already out cannot be called back. */
export function cancellable(status: string): boolean {
    return status === "queued";
}

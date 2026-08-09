/**
 * Decisions the server could not be told yet.
 *
 * An operator decides something at four in the afternoon about a player who is
 * asleep. Until now the panel simply turned every verb off and the decision lived
 * in somebody's head until they saw the player online. This is the vocabulary for
 * writing it down instead.
 *
 * Pure: the players screen renders what is waiting, and the service that drains it
 * runs on the server. Both read the shapes from here so they cannot disagree about
 * what a queued entry means.
 */

import { z } from "zod";

/** Every kind of thing that can wait. */
export const QUEUED_KINDS = [
    "give",
    "clear",
    "set-slot",
    "ban",
    "pardon",
    "op",
    "deop",
    "whitelist-add",
    "whitelist-remove"
] as const;

export type QueuedKind = (typeof QUEUED_KINDS)[number];

/**
 * Which kinds need the player standing there, and which only need the server up.
 *
 * A ban lands on a name whether or not it is connected - Java writes it to
 * banned-players.json either way - so holding one back until the player returns
 * would be holding it back for exactly the person it is meant to keep out.
 */
export const NEEDS_PLAYER: Readonly<Record<QueuedKind, boolean>> = {
    give: true,
    clear: true,
    "set-slot": true,
    ban: false,
    pardon: false,
    op: false,
    deop: false,
    "whitelist-add": false,
    "whitelist-remove": false
};

/** How long a decision keeps. Something settled months ago and executed the
 *  moment somebody logs back in is a surprise, not a feature. */
export const QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const itemPayload = z.object({
    item: z.string().trim().min(1).max(128),
    /** A total, not a stack: what is waiting is the amount somebody asked for, and
     *  it is cut into stacks when it is handed over. A bag's worth is the ceiling,
     *  the same one the give itself takes. */
    count: z.number().int().min(1).max(2304)
});

export const queuePayloadSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("give") }).merge(itemPayload),
    z.object({ kind: z.literal("clear") }).merge(itemPayload),
    z.object({ kind: z.literal("set-slot"), slot: z.number().int().min(-128).max(127) }).merge(itemPayload),
    z.object({ kind: z.literal("ban"), reason: z.string().trim().max(200).optional() }),
    z.object({ kind: z.literal("pardon") }),
    z.object({ kind: z.literal("op") }),
    z.object({ kind: z.literal("deop") }),
    z.object({ kind: z.literal("whitelist-add") }),
    z.object({ kind: z.literal("whitelist-remove") })
]);

export type QueuedPayload = z.infer<typeof queuePayloadSchema>;

/** Read a stored payload back. Validated on the way out as well as in: a row
 *  written by an older version, or edited by hand, must apply nothing rather than
 *  something nobody chose. */
export function parseQueuedPayload(kind: string, raw: string): QueuedPayload | null {
    try {
        const parsed = queuePayloadSchema.safeParse({ kind, ...JSON.parse(raw) });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** One waiting entry, as a screen shows it. */
export interface QueuedAction {
    readonly id: string;
    readonly username: string;
    readonly kind: QueuedKind;
    readonly payload: QueuedPayload;
    readonly needsPlayer: boolean;
    readonly expiresAt: string;
    readonly lastError: string | null;
    readonly createdAt: string;
}

/** What is waiting, in a sentence somebody can act on. */
export function describeQueued(action: QueuedAction): string {
    const payload = action.payload;
    switch (payload.kind) {
        case "give":
            return `Give ${payload.count} x ${payload.item}`;
        case "clear":
            return `Take away ${payload.count} x ${payload.item}`;
        case "set-slot":
            return `Put ${payload.count} x ${payload.item} in slot ${payload.slot}`;
        case "ban":
            return payload.reason ? `Ban (${payload.reason})` : "Ban";
        case "pardon":
            return "Lift the ban";
        case "op":
            return "Make an operator";
        case "deop":
            return "Take away operator";
        case "whitelist-add":
            return "Add to the whitelist";
        case "whitelist-remove":
            return "Remove from the whitelist";
    }
}

/** What it is waiting for, so a row says why nothing has happened. */
export function waitingOn(action: QueuedAction): string {
    return action.needsPlayer ? "Waiting for them to join" : "Waiting for the server";
}

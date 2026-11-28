/**
 * The audit trail and the per-order version. Both are written inside the
 * transaction of the change they describe, so there is never a change without
 * its record or a record of a change that did not happen. The table is
 * append-only in the database itself (a trigger refuses updates and deletes).
 *
 * Server-only.
 */

import { Prisma } from "@polaris/db";
import { HospitalityRefusal } from "./outcome";

export interface Actor {
    readonly id: string;
    readonly name: string;
    /** A linked device acting without a Polaris account. */
    readonly device?: boolean;
}

export const LIVE = ["open", "billed"];

export interface AuditEntry {
    readonly venueId: string;
    readonly kind: string;
    readonly orderId?: string | null;
    readonly shiftId?: string | null;
    readonly subjectId?: string | null;
    readonly payload?: Record<string, unknown>;
}

export function audit(tx: Prisma.TransactionClient, actor: Actor, entry: AuditEntry) {
    return tx.hospitalityAuditEvent.create({
        data: {
            venueId: entry.venueId,
            kind: entry.kind,
            orderId: entry.orderId ?? null,
            shiftId: entry.shiftId ?? null,
            subjectId: entry.subjectId ?? null,
            actorId: actor.device ? null : actor.id,
            actorName: actor.name,
            actorKind: actor.device ? "device" : "user",
            payload: (entry.payload ?? {}) as Prisma.InputJsonValue
        }
    });
}

/**
 * Raises an order's version, which also locks its row until the transaction
 * ends, so concurrent changes to one order run one after the other. With
 * `seen` (the version the device showed when the person acted), a change made
 * on what another device has since changed is refused with "orders.changed"
 * instead of overwriting it. Without it (adding lines, a payment: facts that
 * add up and never overwrite) the change always applies.
 */
export async function touchOrder(tx: Prisma.TransactionClient, orderId: string, actor: Actor, seen?: number): Promise<void> {
    const done = await tx.hospitalityOrder.updateMany({
        where: { id: orderId, status: { in: LIVE }, ...(seen === undefined ? {} : { version: seen }) },
        data: { version: { increment: 1 }, updatedByName: actor.name }
    });
    if (done.count === 0) {
        const now = await tx.hospitalityOrder.findUnique({ where: { id: orderId }, select: { status: true } });
        if (!now) throw new HospitalityRefusal("orders.gone");
        throw new HospitalityRefusal(LIVE.includes(now.status) ? "orders.changed" : "orders.closed");
    }
}

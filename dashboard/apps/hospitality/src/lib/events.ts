/**
 * What the venue tells the rest of Polaris: the automation events its manifest
 * declares, and the alert a waiter gets when their table is waiting. Sent after
 * the change is stored, never awaited by the screen that made it and never
 * thrown back at it - a refused or failed send is logged and the order goes on.
 *
 * Each key is the change itself (the batch fired, the payments taken, the
 * shift), so a device replaying the same request sends nothing twice.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";

const APP = "hospitality";
/** Whoever an automation runs as needs what the venue's own screens need. */
const PERMISSION = "hospitality.use";

type Payload = Record<string, string | number | boolean>;

function emit(event: string, payload: Payload, key: string): void {
    void host.automations
        .emitOwnAppEvent({ app: APP, name: `${APP}.${event}`, payload, key, permission: PERMISSION })
        .catch((caught: unknown) => console.error(`polaris: hospitality could not send ${event}:`, caught));
}

export function orderSent(orderId: string, venueId: string, lines: number, at: Date): void {
    if (lines > 0) emit("order-sent", { orderId, venueId, lines }, `${orderId}:${at.getTime()}`);
}

export function billPaid(
    orderId: string,
    venueId: string,
    due: number,
    closed: boolean,
    paymentIds: readonly string[]
): void {
    if (paymentIds.length > 0)
        emit("bill-paid", { orderId, venueId, due, closed }, [...paymentIds].sort().join(","));
}

export function shiftClosed(shiftId: string, venueId: string, zNumber: number, counted: number, expected: number): void {
    emit("shift-closed", { venueId, zNumber, counted, expected, difference: counted - expected }, shiftId);
}

export function productAvailability(productId: string, venueId: string | null, available: boolean, at: Date): void {
    emit(
        "product-availability",
        { productId, venueId: venueId ?? "", available },
        `${productId}:${venueId ?? "all"}:${at.getTime()}`
    );
}

/**
 * Food or drink is ready at the pass and the table is waiting for it: the event,
 * and an alert to the waiter who took the order unless they marked it ready.
 */
export function tableWaiting(
    order: { readonly id: string; readonly venueId: string; readonly name: string; readonly waiterId: string | null },
    ready: number,
    actorId: string,
    at: Date
): void {
    if (ready === 0) return;
    emit("table-waiting", { orderId: order.id, venueId: order.venueId, ready }, `${order.id}:${at.getTime()}`);
    if (!order.waiterId || order.waiterId === actorId) return;
    void host.notificationsDispatch
        .notify({
            userId: order.waiterId,
            event: `${APP}.table-waiting`,
            title: order.name,
            href: "/hospitality",
            metadata: { orderId: order.id, ready }
        })
        .catch((caught: unknown) => console.error("polaris: hospitality could not tell the waiter:", caught));
}

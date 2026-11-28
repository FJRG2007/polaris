/**
 * What the venue tells the rest of Polaris: each change as the event its
 * manifest declares, behind hospitality.use, keyed by the change so a device
 * replaying a request sends nothing twice; nothing when nothing changed; and a
 * "table waiting" alert to the waiter who took the order, never to the one who
 * marked it ready themselves. A failed send never reaches the screen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ events: [] as unknown[], alerts: [] as unknown[], fail: false }));
vi.mock("@polaris/app-host", () => ({
    host: {
        automations: {
            emitOwnAppEvent: async (event: unknown) => {
                if (sent.fail) throw new Error("down");
                sent.events.push(event);
                return true;
            }
        },
        notificationsDispatch: {
            notify: async (alert: unknown) => {
                sent.alerts.push(alert);
                return { inapp: "written" };
            }
        }
    }
}));

import * as events from "../../../../hospitality/src/lib/events";

const AT = new Date("2026-11-28T20:00:00.000Z");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    sent.events = [];
    sent.alerts = [];
    sent.fail = false;
});

describe("the venue's events", () => {
    it("sends each change as its declared event, behind the app's own permission", async () => {
        events.orderSent("o1", "v1", 3, AT);
        events.billPaid("o1", "v1", 0, true, ["p2", "p1"]);
        events.shiftClosed("s1", "v1", 7, 10_000, 10_250);
        events.productAvailability("pr1", null, false, AT);
        await flush();
        expect(sent.events).toEqual([
            { app: "hospitality", name: "hospitality.order-sent", payload: { orderId: "o1", venueId: "v1", lines: 3 }, key: `o1:${AT.getTime()}`, permission: "hospitality.use" },
            { app: "hospitality", name: "hospitality.bill-paid", payload: { orderId: "o1", venueId: "v1", due: 0, closed: true }, key: "p1,p2", permission: "hospitality.use" },
            {
                app: "hospitality",
                name: "hospitality.shift-closed",
                payload: { venueId: "v1", zNumber: 7, counted: 10_000, expected: 10_250, difference: -250 },
                key: "s1",
                permission: "hospitality.use"
            },
            {
                app: "hospitality",
                name: "hospitality.product-availability",
                payload: { productId: "pr1", venueId: "", available: false },
                key: `pr1:all:${AT.getTime()}`,
                permission: "hospitality.use"
            }
        ]);
    });

    it("sends nothing when nothing changed, and never throws when the send fails", async () => {
        events.orderSent("o1", "v1", 0, AT);
        events.billPaid("o1", "v1", 500, false, []);
        events.tableWaiting({ id: "o1", venueId: "v1", name: "Mesa 4", waiterId: "w1" }, 0, "k1", AT);
        await flush();
        expect(sent.events).toEqual([]);
        expect(sent.alerts).toEqual([]);
        sent.fail = true;
        expect(() => events.orderSent("o1", "v1", 1, AT)).not.toThrow();
        await flush();
    });
});

describe("a table waiting", () => {
    it("tells the waiter who took the order, by the table's name", async () => {
        events.tableWaiting({ id: "o1", venueId: "v1", name: "Mesa 4", waiterId: "w1" }, 2, "k1", AT);
        await flush();
        expect(sent.events).toEqual([expect.objectContaining({ name: "hospitality.table-waiting", payload: { orderId: "o1", venueId: "v1", ready: 2 } })]);
        expect(sent.alerts).toEqual([
            { userId: "w1", event: "hospitality.table-waiting", title: "Mesa 4", href: "/hospitality", metadata: { orderId: "o1", ready: 2 } }
        ]);
    });

    it("tells nobody when the waiter marked it ready, or nobody took it", async () => {
        events.tableWaiting({ id: "o1", venueId: "v1", name: "Mesa 4", waiterId: "w1" }, 1, "w1", AT);
        events.tableWaiting({ id: "o2", venueId: "v1", name: "Barra", waiterId: null }, 1, "k1", AT);
        await flush();
        expect(sent.events).toHaveLength(2);
        expect(sent.alerts).toEqual([]);
    });
});

/**
 * Everything the Service screen draws on its first paint, in one read: the
 * menu as the venue sells it and the venue's floor with its open orders. The
 * screen used to ask for the menu, wait, then ask for the floor - two server
 * round trips and three database rounds one after the other. With the venue
 * this device used last, every query starts at once; only a venue that no
 * longer exists costs a second round, for the floor of the one that does.
 *
 * Server-only.
 */

import { readMenu, type MenuView } from "./catalog";
import { remainingDue } from "../model/pricing";
import { readService, type OrderView, type ServiceView } from "./orders";

export interface ServiceScreenView {
    readonly menu: MenuView;
    /** Null when there is no venue yet: there is no floor to draw. */
    readonly service: ServiceView | null;
}

export interface OpenCheck {
    readonly order: OrderView;
    /** The table's name, or the order's own label (bar, takeaway). */
    readonly place: string;
    readonly left: number;
}

/**
 * Every check still open at a venue with what is left to collect, part-paid
 * ones first: the register settles a table that left it for later.
 */
export async function readOpenChecks(venueId: string): Promise<OpenCheck[]> {
    const service = await readService(venueId);
    const names = new Map(service.rooms.flatMap((r) => r.tables.map((t) => [t.id, t.name] as const)));
    return service.orders
        .map((order) => ({ order, place: (order.tableId && names.get(order.tableId)) || order.label, left: remainingDue(order.totals.total, order.paid) }))
        .filter((check) => check.left > 0 && check.order.lines.length > 0)
        .sort((a, b) => Number(b.order.paid > 0) - Number(a.order.paid > 0) || a.order.openedAt.localeCompare(b.order.openedAt));
}

export async function readServiceScreen(venueId: string | null): Promise<ServiceScreenView> {
    const early = venueId ? readService(venueId) : null;
    early?.catch(() => undefined);
    const menu = await readMenu(venueId);
    if (!menu.venueId) return { menu, service: null };
    const service = early && menu.venueId === venueId ? await early : await readService(menu.venueId);
    return { menu, service };
}

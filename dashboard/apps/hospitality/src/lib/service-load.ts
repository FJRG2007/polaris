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
import { readService, type ServiceView } from "./orders";

export interface ServiceScreenView {
    readonly menu: MenuView;
    /** Null when there is no venue yet: there is no floor to draw. */
    readonly service: ServiceView | null;
}

export async function readServiceScreen(venueId: string | null): Promise<ServiceScreenView> {
    const early = venueId ? readService(venueId) : null;
    early?.catch(() => undefined);
    const menu = await readMenu(venueId);
    if (!menu.venueId) return { menu, service: null };
    const service = early && menu.venueId === venueId ? await early : await readService(menu.venueId);
    return { menu, service };
}

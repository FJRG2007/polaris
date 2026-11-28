/**
 * What an area (outlet) of a venue sells and at what price, from three layers:
 * the catalogue, the venue's override, the area's override. And where a dish
 * is made: the area's routing rule for its category, else the venue's, else
 * the category's own station.
 *
 * A venue with no areas has one implicit area (`null`) that inherits
 * everything, so a simple bar gets exactly the catalogue with its venue's
 * prices and never meets this.
 *
 * Pure: the order screen, the QR menu and the server all read it the same way.
 */

export const MENU_MODES = ["shared", "subset", "own"] as const;
export type MenuMode = (typeof MENU_MODES)[number];

export interface AreaMenuArea {
    readonly id: string;
    readonly menuMode: MenuMode | string;
}

export interface AreaMenuProduct {
    readonly id: string;
    readonly price: number;
    readonly available: boolean;
    /** Set when the product belongs to one area's own menu. */
    readonly areaId: string | null;
}

export interface VenueLayer {
    readonly price: number | null;
    readonly available: boolean;
}

export interface AreaLayer {
    readonly price: number | null;
    readonly available: boolean | null;
    readonly listed: boolean;
}

export interface AreaItem {
    readonly listed: boolean;
    readonly price: number;
    readonly available: boolean;
}

/** One product as an area sells it. `area` null is the venue's implicit default area. */
export function areaItem(product: AreaMenuProduct, area: AreaMenuArea | null, venue?: VenueLayer | null, own?: AreaLayer | null): AreaItem {
    const mode = area?.menuMode ?? "shared";
    const local = product.areaId !== null;
    let listed: boolean;
    if (local) listed = area !== null && product.areaId === area.id;
    else if (mode === "shared") listed = own?.listed ?? true;
    else listed = own?.listed === true;
    const price = own?.price ?? venue?.price ?? product.price;
    const available = product.available && (venue?.available ?? true) && (own?.available ?? true);
    return { listed, price, available };
}

export interface RoutingRule {
    readonly areaId: string | null;
    readonly categoryId: string;
    readonly stationId: string;
}

/** The station a dish of `categoryId` ordered in `areaId` goes to, or the fallback. */
export function routeStation(rules: readonly RoutingRule[], areaId: string | null, categoryId: string, fallback: string | null): string | null {
    const own = areaId ? rules.find((r) => r.areaId === areaId && r.categoryId === categoryId) : undefined;
    const venue = rules.find((r) => r.areaId === null && r.categoryId === categoryId);
    return own?.stationId ?? venue?.stationId ?? fallback;
}

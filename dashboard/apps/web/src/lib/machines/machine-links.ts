/**
 * Where a server, container or domain opens in Places. Pure and client-safe, so
 * a screen and a test can use it without the readers behind it.
 */

import type { WatchCard } from "@/lib/watch-overview-service";

export type MachineKind = "server" | "container" | "domain";

/** Where a machine's card opens in Places. */
export function machineHref(kind: MachineKind, id: string): string {
    return `/places/machines/${kind}/${encodeURIComponent(id)}`;
}

/** A Watch card, opened in Places instead. A server keeps the route id Watch
 *  links it with, so the local machine keeps its address. */
export function inPlaces(card: WatchCard): WatchCard {
    if (card.kind === "server") {
        return { ...card, href: card.href.replace(/^\/watch\/server\//, "/places/machines/server/") };
    }
    return card.kind === "container" ? { ...card, href: machineHref("container", card.id) } : card;
}

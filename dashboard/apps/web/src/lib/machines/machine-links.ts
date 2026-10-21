/**
 * Where a server, container or domain opens in Places. Pure and client-safe, so
 * a screen and a test can use it without the readers behind it.
 */

import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
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
        return {
            ...card,
            href: card.href.replace(/^\/watch\/server\//, "/places/machines/server/")
        };
    }
    return card.kind === "container" ? { ...card, href: machineHref("container", card.id) } : card;
}

/**
 * A container's id in Places, given the Containers connection it is listed on:
 * the server's metric subject, as Watch keys it, then the engine's own id. Null
 * for an engine that is not one of the account's servers, which Places does not
 * list.
 */
export function containerMachineId(
    connection: { local?: boolean; host?: boolean; hostId?: string },
    containerId: string
): string | null {
    if (connection.local) return `${LOCAL_HOST_SUBJECT}:${containerId}`;
    return connection.host && connection.hostId ? `${connection.hostId}:${containerId}` : null;
}

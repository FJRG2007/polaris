/**
 * Where a Polar Code session runs, as the place picker names it and as a
 * session's start takes it: Polaris itself, one of the person's paired
 * computers (through its runner), or one of their own servers.
 *
 * Pure, so the composer and the server read one mapping.
 */

export type CodePlaceKind = "polaris" | "computer" | "server";

export interface CodePlaceTarget {
    kind: CodePlaceKind;
    /** The computer's or server's id; null for Polaris. */
    id: string | null;
}

/** A picked place as a session's start names it. */
export function placeOf(target: CodePlaceTarget): {
    place: "local" | "host" | "computer";
    hostId: string | null;
    runnerId: string | null;
} {
    if (target.kind === "computer" && target.id) return { place: "computer", hostId: null, runnerId: target.id };
    if (target.kind === "server" && target.id) return { place: "host", hostId: target.id, runnerId: null };
    return { place: "local", hostId: null, runnerId: null };
}

/** A place the picker lists besides Polaris. */
export interface PickedPlace {
    readonly id: string;
    readonly online: boolean;
    /** Absent on an answer from before servers were listed: a computer. */
    readonly kind?: "computer" | "server";
}

/** The picked place as the start and continue routes name it: Polaris when
 *  nothing is picked, or the pick is gone or offline. */
export function codePlaceTarget(places: readonly PickedPlace[] | null, id: string | null): CodePlaceTarget {
    const picked = id ? places?.find((place) => place.id === id && place.online) : undefined;
    if (!picked) return { kind: "polaris", id: null };
    return { kind: picked.kind ?? "computer", id: picked.id };
}

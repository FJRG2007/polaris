/**
 * Camera privacy, the parts a screen, a deck key and a test can all read
 * without reaching a database: what a target is, how it is written as one
 * string, and how a group's answers add up.
 *
 * Client-safe: imports nothing that touches the server.
 */

import { z } from "zod";

/** What a privacy switch is pointed at. A zone is a place's zone by name; the
 *  camera's own grouping, since cameras have no room. */
export type PrivacyTarget =
    | { readonly kind: "camera"; readonly id: string }
    | { readonly kind: "zone"; readonly placeId: string; readonly zone: string }
    | { readonly kind: "place"; readonly id: string };

const uuid = z.string().uuid();

/** A target as one string - what a deck key stores and an MCP call passes:
 *  `camera:<id>`, `place:<id>`, or `zone:<placeId>:<zone name>`. Null when it
 *  is not one. */
export function parseTarget(raw: string): PrivacyTarget | null {
    const [kind, ...rest] = raw.split(":");
    if (kind === "camera" || kind === "place") {
        const id = rest.join(":");
        return uuid.safeParse(id).success ? { kind, id } : null;
    }
    if (kind === "zone") {
        const [placeId, ...name] = rest;
        const zone = name.join(":").trim();
        if (!placeId || !uuid.safeParse(placeId).success || !zone || zone.length > 200) return null;
        return { kind, placeId, zone };
    }
    return null;
}

export function targetKey(target: PrivacyTarget): string {
    return target.kind === "zone"
        ? `zone:${target.placeId}:${target.zone}`
        : `${target.kind}:${target.id}`;
}

/** Why one camera did not switch, as a code the screen turns into a sentence. */
export type PrivacyFailure =
    | "password"
    | "account"
    | "locked"
    | "unsupported"
    | "certificate"
    | "unreachable"
    | "failed";

/** One camera's answer. `private` is what it is now - the camera's own word on
 *  one with a privacy mode, Polaris' on one without. */
export interface CameraPrivacy {
    readonly cameraId: string;
    readonly name: string;
    readonly private: boolean;
    /** Whether the camera itself stopped (Tapo), not only Polaris. */
    readonly native: boolean;
    readonly failure?: PrivacyFailure;
    /** Seconds to wait, on a camera that locked its sign-in. */
    readonly waitSeconds?: number;
}

/** A group as a key draws it: all private, none, or how many of how many. */
export function groupState(rows: readonly Pick<CameraPrivacy, "private">[]): {
    readonly all: boolean;
    readonly some: number;
    readonly total: number;
} {
    const some = rows.filter((row) => row.private).length;
    return { all: rows.length > 0 && some === rows.length, some, total: rows.length };
}

/** What pressing a group's switch means: private unless every camera already
 *  is, so a half-private zone is made whole rather than flipped both ways. */
export function nextPrivacy(rows: readonly Pick<CameraPrivacy, "private">[]): boolean {
    return !groupState(rows).all;
}

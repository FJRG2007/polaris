/**
 * Camera privacy, the parts a screen, a deck key and a test can all read
 * without reaching a database: what a target is, how it is written as one
 * string, and how a group's answers add up.
 *
 * Client-safe: imports nothing that touches the server.
 */

import { z } from "zod";

/** What a privacy switch is pointed at. A zone is a place's zone by name; a
 *  room is one of the place's rooms, the same ones its devices are in; a set is
 *  a group of cameras somebody picked by hand. */
export type PrivacyTarget =
    | { readonly kind: "camera"; readonly id: string }
    | { readonly kind: "zone"; readonly placeId: string; readonly zone: string }
    | { readonly kind: "room"; readonly id: string }
    | { readonly kind: "set"; readonly id: string }
    | { readonly kind: "place"; readonly id: string };

const ID_KINDS = ["camera", "room", "set", "place"] as const;

const uuid = z.string().uuid();

/** A target as one string - what a deck key stores and an MCP call passes:
 *  `camera:<id>`, `room:<id>`, `set:<id>`, `place:<id>`, or
 *  `zone:<placeId>:<zone name>`. Null when it is not one. */
export function parseTarget(raw: string): PrivacyTarget | null {
    const [kind, ...rest] = raw.split(":");
    const idKind = ID_KINDS.find((each) => each === kind);
    if (idKind) {
        const id = rest.join(":");
        return uuid.safeParse(id).success ? { kind: idKind, id } : null;
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

/** The wall's cameras the moment a switch is pressed, before any camera has
 *  answered: the ones switched show the new state at once. */
export function applyPrivacy<T extends { id: string; privacy: boolean }>(
    cameras: readonly T[],
    ids: readonly string[],
    wanted: boolean
): T[] {
    const switched = new Set(ids);
    return cameras.map((camera) => (switched.has(camera.id) ? { ...camera, privacy: wanted } : camera));
}

/** The wall's cameras once they answered: each takes its own answer, so one
 *  that refused goes back to what it was while the rest keep the change. */
export function settlePrivacy<T extends { id: string; privacy: boolean }>(
    cameras: readonly T[],
    results: readonly Pick<CameraPrivacy, "cameraId" | "private">[]
): T[] {
    const answers = new Map(results.map((row) => [row.cameraId, row.private]));
    return cameras.map((camera) => {
        const answer = answers.get(camera.id);
        return answer === undefined ? camera : { ...camera, privacy: answer };
    });
}

/** Put cameras back to how they were before a switch nobody answered. */
export function rollbackPrivacy<T extends { id: string; privacy: boolean }>(
    cameras: readonly T[],
    before: ReadonlyMap<string, boolean>
): T[] {
    return cameras.map((camera) => {
        const was = before.get(camera.id);
        return was === undefined ? camera : { ...camera, privacy: was };
    });
}

/** A group of cameras somebody picked by hand, as a screen sees it. */
export interface CameraSetView {
    readonly id: string;
    readonly placeId: string;
    readonly name: string;
    readonly cameraIds: readonly string[];
}

/** The most cameras one set may name: more than any house has, few enough that
 *  a set is always read whole. */
export const CAMERA_SET_LIMIT = 200;

/** One shared normalizer for the set form and the action behind it. */
export function normalizeCameraSetInput(input: Record<string, unknown>): Record<string, unknown> {
    const value = { ...input };
    if (typeof value.name === "string") value.name = value.name.trim().replace(/\s+/g, " ");
    if (Array.isArray(value.cameraIds))
        value.cameraIds = [...new Set(value.cameraIds.map((id) => String(id).trim().toLowerCase()))];
    return value;
}

export const cameraSetInputSchema = z.object({
    placeId: uuid,
    name: z.string().min(1, "Give it a name").max(60, "Keep the name under 60 characters"),
    cameraIds: z
        .array(uuid)
        .min(1, "Pick at least one camera")
        .max(CAMERA_SET_LIMIT, "That is more cameras than a set can hold")
});

export type CameraSetInput = z.infer<typeof cameraSetInputSchema>;

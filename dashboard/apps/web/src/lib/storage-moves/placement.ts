/**
 * Where a service keeps its data, as chosen from its own screen - the pure half.
 *
 * A network share answers every read and write over the network, and a game
 * server, a database or anything else that writes many small files a second
 * runs measurably slower from one than from the machine's own disk. So the
 * mode that puts data on a NAS without paying for it is `park`: the service
 * runs from this server's disk, and while it is stopped its data is kept on the
 * NAS instead, giving the disk back. Starting it brings the data home first and
 * then starts it. `nas` keeps it on the share all the time, for data that is
 * read rarely or a service whose speed does not matter; `server` keeps it here.
 *
 * Every change of place is an ordinary storage move (`plan.ts`): copied, checked,
 * switched, and the original only emptied once the copy is in use. Nothing here
 * ever moves a running service on its own - only a person choosing a mode does,
 * and the sweep waits for the service to be stopped.
 *
 * Everything here is free of I/O, so the whole of it is asserted in tests.
 */

import { z } from "zod";
import { sameLocation, type Location } from "./plan";

export const STORAGE_MODES = ["server", "park", "nas"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/** What a service was set to: the mode, and the NAS it uses for `park` and `nas`. */
export interface StorageChoice {
    readonly mode: StorageMode;
    readonly connectionId: string | null;
}

/** How long a `park` service stays stopped before its data is taken to the NAS.
 *  A stop that is a restart, or a server put down for a few minutes, is not worth
 *  a copy there and back. */
export const PARK_AFTER_MS = 30 * 60_000;

/** How long after a move Polaris started by itself failed before it tries again.
 *  A failure that will not fix itself (a full share, a NAS that is gone) is then
 *  a line on the screen every few hours, not a copy started every minute. */
export const RETRY_AFTER_MS = 6 * 60 * 60_000;

/** A stored mode and connection as a choice, or null when none was made or what
 *  is stored is not one Polaris knows. A NAS mode with no NAS is no choice. */
export function choiceOf(mode: string | null, connectionId: string | null): StorageChoice | null {
    if (mode === "server") return { mode, connectionId: null };
    if ((mode === "park" || mode === "nas") && connectionId) return { mode, connectionId };
    return null;
}

/** Where a choice keeps the data while the service is stopped. */
export function restingLocation(choice: StorageChoice): Location {
    return choice.mode === "server" || !choice.connectionId
        ? { kind: "server" }
        : { kind: "nas", connectionId: choice.connectionId };
}

export interface PlacedVolume {
    readonly id: string;
    readonly location: Location;
}

export type SweepAction =
    | { readonly kind: "none" }
    /** Note that the service was found stopped, to start `park`'s grace period. */
    | { readonly kind: "stamp" }
    /** Forget that note: the service is running again, or nothing is left to do. */
    | { readonly kind: "clear" }
    | { readonly kind: "move"; readonly volumeId: string; readonly to: Location };

/**
 * What the storage sweep does for one service on this pass. A volume is moved
 * only while the service is stopped by somebody (not asleep, which wakes on its
 * own in seconds), deployed, and not already being moved; one volume per pass,
 * since a service has one move at a time.
 */
export function sweepAction(input: {
    readonly choice: StorageChoice | null;
    readonly stopped: boolean;
    readonly deployed: boolean;
    readonly busy: boolean;
    readonly volumes: readonly PlacedVolume[];
    readonly pendingSince: Date | null;
    /** When the last move Polaris started by itself for this service failed. */
    readonly failedAt: Date | null;
    readonly now: Date;
}): SweepAction {
    const idle: SweepAction = input.pendingSince ? { kind: "clear" } : { kind: "none" };
    if (!input.choice || !input.stopped || !input.deployed) return idle;
    if (input.busy) return { kind: "none" };
    if (input.failedAt && input.now.getTime() - input.failedAt.getTime() < RETRY_AFTER_MS)
        return { kind: "none" };
    const target = restingLocation(input.choice);
    const away = input.volumes.find((volume) => !sameLocation(volume.location, target));
    if (!away) return idle;
    if (input.choice.mode === "park") {
        if (!input.pendingSince) return { kind: "stamp" };
        if (input.now.getTime() - input.pendingSince.getTime() < PARK_AFTER_MS)
            return { kind: "none" };
    }
    return { kind: "move", volumeId: away.id, to: target };
}

/**
 * The volume to bring back to this server before a `park` service starts, or
 * null when it is already home and starts as it always did. `park` is offered
 * only to a service with one volume (`parkable`), so one move is the whole of it.
 */
export function homecoming(
    choice: StorageChoice | null,
    volumes: readonly PlacedVolume[]
): string | null {
    if (choice?.mode !== "park") return null;
    return volumes.find((volume) => volume.location.kind === "nas")?.id ?? null;
}

/** Whether `park` can be offered: the copy home is one move, so one volume. */
export function parkable(volumeCount: number): boolean {
    return volumeCount === 1;
}

// ---------------------------------------------------------------------------
// The instance's rule for game servers
// ---------------------------------------------------------------------------

/**
 * What whoever runs the instance decides for every game server: where a new one
 * keeps its data, which NAS locations owners may pick, and whether owners may
 * pick at all - when not, the default is the place of every game server, and
 * the sweep takes each one there the next time it is stopped.
 */
export interface StoragePolicy {
    readonly defaultMode: StorageMode;
    readonly defaultConnectionId: string | null;
    readonly ownersChoose: boolean;
    /** The NAS locations owners may pick from; null for every one they have. */
    readonly allowedConnectionIds: readonly string[] | null;
    /** When the default was last changed: a game server created since then that
     *  nobody chose for keeps its data where the default says. Older ones stay
     *  where they are until somebody chooses. */
    readonly since: string | null;
}

export const POLICY_SETTING = "storage.gamePolicy";

export const DEFAULT_POLICY: StoragePolicy = {
    defaultMode: "server",
    defaultConnectionId: null,
    ownersChoose: true,
    allowedConnectionIds: null,
    since: null
};

export const policySchema = z
    .object({
        defaultMode: z.enum(STORAGE_MODES),
        defaultConnectionId: z.string().uuid().nullable(),
        ownersChoose: z.boolean(),
        allowedConnectionIds: z.array(z.string().uuid()).max(100).nullable(),
        since: z.string().datetime().nullable().default(null)
    })
    .refine((value) => value.defaultMode === "server" || value.defaultConnectionId !== null, {
        message: "defaultConnection",
        path: ["defaultConnectionId"]
    });

/** The stored rule, or the default when nothing (or nothing readable) is stored. */
export function parsePolicy(raw: string | null): StoragePolicy {
    if (!raw) return DEFAULT_POLICY;
    try {
        const parsed = policySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : DEFAULT_POLICY;
    } catch {
        return DEFAULT_POLICY;
    }
}

/** The policy's default as a choice, or null for a NAS default whose NAS is gone. */
export function policyChoice(policy: StoragePolicy): StorageChoice | null {
    return choiceOf(policy.defaultMode, policy.defaultConnectionId);
}

/** Whether the instance's default is what applies to this service rather than
 *  its own choice: a game server while owners may not choose, or one nobody
 *  chose for that was created after the default was set. */
function followsDefault(
    own: StorageChoice | null,
    policy: StoragePolicy,
    game: boolean,
    createdAt: Date
): boolean {
    if (!game) return false;
    if (!policy.ownersChoose) return true;
    return own === null && policy.since !== null && createdAt.getTime() >= Date.parse(policy.since);
}

/** Whether a choice can be followed by a service whose owner has these NAS
 *  locations: a NAS is one owner's, and a move only goes to its owner's own. */
function reachable(choice: StorageChoice | null, owned: readonly string[]): boolean {
    return !choice?.connectionId || owned.includes(choice.connectionId);
}

/**
 * The choice that applies to a service: its own, unless it is a game server and
 * owners may not choose, when the instance's default applies to it as well. A
 * game server nobody chose for follows the default when it was created after the
 * default was set; one from before keeps its data where it already is. A default
 * on a NAS its owner does not have is no choice for it: it stays where it is.
 */
export function effectiveChoice(
    own: StorageChoice | null,
    policy: StoragePolicy,
    game: boolean,
    createdAt: Date,
    owned: readonly string[]
): StorageChoice | null {
    if (!followsDefault(own, policy, game, createdAt)) return own;
    const choice = policyChoice(policy);
    return reachable(choice, owned) ? choice : null;
}

/** Whether the instance's default applies to a service that cannot follow it,
 *  because its owner does not have the default's NAS. */
export function defaultOutOfReach(
    own: StorageChoice | null,
    policy: StoragePolicy,
    game: boolean,
    createdAt: Date,
    owned: readonly string[]
): boolean {
    return followsDefault(own, policy, game, createdAt) && !reachable(policyChoice(policy), owned);
}

/** The NAS locations a game server's owner may pick among those they have. */
export function offeredConnections(
    owned: readonly string[],
    policy: StoragePolicy,
    game: boolean
): string[] {
    if (!game || policy.allowedConnectionIds === null) return [...owned];
    const allowed = new Set(policy.allowedConnectionIds);
    return owned.filter((id) => allowed.has(id));
}

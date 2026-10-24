/**
 * A game played together inside a call: what is said, by whom, and what of it
 * is believed.
 *
 * Two things travel, and they travel the way hands and reactions do (see
 * `call-signals`):
 *
 * - **Who is playing is a state.** Each player's browser writes a claim into
 *   its own participant attribute - the game, when it joined, and a pass the
 *   server signed for that seat and that game. Somebody who arrives later reads
 *   it off the attributes; somebody who leaves the call takes it with them, so
 *   nobody has to say goodbye for the game to forget them.
 * - **Where each player is is an event.** Position, heading and vehicle, ten
 *   times a second at most, as unreliable data messages to the other players
 *   only. A late one is worth nothing, so it is never retransmitted.
 *
 * Nothing else is synced: no world state, no traffic, no score - each browser
 * runs its own city and draws the others in it.
 *
 * Every message here comes from somebody else's browser or from a frame, so all
 * of it is parsed with the same strictness as a request body. Pure, so it can
 * be checked without a call server.
 */

import { z } from "zod";

/** The attribute a player's claim rides in. Empty is how it is taken back. */
export const ACTIVITY_ATTRIBUTE = "activity";

/** The data topic positions travel on. */
export const ACTIVITY_TOPIC = "polaris-activity";

/** How long a pass stays good, and how long before it runs out a playing
 *  browser renews it - see `lib/chat/activity-pass`. */
export const PASS_TTL_MS = 5 * 60 * 1000;
export const RENEW_BEFORE_MS = 2 * 60 * 1000;

/** When a pass runs out, read off its own first half, or 0 for a pass that
 *  does not say. Says nothing about whether it is real: that is the server's. */
export function passExpiresAt(pass: string): number {
    const expires = pass.split(".")[0] ?? "";
    return /^\d{10,16}$/.test(expires) ? Number(expires) : 0;
}

/** The most players drawn in one game, which is also what the frame accepts. */
export const MAX_PLAYERS = 32;

/** How often a position is passed on, at most, per player. */
export const POSE_EVERY_MS = 100;

const gameId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

/** A coordinate the city could hold. Generous, and finite - a NaN or an
 *  infinity would put a player nowhere and break whatever draws them. */
const coordinate = z.number().finite().min(-1e6).max(1e6);

export const VEHICLES = ["person", "car", "cyclist", "helicopter"] as const;

export type Vehicle = (typeof VEHICLES)[number];

/** The same direction, as an angle between -pi and pi. A game adds to its
 *  heading as a player turns and never wraps it, so an unwrapped one grows
 *  without end. */
export function wrapHeading(heading: number): number {
    return Math.atan2(Math.sin(heading), Math.cos(heading));
}

export const poseSchema = z
    .object({
        x: coordinate,
        y: coordinate,
        z: coordinate,
        heading: z.number().finite().min(-Math.PI).max(Math.PI),
        mode: z.enum(VEHICLES)
    })
    .strict();

export type Pose = z.infer<typeof poseSchema>;

/** What a player says about themselves in their attribute. */
export const activityClaimSchema = z
    .object({
        game: gameId,
        /** When they started or joined, which orders the players and decides
         *  which game a call is playing if two were started at once. */
        at: z.number().int().positive(),
        pass: z.string().min(1).max(200)
    })
    .strict();

export type ActivityClaim = z.infer<typeof activityClaimSchema>;

/** A claim as the attribute carries it. */
export function encodeClaim(claim: ActivityClaim | null): string {
    return claim ? JSON.stringify(claim) : "";
}

/** The claim an attribute bag carries, or null for none or for anything that
 *  is not one. */
export function readClaim(attributes: Record<string, string> | undefined): ActivityClaim | null {
    const raw = attributes?.[ACTIVITY_ATTRIBUTE];
    if (!raw || raw.length > 400) return null;
    try {
        const parsed = activityClaimSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** One person in the call, as the session needs them. */
export interface ActivityPerson {
    readonly seat: string;
    readonly claim: ActivityClaim | null;
}

/** The game a call is playing, and who is in it. */
export interface ActivitySession {
    readonly game: string;
    /** The seat that started it: the earliest claim. */
    readonly startedBy: string;
    /** Players, earliest first. */
    readonly players: readonly string[];
}

/**
 * The game this call is playing, from what everybody has claimed and which of
 * those claims the server has vouched for.
 *
 * One game per call. If two people start different games at the same moment,
 * the earlier claim wins in every browser - the order is read from facts all of
 * them see, so there is nothing to agree on - and the other is shown as an
 * offer to join instead. A claim the server has not vouched for counts for
 * nothing: holding a seat in the call is not permission to play in it.
 */
export function activitySession(
    people: readonly ActivityPerson[],
    vouched: ReadonlySet<string>,
    /** Claims whose pass ran out by then count for nothing: a player who lost
     *  the permission cannot renew theirs. */
    now = Date.now()
): ActivitySession | null {
    const claimed = people
        .filter(
            (person) =>
                person.claim && vouched.has(person.seat) && passExpiresAt(person.claim.pass) > now
        )
        .map((person) => ({ seat: person.seat, claim: person.claim! }))
        .sort(
            (left, right) => left.claim.at - right.claim.at || left.seat.localeCompare(right.seat)
        );
    const first = claimed[0];
    if (!first) return null;
    const players = claimed
        .filter((entry) => entry.claim.game === first.claim.game)
        .slice(0, MAX_PLAYERS)
        .map((entry) => entry.seat);
    return { game: first.claim.game, startedBy: first.seat, players };
}

/** What one player's browser tells the others. */
export const activityMessageSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pose"), game: gameId, pose: poseSchema }).strict()
]);

export type ActivityMessage = z.infer<typeof activityMessageSchema>;

/** Parse a data message as it arrives, or null for anything that does not fit. */
export function readActivityMessage(payload: unknown): ActivityMessage | null {
    const parsed = activityMessageSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

/** The reader's own position as the game's frame reports it
 *  (`polaris-game:state`, see `apps/arcade/game/<game>/engine/embed.js`), or
 *  null for anything that does not fit. The heading is wrapped first. */
export function readFramePose(payload: unknown): Pose | null {
    if (!payload || typeof payload !== "object") return null;
    const { x, y, z, heading, mode } = payload as Record<string, unknown>;
    const pose = poseSchema.safeParse({
        x,
        y,
        z,
        heading: typeof heading === "number" ? wrapHeading(heading) : heading,
        mode
    });
    return pose.success ? pose.data : null;
}

/** What the call hands the frame: everybody else in the game, where they are. */
export interface FramePlayer extends Pose {
    readonly id: string;
    readonly name: string;
}

/**
 * The other players to draw: those in the session, other than the reader, whose
 * last position is known. Names are cut to what the frame accepts.
 */
export function framePlayers(
    session: ActivitySession,
    self: string,
    poses: ReadonlyMap<string, Pose>,
    nameOf: (seat: string) => string
): FramePlayer[] {
    const players: FramePlayer[] = [];
    for (const seat of session.players) {
        if (seat === self) continue;
        const pose = poses.get(seat);
        if (!pose) continue;
        const name = (nameOf(seat).trim() || "?").slice(0, 64);
        players.push({ id: seat.slice(0, 128), name, ...pose });
    }
    return players;
}

/**
 * Whether a position from `seat` is passed on: only from somebody who is in the
 * same game as the reader, about that game, and no faster than the frame sends.
 * A browser in the call that is not playing, or that floods, is dropped.
 */
export function acceptPose(
    session: ActivitySession | null,
    self: string,
    seat: string,
    message: ActivityMessage,
    lastAt: number | undefined,
    now: number
): boolean {
    if (!session || seat === self) return false;
    if (!session.players.includes(self) || !session.players.includes(seat)) return false;
    if (message.game !== session.game) return false;
    return lastAt === undefined || now - lastAt >= POSE_EVERY_MS / 2;
}

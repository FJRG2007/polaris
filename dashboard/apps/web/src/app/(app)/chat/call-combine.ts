/**
 * Several people, one room, one microphone.
 *
 * Two laptops in the same meeting room, each signed in as its owner, is the
 * oldest way to ruin a call: every speaker feeds every microphone in the room,
 * the echo cancellers fight each other over a delay they were never built for,
 * and the people at the other end hear a howl. The usual answer is somebody
 * shouting "mute yourself" until it stops, which also mutes them for the rest of
 * the call - so they end up a face with no voice, sharing a laptop they are not
 * sitting at.
 *
 * Combining is that, done deliberately and reversibly. The devices in one room
 * form a group: **one of them carries the room** - its microphone hears
 * everybody sitting there, its speakers play the call out loud - and every other
 * device in the group goes quiet at both ends while keeping its own seat, its
 * own camera, its own name and its own chat.
 *
 * ## One attribute, said by the quiet one
 *
 * Everything about a group rides in a single participant attribute, and it is
 * written by the device going quiet rather than by the one carrying the room:
 * **a companion names the seat it is listening through.** The call server
 * already hands every browser everybody else's attributes, including to somebody
 * who joins halfway through, so there is no table, no migration and nothing for
 * an operator to switch on.
 *
 * Saying it from that end is what removes the whole class of problems the
 * obvious design has. Going quiet is a decision about your own microphone and
 * your own speakers, so it needs nobody's agreement and takes effect the instant
 * it is pressed. There is no group to create before anybody is in it, no
 * handshake to be half-finished when a browser reloads, and no way for two
 * devices in one room to both believe they are the live one - the live one is
 * whoever the quiet ones point at, and each of them points at exactly one seat.
 *
 * Asking somebody *else* to go quiet is the one thing that cannot work this way,
 * because it turns off their microphone. That is a request, it travels as a data
 * message, and it is worth nothing a moment later - see the schema at the bottom.
 *
 * ## Nobody is in charge
 *
 * The group has no authority in it, so every rule below is decided the same way
 * by every browser from facts they can all see. Two of them matter:
 *
 * - **A companion never carries a room.** Point at somebody who is themselves
 *   quiet and you would be listening through a device that is not listening; so
 *   a browser in that position follows the chain one hop and points where they
 *   point.
 * - **The room outlives the device carrying it.** Somebody closes their laptop
 *   and the devices left in that room are all silent, hearing nothing and heard
 *   by nobody, with nothing on screen that looks like it caused it. So when the
 *   named seat leaves the roster, the lowest remaining seat in that group becomes
 *   the live one and the others point at it. Every browser sorts the same list
 *   and reaches the same answer, with nothing to agree on.
 */

import { z } from "zod";

/**
 * The seat whose device carries the room this browser is sitting in.
 *
 * Written only by a device that has gone quiet. An empty value is how a browser
 * takes it back, because attributes are a bag of strings and there is no way to
 * remove a key.
 */
export const AUDIO_GROUP = "audioGroup";

/**
 * Which end of a group a device is.
 *
 * Derived rather than declared: `companion` is a browser that names somebody,
 * and `room` is a browser somebody names. Nothing writes this - it is what the
 * screens read.
 */
export type AudioRole = "room" | "companion";

/** Only what the rules below need of a participant, so they can be checked
 *  without a call server. */
export interface AudioGroupFacts {
    readonly id: string;
    /** The seat they are listening through, or null when they are an ordinary
     *  device with its own microphone and speakers. */
    readonly group: string | null;
}

/** What this browser should be doing about audio, worked out from what everybody
 *  in the call has said about themselves. */
export interface AudioPlan {
    /** The part it plays. Null when it is in no group, which is every ordinary
     *  call. */
    readonly role: AudioRole | null;
    /** The seat carrying the room, this browser's own when it is the live one.
     *  Null when there is no group. */
    readonly host: string | null;
    /** The other devices in the same room, by seat. */
    readonly members: readonly string[];
    /**
     * What this browser has to say about itself to be right, when what it is
     * currently saying is not.
     *
     * A seat to point at, an empty string to stop pointing at anybody, or null
     * when what it says already matches. Applied by the caller, because it is
     * the only thing here that writes.
     */
    readonly correcting: string | null;
}

/**
 * The part this browser should play, from the room as it currently is.
 *
 * Deterministic on purpose, and that is the whole design: nobody hands out
 * roles. Every browser looks at the same attributes, sorts by seat and reaches
 * the same answer, so there is no election, no message to lose, and nothing that
 * has to happen in a particular order.
 *
 * @param me - This browser's seat, and the seat it currently points at.
 * @param others - Everybody else in the call. Somebody who points at nobody is
 *   an ordinary device and only matters here as a possible host.
 */
export function audioPlan(me: AudioGroupFacts, others: readonly AudioGroupFacts[]): AudioPlan {
    if (!me.group) {
        const quiet = others.filter((person) => person.group === me.id).map((person) => person.id);
        return {
            role: quiet.length > 0 ? "room" : null,
            host: quiet.length > 0 ? me.id : null,
            members: quiet.sort(),
            correcting: null
        };
    }

    const host = others.find((person) => person.id === me.group) ?? null;

    // The device pointed at has left the call. Whoever is left in that room has
    // to carry it, and the lowest seat is an answer all of them reach alone.
    if (!host) {
        const left = [me.id, ...others.filter((p) => p.group === me.group).map((p) => p.id)].sort();
        const taking = left[0] ?? me.id;
        if (taking === me.id) {
            // The room is this browser's now, so it stops being quiet. Everybody
            // else in the group is about to point here.
            return { role: "room", host: me.id, members: left.slice(1), correcting: "" };
        }
        return {
            role: "companion",
            host: taking,
            members: left.filter((seat) => seat !== me.id),
            correcting: taking
        };
    }

    // Pointing at somebody who is themselves quiet: follow them one hop, which
    // is where the room actually is. Repeated hops settle it, because each one
    // lands nearer a device that points at nobody.
    if (host.group && host.group !== me.id) {
        return {
            role: "companion",
            host: host.group,
            members: [host.id],
            correcting: host.group
        };
    }

    const members = [
        host.id,
        ...others.filter((p) => p.group === me.group && p.id !== me.id).map((p) => p.id)
    ].sort();
    return { role: "companion", host: host.id, members, correcting: null };
}

/**
 * What one browser says to another about combining.
 *
 * Only the two things that cannot be read off an attribute. Asking somebody to
 * go quiet is addressed to one person and is worth nothing a moment later;
 * turning it down has to reach whoever is waiting for an answer, or their screen
 * sits on a question that has already been answered.
 *
 * Accepting says nothing here. It is the accepting browser pointing at the
 * asker, which everybody in the call sees anyway - a message would be a second,
 * less reliable copy of a fact already on the wire.
 */
export const combineMessageSchema = z.discriminatedUnion("kind", [
    /** "We are in the same room - go quiet and listen through me." */
    z.object({ kind: z.literal("combine-ask") }),
    z.object({ kind: z.literal("combine-no") })
]);

export type CombineMessage = z.infer<typeof combineMessageSchema>;

/** Somebody asking this browser to go quiet, while the question is open. */
export interface CombineRequest {
    /** Their seat, which is what an answer is addressed to and what their name
     *  is looked up by. */
    readonly from: string;
}

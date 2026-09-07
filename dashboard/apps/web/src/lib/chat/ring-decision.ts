/**
 * What a call frame means to a browser that is not in the call.
 *
 * Pulled out of the card because the card cannot be asked. Deciding whether a
 * telephone should still be ringing needs a live connection, a shared channel
 * between tabs, a claim across the device and permission to draw a notice, and
 * none of that can be set up to answer the one question that actually matters:
 * given this frame, does this browser go on ringing?
 *
 * Four answers, and the third is the one this was written for.
 */
export type RingDecision =
    /** Start ringing, or keep ringing: somebody is calling and it is not you. */
    | "ring"
    /**
     * You picked this up somewhere else.
     *
     * An account holds one seat in a call, so a call answered on a phone has
     * stopped being an incoming call on the desk - and a telephone that goes on
     * ringing in the next room after somebody answered it is the thing everybody
     * notices about a house that has more than one.
     *
     * There is no frame for "answered elsewhere" and there does not need to be:
     * joining a call is already announced, carrying who joined. If that is you,
     * you are in it, on some device, and this one is done.
     */
    | "settle"
    /** Nobody is left in it, or it is over. A card offering to join an empty
     *  room is worse than no card. */
    | "drop"
    /** Not about ringing at all. */
    | "ignore";

/** The part of a call frame this reads. Narrower than the frame on purpose: a
 *  decision that took the whole thing would be a decision nothing could call. */
export interface CallFrameFacts {
    readonly state: string;
    /** Who acted. Empty where the server had nobody to name - a call that ended
     *  on its own, a seat swept - which is why it is compared and never
     *  trusted to be somebody. */
    readonly userId: string;
    readonly count?: number;
}

/**
 * What has become of one room somebody was rung about.
 *
 * The decision above cannot answer this and is not meant to: it says whether to
 * go on ringing, and this says what the ringing turned out to be. They are read
 * together because a call that stops ringing is either a missed call or one
 * somebody else answered, and only the second is not owed a card.
 */
export interface RingRoom {
    /** How many were seated when it started ringing. The caller is already in
     *  the room by then, so this is the room with nobody having answered. */
    readonly ringing: number;
    /** Whether anybody walked in afterwards. */
    readonly answered: boolean;
}

/**
 * The room, after one frame.
 *
 * Undefined for a call this browser never heard ring - a frame about somebody
 * else's conversation, or one that arrived after the ringing was settled - which
 * is a call there is nothing to decide about.
 *
 * "Answered" is somebody other than the caller taking a seat, which is exactly
 * the rule the server writes the conversation's line by (`whoMissedTheCall`).
 * Read off the count rather than the actor, because the actor of a frame is
 * whoever moved and an empty one is the server saying "this happened".
 */
export function roomAfter(held: RingRoom | undefined, frame: CallFrameFacts): RingRoom | undefined {
    if (frame.state === "ringing") return held ?? { ringing: frame.count ?? 0, answered: false };
    if (!held || held.answered) return held;
    return (frame.count ?? 0) > held.ringing ? { ...held, answered: true } : held;
}

export function ringDecision(frame: CallFrameFacts, viewerId: string): RingDecision {
    if (frame.state === "ringing") {
        // Your own call. The frame is addressed to the conversation, and the
        // person who pressed the button is in it - so without this, starting a
        // call rang at the person starting it.
        return frame.userId === viewerId ? "ignore" : "ring";
    }
    if (frame.state === "ended" || frame.count === 0) return "drop";
    // An empty actor is the server saying "this happened", not "somebody did
    // it". It must never match a viewer.
    if (frame.userId !== "" && frame.userId === viewerId) return "settle";
    return "ignore";
}

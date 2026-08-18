/**
 * What a call announces to the browsers watching it.
 *
 * Not the media and not the negotiation - the call server carries both, and this
 * server is never in the path of either. What is left is the handful of facts
 * about the room itself that only Polaris knows: who is in it, when it ended,
 * and which device of an account is the one holding the seat.
 *
 * In memory, and deliberately. Each of these is worth something for the instant
 * it is published and nothing afterwards, so a table of them would be written
 * constantly and read once; losing the lot on a restart costs a browser one
 * refresh of a roster it re-reads anyway. It follows that this only works within
 * the process serving the streams, which is the constraint every other live
 * feature here already has.
 */

/** Something about the call itself, sent to everybody in it. */
export interface MeetingEvent {
    readonly meetingId: string;
    /** roster - somebody joined, left, or was admitted; ended - it is over;
     *  claimed - a device took the call over, and every other one of that
     *  account's browsers is now out of it. */
    readonly kind: "roster" | "ended" | "claimed";
    /**
     * Which browser took it, for `claimed`.
     *
     * An account has one seat in a call - a second device rejoining reuses the
     * same participant row, because a person is one person in a room - so two
     * browsers of the same account are not two participants, they are two
     * claims on one place. Nothing said which of them was live, so both went on
     * holding a microphone and the older one had no way to find out it had been
     * replaced.
     *
     * This is what says so. It is a value a browser made up for itself, and it
     * is compared rather than trusted: a browser that does not recognise it is a
     * browser that is no longer the one on the call.
     */
    readonly deviceId?: string;
    /**
     * Whose seat was claimed, for `claimed`.
     *
     * Without it a claim is a sentence with no subject, and every browser in the
     * call read it as being about itself: one person joining announced a device
     * nobody else recognised, so everybody else hung up. Two people could not be
     * on a call at all - whoever arrived second knocked the first one out, and
     * then the first one's rejoin knocked out the second.
     *
     * A claim is about one seat. This is that seat, and it is what lets a stream
     * decide whether the claim is any of its business before the browser at the
     * other end ever sees it.
     */
    readonly participantId?: string;
}

type EventListener = (event: MeetingEvent) => void;

const REGISTRY = Symbol.for("polaris.chat.meeting-events");

interface Registry {
    events: Set<EventListener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    holder[REGISTRY] ??= { events: new Set() };
    return holder[REGISTRY];
}

export function publishMeetingEvent(event: MeetingEvent): void {
    for (const listener of registry().events) {
        try {
            listener(event);
        } catch (caught) {
            console.error(caught);
        }
    }
}

export function subscribeMeetingEvents(listener: EventListener): () => void {
    const { events } = registry();
    events.add(listener);
    return () => events.delete(listener);
}

/**
 * Introducing two browsers to each other.
 *
 * WebRTC needs a way for two peers to swap a handful of small messages before
 * they can talk directly: what codecs each speaks, and what addresses each can
 * be reached on. After that the connection is theirs and this server is out of
 * it entirely. This module is that handful of messages, and nothing else.
 *
 * In memory, and deliberately. A signal is worth something for the second or two
 * either side of a connection being set up and is worthless afterwards, so a
 * table of them would be written constantly and read once. Losing the lot - on a
 * restart, say - costs a call its renegotiation, which the browsers recover from
 * by trying again. It follows that this only works within the process that
 * serves both peers' streams, which is the same constraint every other live
 * feature here already has.
 *
 * Nothing in a signal is trusted, and nothing needs to be: it is opaque to this
 * server, addressed by participant id, and the routes on either side check that
 * the sender and the recipient are in the same call before it moves. What it is
 * NOT is a general message channel between two browsers - the payload is capped,
 * so somebody who tried to use it as one runs out of room rather than out of
 * memory.
 */

/** A message between two participants of one call. */
export interface MeetingSignal {
    readonly meetingId: string;
    /** The participant row it came from, and the one it is for. */
    readonly fromId: string;
    readonly toId: string;
    /** Opaque to this server: an offer, an answer, or an ICE candidate. */
    readonly payload: string;
}

/** Something about the call itself, sent to everybody in it. */
export interface MeetingEvent {
    readonly meetingId: string;
    /** roster - somebody joined, left, or was admitted; ended - it is over. */
    readonly kind: "roster" | "ended";
}

type SignalListener = (signal: MeetingSignal) => void;
type EventListener = (event: MeetingEvent) => void;

/** As big as one SDP offer with candidates in it needs to be, and no bigger. */
export const MAX_SIGNAL_BYTES = 16_384;

const REGISTRY = Symbol.for("polaris.chat.meeting-signal");

interface Registry {
    signals: Set<SignalListener>;
    events: Set<EventListener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    if (!holder[REGISTRY]) holder[REGISTRY] = { signals: new Set(), events: new Set() };
    return holder[REGISTRY];
}

export function publishSignal(signal: MeetingSignal): void {
    for (const listener of registry().signals) {
        try {
            listener(signal);
        } catch (caught) {
            console.error(caught);
        }
    }
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

export function subscribeSignals(listener: SignalListener): () => void {
    const { signals } = registry();
    signals.add(listener);
    return () => signals.delete(listener);
}

export function subscribeMeetingEvents(listener: EventListener): () => void {
    const { events } = registry();
    events.add(listener);
    return () => events.delete(listener);
}

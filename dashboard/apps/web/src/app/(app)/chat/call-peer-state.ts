/**
 * Reading somebody else's controls off what the call server knows about them.
 *
 * Two facts, and they reach a browser by different roads.
 *
 * Deafening is invisible in what somebody sends - they publish exactly the same
 * audio either way - so it has always ridden in a participant attribute, the one
 * small key-value bag the server keeps per person and hands to everybody.
 *
 * Muting looked like the easy one, because the server does know it: a publication
 * is muted or it is not. What it does not do is tell a browser that was not there
 * when it changed. Somebody who walks into a call muted publishes first and mutes
 * a moment after, and that mute rides on the signalling of a publication that
 * already existed - so the people in the room hear about it and everybody who
 * arrives later is handed a track whose muted flag was settled at publish, which
 * said nothing of the kind. Join a call muted, have somebody join after you, and
 * they see you unmuted for the rest of the call with nothing to press to find out
 * otherwise.
 *
 * So it is said out loud as well, and the spoken answer wins. The publication is
 * still read underneath, for a browser in the room that predates this and never
 * says anything.
 *
 * Its own module because it is the whole of a bug that could only be reproduced
 * with two people, two browsers and a call server - and none of that is needed to
 * check the rule.
 */

import type { PeerState } from "./call-state";

/** The keys a browser writes about itself. */
export const MUTED = "muted";
export const DEAFENED = "deafened";

/** Only what this needs of a remote participant, so it can be checked without
 *  one. */
export interface PeerFacts {
    readonly attributes?: Record<string, string> | undefined;
    /** The publication's own flag, as the client works it out. A participant
     *  with no microphone published at all reads as muted, which is right. */
    readonly isMicrophoneEnabled: boolean;
}

export function peerState(participant: PeerFacts): PeerState {
    const said = participant.attributes?.[MUTED];
    return {
        // Their own word first, because it is the only one that survives being
        // said before this browser arrived.
        muted: said ? said === "1" : !participant.isMicrophoneEnabled,
        deafened: participant.attributes?.[DEAFENED] === "1"
    };
}

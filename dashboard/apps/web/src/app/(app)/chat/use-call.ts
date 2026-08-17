"use client";

/**
 * A call, in the browser - whichever way this instance carries one.
 *
 * There are two, and the difference is where the media goes:
 *
 * - **Through a call server** (`use-sfu-call`), when an administrator has set
 *   one up. One connection per browser, one upload of each camera, and a public
 *   address in the middle that two people on different networks can both reach.
 *   This is how a call should work, and it is what the whole rest of the world
 *   does.
 * - **Browser to browser** (`use-mesh-call`), when there is not one. Nothing to
 *   install and nothing to run, at the cost of a connection per pair and no way
 *   to get out of a network without a STUN or TURN server. Fine for two people
 *   in one house, which is a real Polaris.
 *
 * The screens above never learn which. Both hooks answer to `CallState`, so the
 * grid, the audio, the controls and the guest page are one implementation.
 *
 * Both are called on every render, because hooks are: the one not in use is
 * handed no meeting, and a hook with no meeting opens nothing, connects to
 * nothing and beats for nothing. That is cheaper than it looks and it is the
 * only arrangement React permits.
 */

import { useEffect, useState } from "react";
import { useSfuCall } from "./use-sfu-call";
import { useMeshCall } from "./use-mesh-call";
import type { CallState } from "./call-state";
import { callTransportAction } from "./meeting-actions";

export type { CallDevice, CallState, PeerState } from "./call-state";

/**
 * @param meetingId - The call to be in, or null for none. Null is what lets this
 *   live above the screen that shows a call: the provider holds one of these for
 *   the whole dashboard, and a browser that is not in a call is a browser where
 *   nothing here opens, connects or beats.
 */
export function useCall(meetingId: string | null, options?: { video?: boolean }): CallState {
    // Nothing is opened until the answer is in. It is one request against
    // configuration the server already has in hand, and the alternative -
    // guessing, then switching - is a call that asks for the microphone twice.
    const [carriedBy, setCarriedBy] = useState<"asking" | "sfu" | "mesh">("asking");

    useEffect(() => {
        if (!meetingId) {
            setCarriedBy("asking");
            return;
        }
        let stopped = false;
        void callTransportAction(meetingId)
            // A question that could not be asked is answered the way an instance
            // with no call server is: the mesh needs nothing to be running.
            .catch((): "mesh" => "mesh")
            .then((answer) => {
                if (!stopped) setCarriedBy(answer);
            });
        return () => {
            stopped = true;
        };
    }, [meetingId]);

    const throughServer = useSfuCall(carriedBy === "sfu" ? meetingId : null, options);
    const direct = useMeshCall(carriedBy === "mesh" ? meetingId : null, options);
    return carriedBy === "sfu" ? throughServer : direct;
}

"use client";

/**
 * The call this browser is in, as a thing to read.
 *
 * Split out from the provider that fills it in, and the split earns its keep in
 * one place: reading it costs nothing. The provider reaches the call server, the
 * microphone and the meeting actions behind it, and a screen that only wants to
 * ask "am I in this room" pulled every one of those in behind the question - a
 * message list that draws no call ended up importing the call stack, which is
 * both a bundle nobody asked for and a module graph that breaks the moment it is
 * rendered anywhere without a server around it.
 *
 * So the context, and the two hooks that read it, live here with no runtime
 * dependency of their own. `CallState` is a type, and types are gone by the time
 * anything runs.
 */

import { createContext, useContext } from "react";
import type { CallState } from "./call-state";

/** The call this browser is sitting in. */
export interface CallSession {
    readonly meetingId: string;
    /** The conversation it belongs to, which is the screen that draws it in
     *  full and the place the bar leads back to. */
    readonly channelId: string;
    /** What to call it in the bar, since the bar is drawn where there is no
     *  conversation header to read it off. */
    readonly title: string;
    /**
     * Where the bar leads back to, when that is not a conversation.
     *
     * A meeting is a room of its own: it has no channel, so the conversation the
     * bar would otherwise point at does not exist. Left out, it is the
     * conversation, which is every call started from one.
     */
    readonly href?: string;
}

export interface CallHold {
    readonly call: CallState;
    readonly session: CallSession | null;
    readonly viewerId: string;
    /** Step into a call. Replaces whatever this browser was in - one call at a
     *  time, the way a telephone works. */
    readonly enter: (session: CallSession, withVideo: boolean) => void;
    readonly leave: () => void;
    readonly withVideo: boolean;
}

export const CallHoldContext = createContext<CallHold | null>(null);

export function useCallHold(): CallHold {
    const hold = useContext(CallHoldContext);
    if (!hold) throw new Error("A call needs the provider above it");
    return hold;
}

/**
 * The same thing, for a screen that may not be inside a provider.
 *
 * There is exactly one such screen - the guest page, which holds its own call
 * because there is no dashboard around it - and the difference matters for one
 * thing: who is responsible for noticing that the call ended. Inside the
 * dashboard that is the provider, wherever the reader happens to be standing; on
 * the guest page it is the room itself, because that is all there is.
 */
export function useHeldCall(): CallHold | null {
    return useContext(CallHoldContext);
}

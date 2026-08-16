"use client";

/**
 * The call you are in, wherever you are in Polaris.
 *
 * A call used to belong to the conversation's screen: leaving that screen tore
 * down the microphone, the connections and the room. Which is fine right up
 * until somebody has to look something up mid-call - a task, a deploy, the
 * thing they are talking about - and finds that the price of looking is hanging
 * up. Every messenger people already use keeps the call and shrinks it into a
 * bar; this is that.
 *
 * So the call lives here, above every screen, and the room is only a view onto
 * it. The conversation it belongs to draws it in full; everywhere else in the
 * dashboard gets the bar, which is the same call with fewer controls and a way
 * back.
 *
 * Nothing is opened for somebody who is not in a call: with no session,
 * `useCall` holds no microphone, opens no connection and beats no heart.
 */

import Link from "next/link";
import { CallAudio } from "./call-audio";
import { Button, cn } from "@polaris/ui";
import { useCall, type CallState } from "./use-call";
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** The call this browser is sitting in. */
export interface CallSession {
    readonly meetingId: string;
    /** The conversation it belongs to, which is the screen that draws it in
     *  full and the place the bar leads back to. */
    readonly channelId: string;
    /** What to call it in the bar, since the bar is drawn where there is no
     *  conversation header to read it off. */
    readonly title: string;
}

interface CallHold {
    readonly call: CallState;
    readonly session: CallSession | null;
    readonly viewerId: string;
    /** Step into a call. Replaces whatever this browser was in - one call at a
     *  time, the way a telephone works. */
    readonly enter: (session: CallSession, withVideo: boolean) => void;
    readonly leave: () => void;
    readonly withVideo: boolean;
}

const Context = createContext<CallHold | null>(null);

export function useCallHold(): CallHold {
    const hold = useContext(Context);
    if (!hold) throw new Error("A call needs the provider above it");
    return hold;
}

export function CallProvider({ viewerId, children }: { viewerId: string; children: ReactNode }) {
    const [session, setSession] = useState<CallSession | null>(null);
    const [withVideo, setWithVideo] = useState(false);
    const call = useCall(session?.meetingId ?? null, { video: withVideo });

    const enter = useCallback((next: CallSession, video: boolean) => {
        setWithVideo(video);
        setSession(next);
    }, []);

    const leave = useCallback(() => setSession(null), []);

    const hold = useMemo<CallHold>(
        () => ({ call, session, viewerId, enter, leave, withVideo }),
        [call, session, viewerId, enter, leave, withVideo]
    );

    return (
        <Context.Provider value={hold}>
            {/* Beside the call rather than beside the grid. This is what makes
                walking out of the conversation shrink a call instead of
                silencing it: the tiles unmount, the sound does not. */}
            <CallAudio call={call} />
            {children}
        </Context.Provider>
    );
}

/**
 * The call, made small.
 *
 * Drawn by the shell wherever the conversation itself is not on screen. It
 * carries the two controls somebody actually reaches for while doing something
 * else - the microphone and hanging up - and a way back to the room. Everything
 * finer is over there.
 */
export function CallBar({ channelId }: { channelId: string | null }) {
    const { call, session, leave } = useCallHold();
    if (!session || session.channelId === channelId) return null;

    const others = (call.meeting?.participants ?? []).filter(
        (person) => person.admission === "admitted" && person.id !== call.participantId
    );

    return (
        <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center px-2">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border-strong bg-elevated py-1 pl-3 pr-1.5 shadow-modal">
                <span
                    aria-hidden="true"
                    className={cn(
                        "size-2 shrink-0 rounded-full",
                        call.micOn ? "animate-pulse bg-success" : "bg-danger"
                    )}
                />
                <Link
                    href={`/chat/c/${session.channelId}`}
                    className="min-w-0 max-w-[12rem] truncate text-xs font-medium no-underline hover:underline"
                    title="Back to the call"
                >
                    {session.title}
                </Link>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                    {others.length + 1}
                </span>

                <button
                    type="button"
                    onClick={call.toggleMic}
                    aria-label={call.micOn ? "Mute" : "Unmute"}
                    title={call.micOn ? "Mute (F9)" : "Unmute (F9)"}
                    className={cn(
                        "rounded-full p-1.5 transition-colors hover:bg-muted",
                        call.micOn ? "text-foreground" : "text-danger"
                    )}
                >
                    {call.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                </button>
                <button
                    type="button"
                    onClick={call.toggleDeafen}
                    aria-label={call.deafened ? "Undeafen" : "Deafen"}
                    title={call.deafened ? "Undeafen (F10)" : "Deafen (F10)"}
                    className={cn(
                        "rounded-full p-1.5 transition-colors hover:bg-muted",
                        call.deafened ? "text-danger" : "text-foreground"
                    )}
                >
                    {call.deafened ? (
                        <HeadphoneOff className="size-4" />
                    ) : (
                        <Headphones className="size-4" />
                    )}
                </button>
                <Button size="icon" variant="danger" aria-label="Leave the call" onClick={leave}>
                    <PhoneOff className="size-4" />
                </Button>
            </div>
        </div>
    );
}

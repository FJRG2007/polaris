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
import { useChatStream } from "./use-chat-stream";
import { playCallSound } from "@/lib/call-sounds";
import { useCall, type CallState } from "./use-call";
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff } from "lucide-react";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode
} from "react";

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

/**
 * The same thing, for a screen that may not be inside a provider.
 *
 * There is exactly one such screen - the guest page, which holds its own call
 * because there is no dashboard around it - and the difference matters for one
 * thing: who is responsible for noticing that the call ended. Inside the
 * dashboard that is this provider, wherever the reader happens to be standing;
 * on the guest page it is the room itself, because that is all there is.
 */
export function useHeldCall(): CallHold | null {
    return useContext(Context);
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

    /**
     * The call ended, so this browser is no longer in one.
     *
     * The host closed it, the last other person left a one-to-one, or it was
     * swept for being abandoned. Whatever the reason, nothing was letting go of
     * the session: the bar went on floating over every screen in Polaris,
     * offering to mute and hang up a call that had been over for an hour, and it
     * only went away on a reload. Somebody standing in the conversation at least
     * got a panel to press; everybody else got a lie.
     *
     * Sounded here rather than by the room, and that is the point of doing it
     * here: the reader is usually looking at something else, which is the whole
     * reason a call survives navigation in the first place.
     */
    useEffect(() => {
        if (!session || !call.ended) return;
        playCallSound("hangUp");
        setSession(null);
    }, [call.ended, session]);

    /**
     * The call moved, so this browser moves with it.
     *
     * Somebody brought a third person into a one-to-one, which a direct message
     * cannot hold - it is keyed by the pair - so the call became a group. The
     * person who was on the line is told where it went rather than left in a
     * room that quietly empties around them.
     *
     * The new room is entered with the microphone and camera settings this
     * browser was already using: it is the same conversation to the person in
     * it, and turning somebody's camera on because their call moved would be a
     * surprise of the worst kind.
     */
    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "call" || !frame.movedTo) return;
                setSession((current) => {
                    if (!current || current.channelId !== frame.channelId) return current;
                    return {
                        meetingId: frame.movedTo!.meetingId,
                        channelId: frame.movedTo!.channelId,
                        title: current.title
                    };
                });
            },
            []
        )
    );

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

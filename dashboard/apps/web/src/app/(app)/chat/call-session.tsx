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
import { RecordingPanel } from "./recording-panel";
import { useCallRecorder } from "./call-recorder";
import { Button, cn } from "@polaris/ui";
import { useChatStream } from "./use-chat-stream";
import { usePresenceRefresh } from "@/components/presence-store";
import { playCallSound } from "@/lib/call-sounds";
import { useCall } from "./use-call";
import { takeRememberedCall } from "./call-resume";
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CallHoldContext, useCallHold, type CallHold, type CallSession } from "./call-hold";

// The context and the two hooks that read it live in `call-hold`, which has no
// runtime dependency of its own - see the note there. Passed on from here so
// every screen that already reads them goes on doing it from one place.
export { useCallHold, useHeldCall, type CallHold, type CallSession } from "./call-hold";

export function CallProvider({ viewerId, children }: { viewerId: string; children: ReactNode }) {
    const [session, setSession] = useState<CallSession | null>(null);
    const [withVideo, setWithVideo] = useState(false);
    const call = useCall(session?.meetingId ?? null, { video: withVideo });
    const recording = useCallRecorder(call);
    /** The recorder as it is now, for the callbacks that have to reach it
     *  without being rebuilt every time it counts a second. */
    const recorder = useRef(recording);
    recorder.current = recording;

    const enter = useCallback((next: CallSession, video: boolean) => {
        setWithVideo(video);
        setSession(next);
    }, []);

    /**
     * Leaving stops a recording rather than losing it.
     *
     * Everything the recording is being drawn from goes away with the call, so
     * what would carry on being written is a black rectangle and silence.
     * Stopping keeps what was made, and the panel that offers it is drawn from
     * here - which is why it survives the room unmounting.
     */
    const leave = useCallback(() => {
        if (recorder.current.running) recorder.current.stop();
        setSession(null);
    }, []);

    /**
     * Everybody's face, asked again, the moment this browser joins or leaves.
     *
     * The badge that says somebody is on a call is presence, and presence is
     * refreshed on a timer of its own - so hanging up left the reader looking at
     * their own face still marked as being in a call for the best part of a
     * minute. Nothing was wrong with it; it was simply the answer to a question
     * asked before they pressed the button, and a reload was the only thing that
     * looked like it fixed it.
     *
     * Both directions, on the meeting rather than on the session object: joining
     * puts the badge up and leaving takes it down, and they are the same event
     * seen from either end.
     */
    const refreshPresence = usePresenceRefresh();
    useEffect(() => {
        refreshPresence();
    }, [refreshPresence, session?.meetingId]);

    /**
     * The call this tab was on before it reloaded to pick up an update.
     *
     * Read once, on the way in, and removed as it is read. Only the update
     * banner ever leaves one - a reload somebody typed is a reload they meant,
     * and walking back into a call they had stepped away from would be a
     * microphone opening itself.
     *
     * Whether the room is still there is not asked: entering it answers that,
     * and a room that has since ended is a state the provider already knows how
     * to let go of.
     */
    useEffect(() => {
        const back = takeRememberedCall(viewerId);
        if (back) enter(back.session, back.video);
    }, [enter, viewerId]);

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
        useCallback((frame) => {
            if (frame.kind !== "call" || !frame.movedTo) return;
            setSession((current) => {
                if (!current || current.channelId !== frame.channelId) return current;
                return {
                    meetingId: frame.movedTo!.meetingId,
                    channelId: frame.movedTo!.channelId,
                    title: current.title
                };
            });
        }, [])
    );

    const hold = useMemo<CallHold>(
        () => ({ call, recording, session, viewerId, enter, leave, withVideo }),
        [call, recording, session, viewerId, enter, leave, withVideo]
    );

    return (
        <CallHoldContext.Provider value={hold}>
            {/* Beside the call rather than beside the grid. This is what makes
                walking out of the conversation shrink a call instead of
                silencing it: the tiles unmount, the sound does not. */}
            <CallAudio call={call} />
            {/* What was recorded, once it is stopped. Beside the call for the
                same reason the sound is: whoever pressed stop may be anywhere
                in Polaris by then, and a file that only appears on the screen
                the recording was started from is a file people lose. */}
            <RecordingPanel recording={recording} channelId={session?.channelId ?? ""} />
            {children}
        </CallHoldContext.Provider>
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
export function CallBar({ onScreen }: { onScreen: string | null }) {
    const { call, session, leave } = useCallHold();
    // The room this bar is about, wherever it is drawn in full: a conversation
    // for a call, the meeting itself for a meeting. Either way the bar is a way
    // back to a place the reader is already standing in, so it stays away.
    if (!session) return null;
    if (session.channelId === onScreen || session.meetingId === onScreen) return null;

    const others = (call.meeting?.participants ?? []).filter(
        (person) => person.admission === "admitted" && person.id !== call.participantId
    );
    /**
     * Whether anybody in the call is writing it down.
     *
     * Drawn here as well as in the room, and this is the copy that matters: a
     * call being recorded is exactly the thing somebody must not be able to
     * forget by walking to another screen.
     */
    const recorded =
        call.recording || [...call.states.values()].some((state) => state.recording);

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
                    href={session.href ?? `/chat/c/${session.channelId}`}
                    className="min-w-0 max-w-[12rem] truncate text-xs font-medium no-underline hover:underline"
                    title="Back to the call"
                >
                    {session.title}
                </Link>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                    {others.length + 1}
                </span>
                {recorded && (
                    <span
                        title="This call is being recorded"
                        className="flex shrink-0 items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-danger"
                    >
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />
                        Rec
                    </span>
                )}

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

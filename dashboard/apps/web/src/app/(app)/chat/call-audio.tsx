"use client";

/**
 * The sound of a call, played wherever you are.
 *
 * It used to come out of the tiles: each one held a `<video>`, and that element
 * was what played the other person's voice. Which works exactly as long as the
 * tiles are on screen - and the whole point of a call that survives navigation
 * is that they are not. Walking out of the conversation unmounted the grid, took
 * every audio element with it, and left somebody sitting in a call watching the
 * other person's ring light up green with no idea why they could not hear a
 * word. The connection was fine. There was simply nothing playing it.
 *
 * So sound is separated from picture. The grid draws faces and screens; this
 * plays the room, and it is mounted beside the call itself rather than beside
 * any screen. A guest, who has no dashboard around them, mounts it themselves.
 *
 * Volume is per person and per browser, deafening is one switch over all of it,
 * and both are applied where the sound is played rather than to the connections -
 * the audio still arrives and is simply not played, so both are instant and
 * nobody is renegotiated at.
 *
 * Anybody turned up past how they were sent is played through Web Audio instead
 * of by the element, because an element's volume stops at 1 - see `call-boost`.
 */

import { Volume2 } from "lucide-react";
import type { CallState } from "./use-call";
import { useCallVolume } from "./call-volumes";
import { boostStream, resumeBoost, type Boost } from "./call-boost";
import { useCallback, useEffect, useRef, useState } from "react";

export function CallAudio({ call }: { call: CallState }) {
    // Who is blocked, rather than whether anybody is: a browser can refuse one
    // element and allow the next, and the prompt has to go away when the last
    // one starts rather than when the first does.
    const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
    const unblock = useRef(new Map<string, () => void>());

    const report = useCallback((id: string, refused: boolean, press: () => void) => {
        unblock.current.set(id, press);
        setBlocked((current) => {
            if (current.has(id) === refused) return current;
            const next = new Set(current);
            if (refused) next.add(id);
            else next.delete(id);
            return next;
        });
    }, []);

    const others = (call.meeting?.participants ?? []).filter(
        (person) => person.admission === "admitted" && person.id !== call.participantId
    );

    /**
     * Forget whoever is no longer here.
     *
     * A refusal was recorded per person and never taken back. Their element
     * unmounts when they leave, which stops the sound but says nothing to this,
     * so the id sat in the set forever - and since the prompt is drawn whenever
     * the set is not empty, "Press to hear the call" went on floating over the
     * whole dashboard after the person had left and after the call itself had
     * ended, offering to start audio for a room that was not there. A reload was
     * the only thing that cleared it.
     *
     * Keyed by the ids rather than the array: the roster is rebuilt on every
     * refresh, and depending on the array itself would run this on each one.
     */
    const present = others.map((person) => person.id).join(" ");
    useEffect(() => {
        const here = new Set(present ? present.split(" ") : []);
        for (const id of unblock.current.keys()) {
            if (!here.has(id)) unblock.current.delete(id);
        }
        setBlocked((current) => {
            const stale = [...current].filter((id) => !here.has(id));
            if (stale.length === 0) return current;
            return new Set([...current].filter((id) => here.has(id)));
        });
    }, [present]);

    return (
        <>
            {others.map((person) => (
                <RemoteAudio
                    key={person.id}
                    id={person.id}
                    stream={call.remote.get(person.id) ?? null}
                    // Their account where they have one, so turning somebody
                    // down holds across calls; their seat where they do not,
                    // which lasts as long as the seat.
                    volumeKey={person.userId ?? person.id}
                    muted={call.deafened}
                    onPlayState={report}
                />
            ))}

            {/* A browser is entitled to refuse to start audio, and it refuses
                silently. A press is all it wants, so this asks for one - once
                for the room, wherever in Polaris the reader happens to be. */}
            {blocked.size > 0 && !call.deafened && (
                <div className="pointer-events-none fixed inset-x-0 top-14 z-50 flex justify-center px-2">
                    <button
                        type="button"
                        onClick={() => {
                            // The same press does both: an element the browser
                            // refused to start, and the context it started
                            // suspended for whoever is boosted.
                            resumeBoost();
                            for (const press of unblock.current.values()) press();
                        }}
                        className="pointer-events-auto flex items-center gap-2 rounded-full border border-border-strong bg-elevated px-3 py-1.5 text-xs font-medium shadow-modal"
                    >
                        <Volume2 className="size-4 shrink-0" />
                        Press to hear the call
                    </button>
                </div>
            )}
        </>
    );
}

function RemoteAudio({
    id,
    stream,
    volumeKey,
    muted,
    onPlayState
}: {
    id: string;
    stream: MediaStream | null;
    volumeKey: string;
    muted: boolean;
    onPlayState: (id: string, blocked: boolean, press: () => void) => void;
}) {
    const element = useRef<HTMLAudioElement>(null);
    const [volume] = useCallVolume(volumeKey);
    /** The graph playing this person, while they are turned up past 1. */
    const boost = useRef<Boost | null>(null);
    /** Whether this person is boosted at all, which decides which of the two
     *  things plays them. State rather than a ref: it is read while rendering
     *  the element that must fall silent when the graph takes over. */
    const [boosted, setBoosted] = useState(false);

    const start = useCallback(() => {
        const audio = element.current;
        if (!audio) return;
        resumeBoost();
        void audio
            .play()
            .then(() => onPlayState(id, false, start))
            .catch(() => onPlayState(id, true, start));
    }, [id, onPlayState]);

    useEffect(() => {
        const audio = element.current;
        if (!audio || !stream) return;
        audio.srcObject = stream;
        start();
    }, [stream, start]);

    /**
     * Who plays this person: the element, or the graph.
     *
     * Anything up to 1 is the element's own volume, which costs nothing and is
     * what almost every call uses. Past it the element cannot go, so the graph
     * is built and the element is silenced - but kept attached, because in
     * Chrome a WebRTC stream is not processed by Web Audio at all unless a media
     * element is holding it.
     *
     * Deafening silences both: muting the element says nothing to a graph
     * running beside it, so a deafened reader would have gone on hearing exactly
     * the people they had turned up.
     */
    const wanted = muted ? 0 : volume;
    /** Which stream the graph was built over, so a republished microphone is
     *  rebuilt rather than turned up while it plays the track before it. */
    const built = useRef<MediaStream | null>(null);
    useEffect(() => {
        if (!stream || wanted <= 1) {
            boost.current?.stop();
            boost.current = null;
            built.current = null;
            setBoosted(false);
            return;
        }
        if (built.current !== stream) {
            boost.current?.stop();
            boost.current = boostStream(stream, wanted);
            built.current = boost.current ? stream : null;
        } else boost.current?.set(wanted);
        setBoosted(boost.current !== null);
    }, [stream, wanted]);

    // Let go of the graph with the component. Left running, it goes on playing
    // somebody who has left the call.
    useEffect(
        () => () => {
            boost.current?.stop();
            boost.current = null;
            built.current = null;
        },
        []
    );

    useEffect(() => {
        // Never both at once: whichever is not playing is at zero rather than
        // merely quiet, or a boosted voice arrives twice.
        if (element.current) element.current.volume = boosted ? 0 : Math.min(1, volume);
    }, [boosted, volume, stream]);

    // Never drawn. It is an element because that is what plays a stream - and,
    // for a boosted one, because that is what keeps the stream flowing into the
    // graph that plays it.
    return <audio ref={element} autoPlay playsInline muted={muted} className="hidden" />;
}

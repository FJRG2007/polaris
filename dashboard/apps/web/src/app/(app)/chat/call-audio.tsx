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
 *
 * The room can also duck while this browser is talking. A page cannot quieten
 * the machine's other applications the way a desktop client does - nothing in a
 * browser reaches them - so what this turns down is Polaris's own sound, which
 * is the half that matters when somebody is on speakers: the room coming back at
 * you while you speak is what an echo canceller spends its life fighting.
 */

import { Volume2 } from "lucide-react";
import type { CallState } from "./use-call";
import { useCallVolume } from "./call-volumes";
import { useVoiceSettings } from "./voice-settings";
import { useCallback, useEffect, useRef, useState } from "react";
import { boostStream, resumeBoost, type Boost } from "./call-boost";
import { playThroughChosenSpeaker, SPEAKER_CHANGED } from "./speaker-device";
import {
    closePopOut,
    poppedStream,
    setWatchedStreams,
    streamVolumeKey,
    useStreamMuted,
    useWatchedStreams,
    voiceScale
} from "./call-stream-audio";

export function CallAudio({ call }: { call: CallState }) {
    /**
     * Whether this browser plays the call at all.
     *
     * Two ways to arrive at silence and they are different decisions. Deafening
     * is somebody switching the room off; being quiet for a group is this device
     * standing next to the one that is already playing the room out loud - see
     * `call-combine`. Both mean nothing comes out of these speakers, and the
     * second is the whole point of combining: two laptops playing the same voice
     * a fraction of a second apart is the echo people join a room to escape.
     */
    const silent = call.deafened || call.audioRole === "companion";
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
     * How much of the room is played while this browser is talking.
     *
     * One for everybody unless the reader asked for ducking, and then whatever
     * they set while their own seat is in the speaking set. Worked out here
     * rather than per person: it is one fact about this browser, and asking it
     * once is what keeps eight people from being turned down at eight different
     * moments.
     */
    const [voice] = useVoiceSettings();
    const ducking =
        voice.attenuate && call.participantId !== null && call.speaking.has(call.participantId);

    /**
     * The screens whose sound plays here: the ones being watched, on the stage
     * or popped out, that carry any. A share nobody opened stays silent.
     */
    const watching = useWatchedStreams();
    const streams = others.filter((person) => {
        const stream = call.screens.get(person.id);
        return (
            stream !== undefined &&
            stream.getAudioTracks().length > 0 &&
            watching.includes(`screen:${person.id}`)
        );
    });
    /** Which of those can actually be heard, so voices are lowered only while
     *  a stream really plays - see `voiceScale`. */
    const [audible, setAudible] = useState<ReadonlySet<string>>(new Set());
    const hear = useCallback((id: string, on: boolean) => {
        setAudible((current) => {
            if (current.has(id) === on) return current;
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
    }, []);
    const streamPlaying = !silent && streams.some((person) => audible.has(person.id));
    const scale = voiceScale({
        ducking: ducking ? voice.attenuation : 0,
        streamPlaying,
        streamAttenuation: voice.streamAttenuation
    });

    // A floating window for a share that has ended would be a black rectangle
    // on top of everything, and one outliving the call is worse.
    const sharedKeys = [...call.screens.keys()].map((id) => `screen:${id}`).join(" ");
    useEffect(() => {
        const key = poppedStream();
        if (key && !sharedKeys.split(" ").includes(key)) closePopOut();
    }, [sharedKeys]);
    useEffect(
        () => () => {
            closePopOut();
            setWatchedStreams([]);
        },
        []
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
    const present = [
        ...others.map((person) => person.id),
        ...streams.map((person) => `stream:${person.id}`)
    ].join(" ");
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
                    // Or they are the one who is deafened: nobody hears somebody
                    // who has switched the room off, whatever their own browser
                    // is still sending.
                    muted={silent || call.states.get(person.id)?.deafened === true}
                    scale={scale}
                    onPlayState={report}
                />
            ))}

            {streams.map((person) => (
                <StreamAudio
                    key={`stream:${person.id}`}
                    id={person.id}
                    stream={call.screens.get(person.id) ?? null}
                    person={person.userId ?? person.id}
                    silent={silent}
                    onAudible={hear}
                    onPlayState={report}
                />
            ))}

            {/* A browser is entitled to refuse to start audio, and it refuses
                silently. A press is all it wants, so this asks for one - once
                for the room, wherever in Polaris the reader happens to be. */}
            {blocked.size > 0 && !silent && (
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

/**
 * Whether the pass that reads this browser's own settings has been and gone.
 *
 * Volumes, and a stream's mute, are read out of local storage after mount
 * rather than during the render: the server has no storage, and a value that
 * differed between the two would fail hydration. Which leaves one pass in which
 * the defaults are in force - audible, and as loud as sent - and a source
 * attached during that pass is a stream somebody had muted, or turned all the
 * way down, playing at full volume for a frame. On a voice that is a syllable;
 * on a film or a game it is a burst of sound out of a page that was supposed to
 * be silent, and everybody's voices duck under it while it lasts.
 *
 * Every reader of those stores does its reading in a mount effect and this is
 * set in one too, so by the time it is true all of them have run: whatever is
 * held about this sound is in hand before anything is played.
 */
function useSettled(): boolean {
    const [settled, setSettled] = useState(false);
    useEffect(() => setSettled(true), []);
    return settled;
}

/**
 * One watched stream's sound, at the volume and mute this reader chose for that
 * sharer's streams.
 */
function StreamAudio({
    id,
    stream,
    person,
    silent,
    onAudible,
    onPlayState
}: {
    id: string;
    stream: MediaStream | null;
    /** Their account where they have one, their seat where they do not. */
    person: string;
    silent: boolean;
    onAudible: (id: string, audible: boolean) => void;
    onPlayState: (id: string, blocked: boolean, press: () => void) => void;
}) {
    const volumeKey = streamVolumeKey(person);
    const [muted] = useStreamMuted(person);
    const [volume] = useCallVolume(volumeKey);
    // Not before the mute and the volume have been read: a stream reported as
    // heard on the strength of the defaults lowers everybody's voices for a
    // pass, for a sound that has not started and may be muted - see
    // `useSettled`.
    const audible = useSettled() && !muted && volume > 0;
    useEffect(() => {
        onAudible(id, audible);
        return () => onAudible(id, false);
    }, [audible, id, onAudible]);

    return (
        <RemoteAudio
            id={`stream:${id}`}
            stream={stream}
            volumeKey={volumeKey}
            muted={silent || muted}
            scale={1}
            onPlayState={onPlayState}
        />
    );
}

function RemoteAudio({
    id,
    stream,
    volumeKey,
    muted,
    scale,
    onPlayState
}: {
    id: string;
    stream: MediaStream | null;
    volumeKey: string;
    muted: boolean;
    /** What the room is played at right now, as a multiple of what this person
     *  is set to: 1 normally, less while this browser is talking and ducking is
     *  on. A multiple rather than a second volume, so turning one person up
     *  still means turning them up. */
    scale: number;
    onPlayState: (id: string, blocked: boolean, press: () => void) => void;
}) {
    const element = useRef<HTMLAudioElement>(null);
    const [chosen] = useCallVolume(volumeKey);
    const volume = chosen * scale;
    // Nothing is attached, and so nothing plays, until what this browser
    // remembers about this sound has been read - see `useSettled`.
    const ready = useSettled();
    const playable = ready ? stream : null;
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
        // Wherever this browser was told to play. Asked on every start rather
        // than once, because an element gets a new source each time somebody
        // republishes and a device can be chosen mid-call.
        void playThroughChosenSpeaker(audio);
        // A source that is not there cannot be played, and asking anyway is what
        // records a refusal nothing can clear. An EMPTY stream counts as not
        // there: it is a truthy srcObject with no track in it, play() rejects
        // with NotSupportedError, and that reads exactly like a browser refusing
        // to start audio - which is how a participant who had published nothing
        // yet put the prompt on screen for a room that was working.
        // Asked of the object rather than through `instanceof MediaStream`: the
        // constructor is not defined everywhere this component is rendered, and a
        // reference error here would take the whole call screen down with it.
        const source = audio.srcObject as MediaStream | null;
        const tracks =
            typeof source?.getAudioTracks === "function" ? source.getAudioTracks() : null;
        if (!source || tracks?.length === 0) {
            onPlayState(id, false, start);
            return;
        }
        void audio
            .play()
            .then(() => onPlayState(id, false, start))
            .catch(() => onPlayState(id, true, start));
    }, [id, onPlayState]);

    // Before the source is attached rather than after it, so a source is never
    // started at a volume it is about to be moved off: within one pass the
    // effects run in the order they are written, and the one below calls play().
    useEffect(() => {
        // Never both at once: whichever is not playing is at zero rather than
        // merely quiet, or a boosted voice arrives twice.
        if (element.current) element.current.volume = boosted ? 0 : Math.min(1, volume);
    }, [boosted, volume, playable]);

    useEffect(() => {
        const audio = element.current;
        if (!audio) return;
        if (!playable) {
            // Nothing to play. Let go of whatever was attached and take back any
            // refusal recorded against this person - the prompt is drawn while
            // ANYBODY is refused, and a refusal left behind for a stream that no
            // longer exists is a prompt that stays on screen and cannot be
            // satisfied: pressing it calls play() on an element with no source,
            // which fails again, silently, for ever. That is the "it does
            // nothing" people were reporting.
            audio.srcObject = null;
            onPlayState(id, false, start);
            return;
        }
        audio.srcObject = playable;
        start();
    }, [id, playable, start, onPlayState]);

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
        if (!playable || wanted <= 1) {
            boost.current?.stop();
            boost.current = null;
            built.current = null;
            setBoosted(false);
            return;
        }
        if (built.current !== playable) {
            boost.current?.stop();
            boost.current = boostStream(playable, wanted);
            built.current = boost.current ? playable : null;
        } else boost.current?.set(wanted);
        setBoosted(boost.current !== null);
    }, [playable, wanted]);

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

    // A different output picked mid-call moves everybody who is already playing,
    // rather than only whoever speaks next.
    useEffect(() => {
        const follow = () => void playThroughChosenSpeaker(element.current);
        window.addEventListener(SPEAKER_CHANGED, follow);
        return () => window.removeEventListener(SPEAKER_CHANGED, follow);
    }, []);

    // Never drawn. It is an element because that is what plays a stream - and,
    // for a boosted one, because that is what keeps the stream flowing into the
    // graph that plays it. Silent until the stored mute has been read, so the
    // first pass cannot start one that was meant to stay quiet.
    return <audio ref={element} autoPlay playsInline muted={muted || !ready} className="hidden" />;
}

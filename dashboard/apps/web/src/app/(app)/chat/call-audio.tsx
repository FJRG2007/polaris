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
 * and both are applied to the elements rather than to the connections - the
 * audio still arrives and is simply not played, so both are instant and nobody
 * is renegotiated at.
 */

import { Volume2 } from "lucide-react";
import type { CallState } from "./use-call";
import { useCallVolume } from "./call-volumes";
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

    const start = useCallback(() => {
        const audio = element.current;
        if (!audio) return;
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

    useEffect(() => {
        if (element.current) element.current.volume = volume;
    }, [volume, stream]);

    // Never drawn. It is an element because that is what plays a stream, not
    // because there is anything to look at.
    return <audio ref={element} autoPlay playsInline muted={muted} className="hidden" />;
}

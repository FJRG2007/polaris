"use client";

/**
 * The call itself, on screen.
 *
 * One component for both ways in - the tab of somebody signed in, and the page a
 * guest reached on a link - because a call looks the same from both chairs and
 * two copies of a video grid is two places for the camera light to stay on.
 * What differs is what surrounds it, which is the caller's problem.
 *
 * The grid is columns rather than a layout engine: with eight people at the very
 * most, the number of columns is a lookup, and a measured layout would be
 * cleverness paid for on every frame of every call.
 */

import { useCall } from "./use-call";
import { Button, cn } from "@polaris/ui";
import * as actions from "./meeting-actions";
import { useEffect, useRef, useState } from "react";
import { Check, Link2, Mic, MicOff, PhoneOff, Video, VideoOff, X } from "lucide-react";

export function CallRoom({
    meetingId,
    onLeave,
    /** Shown to whoever started the call: the link for people with no account. */
    canShare = false
}: {
    meetingId: string;
    onLeave: () => void;
    canShare?: boolean;
}) {
    const call = useCall(meetingId);
    const [guestLink, setGuestLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const admitted = call.meeting?.participants.filter(
        (person) => person.admission === "admitted"
    );
    const waiting = call.meeting?.participants.filter((person) => person.admission === "waiting");
    const columns = gridColumns((admitted?.length ?? 1) || 1);

    useEffect(() => {
        if (!call.meeting?.guestToken) return;
        setGuestLink(`${window.location.origin}/m/${call.meeting.guestToken}`);
    }, [call.meeting?.guestToken]);

    if (call.ended) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
                <p className="text-sm text-muted-foreground">The call has ended.</p>
                <Button size="sm" onClick={onLeave}>
                    Close
                </Button>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            {call.error && (
                <p role="alert" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {call.error}
                </p>
            )}

            {waiting && waiting.length > 0 && (
                <ul className="flex flex-col gap-1">
                    {waiting.map((person) => (
                        <li
                            key={person.id}
                            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                        >
                            <span className="min-w-0 flex-1 truncate">
                                <span className="font-medium">{person.name}</span>
                                <span className="text-muted-foreground"> wants to join</span>
                            </span>
                            <button
                                type="button"
                                aria-label={`Let ${person.name} in`}
                                onClick={async () => {
                                    await actions.admitAction(meetingId, person.id, true);
                                    call.refresh();
                                }}
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Check className="size-4" />
                            </button>
                            <button
                                type="button"
                                aria-label={`Turn ${person.name} away`}
                                onClick={async () => {
                                    await actions.admitAction(meetingId, person.id, false);
                                    call.refresh();
                                }}
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                            >
                                <X className="size-4" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <div className={cn("grid min-h-0 flex-1 gap-2", columns)}>
                <Tile
                    stream={call.localStream}
                    name="You"
                    muted
                    cameraOff={!call.cameraOn}
                />
                {(admitted ?? [])
                    .filter((person) => person.id !== call.participantId)
                    .map((person) => (
                        <Tile
                            key={person.id}
                            stream={call.remote.get(person.id) ?? null}
                            name={person.name}
                            guest={person.guest}
                        />
                    ))}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                    size="sm"
                    variant={call.micOn ? "secondary" : "danger"}
                    onClick={call.toggleMic}
                    aria-pressed={!call.micOn}
                >
                    {call.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                    {call.micOn ? "Mute" : "Unmute"}
                </Button>
                <Button
                    size="sm"
                    variant={call.cameraOn ? "secondary" : "danger"}
                    onClick={call.toggleCamera}
                    aria-pressed={!call.cameraOn}
                >
                    {call.cameraOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}
                    {call.cameraOn ? "Stop video" : "Start video"}
                </Button>

                {canShare && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                            if (guestLink) {
                                await navigator.clipboard.writeText(guestLink).catch(() => undefined);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                                return;
                            }
                            const result = await actions.setGuestLinkAction(meetingId, true, true);
                            if (result.token) {
                                setGuestLink(`${window.location.origin}/m/${result.token}`);
                            }
                            call.refresh();
                        }}
                    >
                        <Link2 className="size-4" />
                        {guestLink ? (copied ? "Copied" : "Copy guest link") : "Invite by link"}
                    </Button>
                )}

                <Button size="sm" variant="danger" onClick={onLeave}>
                    <PhoneOff className="size-4" />
                    Leave
                </Button>
            </div>

            {canShare && guestLink && (
                <p className="text-center text-xs text-muted-foreground">
                    Anybody with this link can ask to join, and waits until somebody here lets them
                    in. It stops working when the call ends.
                </p>
            )}
        </div>
    );
}

function Tile({
    stream,
    name,
    muted = false,
    guest = false,
    cameraOff = false
}: {
    stream: MediaStream | null;
    name: string;
    /** Own video only. Playing your own microphone back is an echo. */
    muted?: boolean;
    guest?: boolean;
    cameraOff?: boolean;
}) {
    const video = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        if (video.current && stream) video.current.srcObject = stream;
    }, [stream]);

    return (
        <div className="relative min-h-0 overflow-hidden rounded-lg bg-elevated ring-1 ring-border">
            <video
                ref={video}
                autoPlay
                playsInline
                muted={muted}
                className={cn("size-full object-cover", cameraOff && "invisible")}
            />
            {(!stream || cameraOff) && (
                <span className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                    {name}
                </span>
            )}
            <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[11px]">
                {name}
                {guest && <span className="text-muted-foreground">guest</span>}
            </span>
        </div>
    );
}

/** Enough columns to keep the tiles roughly square at every size a mesh call can
 *  reach. A lookup rather than a measurement: the room is capped at eight. */
function gridColumns(people: number): string {
    if (people <= 1) return "grid-cols-1";
    if (people <= 4) return "grid-cols-2";
    if (people <= 6) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}

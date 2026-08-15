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
 *
 * The control bar is the set everybody already knows: microphone, camera,
 * screen, and deafen. Each button carries the state it is in rather than the
 * action it performs, because a row of buttons that all say what they will do
 * cannot be read at a glance to find out what is currently on.
 *
 * A tile is ringed while its owner is talking. With cameras off - which is most
 * calls - there is otherwise nothing at all to say who is speaking, because the
 * sound comes out of one pair of speakers whoever it belongs to.
 *
 * Right-clicking a tile turns that person up or down, for this pair of ears
 * only. It is applied to the audio element rather than to the connection, so it
 * is instant and nobody else is told.
 */

import { useCall } from "./use-call";
import * as actions from "./meeting-actions";
import { Avatar } from "@/components/avatar";
import { playCallSound } from "@/lib/call-sounds";
import { useEffect, useRef, useState } from "react";
import type { FilteredMic, MicFilter } from "./mic-filter";
import { DEFAULT_VOLUME, MAX_VOLUME, useCallVolume } from "./call-volumes";
import {
    Check,
    ChevronUp,
    Headphones,
    HeadphoneOff,
    Link2,
    Mic,
    MicOff,
    MonitorUp,
    MonitorX,
    PhoneOff,
    Video,
    VideoOff,
    Volume2,
    VolumeX,
    X
} from "lucide-react";
import {
    Button,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";

export function CallRoom({
    meetingId,
    onLeave,
    /** Whether this browser opened its camera on the way in. False for somebody
     *  who pressed the audio button, who can still turn it on from here. */
    withVideo = true,
    /** Whoever is watching, when they have an account. The guest link is the
     *  host's to open and nobody else's, so the control is drawn from who the
     *  call says its host is rather than from who opened this screen - offering
     *  a button that the server will refuse is worse than not offering it. */
    viewerId
}: {
    meetingId: string;
    onLeave: () => void;
    withVideo?: boolean;
    viewerId?: string;
}) {
    const call = useCall(meetingId, { video: withVideo });
    const [guestLink, setGuestLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [shareError, setShareError] = useState("");

    const canShare = Boolean(viewerId) && call.meeting?.hostId === viewerId;
    const admitted = call.meeting?.participants.filter((person) => person.admission === "admitted");
    // This browser's own seat, which is where its own face comes from: a guest
    // has no account to draw one from, and the signed-in id is not on the seat.
    const mine = admitted?.find((person) => person.id === call.participantId);
    const waiting = call.meeting?.participants.filter((person) => person.admission === "waiting");
    const columns = gridColumns((admitted?.length ?? 1) || 1);

    useEffect(() => {
        if (!call.meeting?.guestToken) return;
        setGuestLink(`${window.location.origin}/m/${call.meeting.guestToken}`);
    }, [call.meeting?.guestToken]);

    // The call ending under somebody - the host closing it, or the last other
    // person leaving a one-to-one - is the case that most needs a sound: the
    // screen they are looking at is not this one.
    const wasEnded = useRef(false);
    useEffect(() => {
        if (call.ended && !wasEnded.current) playCallSound("hangUp");
        wasEnded.current = call.ended;
    }, [call.ended]);

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
            {(call.error || shareError) && (
                <p
                    role="alert"
                    className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
                >
                    {call.error || shareError}
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
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
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
                    personId={mine?.userId ?? viewerId ?? null}
                    muted
                    speaking={
                        call.participantId !== null &&
                        call.speaking.has(call.participantId) &&
                        call.micOn
                    }
                    cameraOff={!call.cameraOn && !call.sharing}
                    sharing={call.sharing}
                />
                {(admitted ?? [])
                    .filter((person) => person.id !== call.participantId)
                    .map((person) => (
                        <Tile
                            key={person.id}
                            stream={call.remote.get(person.id) ?? null}
                            name={person.name}
                            personId={person.userId ?? null}
                            guest={person.guest}
                            speaking={call.speaking.has(person.id)}
                            // Their account where they have one, so turning
                            // somebody down holds across calls; their seat where
                            // they do not, which lasts as long as the seat.
                            volumeKey={person.userId ?? person.id}
                            // Deafening is done here rather than at the
                            // connection: the audio still arrives, it simply is
                            // not played, so undeafening is instant and nobody
                            // is renegotiated at.
                            muted={call.deafened}
                        />
                    ))}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
                <Split
                    label={call.micOn ? "Mute" : "Unmute"}
                    icon={call.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                    danger={!call.micOn}
                    onClick={call.toggleMic}
                    devices={call.microphones}
                    chosenId={call.microphoneId}
                    devicesLabel="Microphone"
                    onChoose={call.chooseMicrophone}
                    cleanMic={call.cleanMic}
                    onCleanMic={call.setCleanMic}
                    filterRunning={call.micFilter}
                    licensedOffered={call.licensedFilter}
                />

                <Split
                    label={call.cameraOn ? "Stop video" : "Start video"}
                    icon={
                        call.cameraOn ? (
                            <Video className="size-4" />
                        ) : (
                            <VideoOff className="size-4" />
                        )
                    }
                    danger={!call.cameraOn}
                    onClick={call.toggleCamera}
                    devices={call.cameras}
                    chosenId={call.cameraId}
                    devicesLabel="Camera"
                    onChoose={call.chooseCamera}
                />

                <Button
                    size="sm"
                    variant={call.sharing ? "primary" : "secondary"}
                    onClick={call.toggleShare}
                    aria-pressed={call.sharing}
                >
                    {call.sharing ? (
                        <MonitorX className="size-4" />
                    ) : (
                        <MonitorUp className="size-4" />
                    )}
                    {call.sharing ? "Stop sharing" : "Share screen"}
                </Button>

                <Button
                    size="sm"
                    variant={call.deafened ? "danger" : "secondary"}
                    onClick={call.toggleDeafen}
                    aria-pressed={call.deafened}
                    title={
                        call.deafened
                            ? "You cannot hear anybody, and nobody can hear you"
                            : "Silence everybody, and yourself with them"
                    }
                >
                    {call.deafened ? (
                        <HeadphoneOff className="size-4" />
                    ) : (
                        <Headphones className="size-4" />
                    )}
                    {call.deafened ? "Undeafen" : "Deafen"}
                </Button>

                {canShare && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                            if (guestLink) {
                                await navigator.clipboard
                                    .writeText(guestLink)
                                    .catch(() => undefined);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                                return;
                            }
                            const result = await actions.setGuestLinkAction(meetingId, true, true);
                            setShareError(result.error ?? "");
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

                <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                        playCallSound("hangUp");
                        onLeave();
                    }}
                >
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

/**
 * A control with the device picker attached to it.
 *
 * The button does the thing and the chevron beside it chooses which thing -
 * which is how every call client draws this, because "mute" and "use the other
 * microphone" are wanted at completely different moments and one menu holding
 * both makes the common one slower.
 */
function Split({
    label,
    icon,
    danger,
    onClick,
    devices,
    chosenId,
    devicesLabel,
    onChoose,
    cleanMic,
    onCleanMic,
    filterRunning,
    licensedOffered
}: {
    label: string;
    icon: React.ReactNode;
    danger: boolean;
    onClick: () => void;
    devices: readonly { id: string; label: string }[];
    chosenId: string | null;
    devicesLabel: string;
    onChoose: (deviceId: string) => void;
    /** Microphone only: how much is being done to what it hears. It belongs in
     *  this menu, beside the input it applies to, which is where every call
     *  client puts it. */
    cleanMic?: MicFilter;
    onCleanMic?: (level: MicFilter) => void;
    /** What is actually running, which is how somebody finds out their machine
     *  fell back to the lighter model rather than wondering. */
    filterRunning?: FilteredMic["using"] | null;
    /** Whether this instance has a licensed filter to offer. */
    licensedOffered?: boolean;
}) {
    // Worth a menu for the setting alone: a machine with one microphone still
    // sits in a room with a fan in it.
    const hasMenu = devices.length > 1 || onCleanMic !== undefined;

    return (
        <span className="flex items-center">
            <Button
                size="sm"
                variant={danger ? "danger" : "secondary"}
                onClick={onClick}
                aria-pressed={danger}
                className={hasMenu ? "rounded-r-none" : undefined}
            >
                {icon}
                {label}
            </Button>
            {hasMenu && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="sm"
                            variant={danger ? "danger" : "secondary"}
                            aria-label={`${devicesLabel} settings`}
                            className="rounded-l-none border-l border-border-strong px-1.5"
                        >
                            <ChevronUp className="size-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" side="top" className="max-w-72">
                        {onCleanMic && (
                            <>
                                <DropdownMenuLabel>Background noise</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {NOISE_LEVELS.filter(
                                    (level) => level.value !== "licensed" || licensedOffered
                                ).map((level) => (
                                    <DropdownMenuItem
                                        key={level.value}
                                        onSelect={() => onCleanMic(level.value)}
                                    >
                                        <Check
                                            className={cn(
                                                "size-3.5 shrink-0",
                                                cleanMic === level.value
                                                    ? "opacity-100"
                                                    : "opacity-0"
                                            )}
                                        />
                                        <span className="flex min-w-0 flex-col">
                                            <span>{level.label}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {level.help}
                                            </span>
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                                {/* Said only when it differs from what was asked
                                    for. A line confirming that the thing you
                                    chose is the thing running is noise. */}
                                {cleanMic === "enhanced" && filterRunning === "light" && (
                                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                                        This machine is running the lighter model.
                                    </p>
                                )}
                                {cleanMic === "licensed" && filterRunning !== "licensed" && (
                                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                                        The licensed filter did not start. Running the free one
                                        instead.
                                    </p>
                                )}
                            </>
                        )}
                        {devices.length > 1 && <DropdownMenuLabel>{devicesLabel}</DropdownMenuLabel>}
                        {devices.length > 1 && <DropdownMenuSeparator />}
                        {devices.map((device) => (
                            <DropdownMenuItem
                                key={device.id}
                                onSelect={() => onChoose(device.id)}
                            >
                                <Check
                                    className={cn(
                                        "size-3.5 shrink-0",
                                        device.id === chosenId ? "opacity-100" : "opacity-0"
                                    )}
                                />
                                <span className="truncate" title={device.label}>
                                    {device.label}
                                </span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </span>
    );
}

/** How big the face in an empty tile is. One size for every tile: a grid where
 *  the faces are different sizes reads as a mistake. */
const AVATAR_SIZE = 72;

/**
 * How much is done to the microphone, in the order somebody would consider it.
 *
 * Written as what each one does to the room rather than as what it is: nobody
 * choosing a microphone setting wants to be told the name of a model.
 */
const NOISE_LEVELS: readonly { value: MicFilter; label: string; help: string }[] = [
    {
        value: "enhanced",
        label: "Remove background noise",
        help: "Keeps your voice and takes out the rest - typing, a fan, a dog, somebody talking behind you. Costs a little battery."
    },
    {
        value: "standard",
        label: "Standard",
        help: "The browser's own echo and noise handling. Enough for a quiet room."
    },
    {
        value: "licensed",
        label: "Enhanced (licensed)",
        help: "The filter your administrator connected."
    },
    { value: "off", label: "Off", help: "Send exactly what the microphone hears." }
];

function Tile({
    stream,
    name,
    personId,
    muted = false,
    guest = false,
    cameraOff = false,
    sharing = false,
    speaking = false,
    volumeKey
}: {
    stream: MediaStream | null;
    name: string;
    /** Whose picture to draw while there is no video. Their account where they
     *  have one; a guest falls back to initials, which is all there is of
     *  somebody who arrived on a link. */
    personId?: string | null;
    /** Own video only, or every tile while deafened. Playing your own
     *  microphone back is an echo. */
    muted?: boolean;
    guest?: boolean;
    cameraOff?: boolean;
    sharing?: boolean;
    speaking?: boolean;
    /** Who this tile's volume is remembered against. Absent on your own tile,
     *  which has no volume to set - it is never played back. */
    volumeKey?: string;
}) {
    const video = useRef<HTMLVideoElement>(null);
    const [volume, setVolume] = useCallVolume(volumeKey ?? "");

    useEffect(() => {
        if (video.current && stream) video.current.srcObject = stream;
    }, [stream]);

    // Applied to the element rather than to the connection: the audio still
    // arrives and is simply played quieter, so a change lands on the next frame
    // and nobody is renegotiated at.
    useEffect(() => {
        if (video.current && volumeKey) video.current.volume = volume;
    }, [volume, volumeKey, stream]);

    const tile = (
        <div
            className={cn(
                "relative min-h-0 overflow-hidden rounded-lg bg-elevated ring-1 transition-shadow duration-fast",
                // Two rings rather than a thicker one: a border that appears and
                // disappears would move everything inside the tile by two pixels
                // every time somebody drew breath.
                speaking ? "ring-2 ring-success" : "ring-border"
            )}
        >
            <video
                ref={video}
                autoPlay
                playsInline
                muted={muted}
                className={cn(
                    "size-full",
                    // A shared screen is letterboxed rather than cropped: the
                    // edges of somebody's window are usually where the thing
                    // they are pointing at is.
                    sharing ? "object-contain" : "object-cover",
                    cameraOff && "invisible"
                )}
            />
            {(!stream || cameraOff) && (
                // A face rather than a name in the middle of an empty rectangle.
                // Most of a call is spent with the cameras off, so this is what
                // a call actually looks like - and a picture is read across a
                // grid of eight far faster than eight names are.
                <span className="absolute inset-0 flex items-center justify-center">
                    <Avatar
                        size={AVATAR_SIZE}
                        person={{ id: personId ?? name, name }}
                        className={cn(
                            "transition-shadow duration-fast",
                            speaking && "ring-2 ring-success"
                        )}
                    />
                </span>
            )}
            <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[11px]">
                {name}
                {guest && <span className="text-muted-foreground">guest</span>}
                {sharing && <span className="text-primary">sharing</span>}
                {volumeKey && volume === 0 && (
                    <VolumeX className="size-3 text-danger" aria-label="Silenced for you" />
                )}
            </span>
        </div>
    );

    if (!volumeKey) return tile;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                <ContextMenuLabel>{name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem
                    onSelect={(event) => {
                        // The menu would otherwise close on the press that moved
                        // the slider, which is the one control here that is used
                        // by dragging rather than by choosing.
                        event.preventDefault();
                    }}
                    className="flex-col items-stretch gap-1.5"
                >
                    <span className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Volume</span>
                        <span className="tabular-nums">{Math.round(volume * 100)}%</span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={MAX_VOLUME}
                        step={0.05}
                        value={volume}
                        aria-label={`How loud ${name} is`}
                        onChange={(event) => setVolume(Number(event.target.value))}
                        className="w-full accent-primary"
                    />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => setVolume(volume === 0 ? DEFAULT_VOLUME : 0)}
                >
                    {volume === 0 ? (
                        <Volume2 className="size-3.5" />
                    ) : (
                        <VolumeX className="size-3.5" />
                    )}
                    {volume === 0 ? "Let them through" : "Silence them for you"}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
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

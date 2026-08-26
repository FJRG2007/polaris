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

import type { CallState } from "./use-call";
import * as actions from "./meeting-actions";
import { useHeldCall } from "./call-session";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { searchPeopleAction } from "./actions";
import { playCallSound } from "@/lib/call-sounds";
import { useEffect, useRef, useState } from "react";
import { NOISE_LEVELS } from "./mic-cleanup";
import type { FilteredMic, MicFilter } from "./mic-filter";
import { DEFAULT_VOLUME, MAX_VOLUME, useCallVolume } from "./call-volumes";
import { stagesOf, stagingOf } from "./call-media";
import { CombineRequestDialog, CombineStrip } from "./call-combine-panel";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    CAMERA_LADDER,
    LEVELS,
    SCREEN_LADDER,
    type CallLevel,
    type CallQuality,
    type QualityLadder
} from "./call-quality";
import {
    Check,
    ChevronUp,
    Circle,
    Expand,
    Headphones,
    HeadphoneOff,
    Link2,
    Loader2,
    Maximize2,
    Mic,
    MicOff,
    Minimize2,
    MonitorUp,
    MonitorX,
    PhoneOff,
    Shrink,
    Square,
    UserPlus,
    Users,
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
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";

/**
 * The room.
 *
 * The call itself is held above every screen (see `call-session`), so this draws
 * one rather than owning one: walking out of the conversation shrinks the call
 * into the bar instead of hanging it up, and walking back in finds the same
 * connections still running.
 */
export function CallRoom({
    meetingId,
    call,
    onLeave,
    onMoved,
    onStage,
    /** Whoever is watching, when they have an account. The guest link is the
     *  host's to open and nobody else's, so the control is drawn from who the
     *  call says its host is rather than from who opened this screen - offering
     *  a button that the server will refuse is worse than not offering it. */
    viewerId
}: {
    meetingId: string;
    call: CallState;
    onLeave: () => void;
    /** Told when bringing somebody in has taken the call somewhere else - a
     *  one-to-one cannot hold three people, so it becomes a group and this
     *  browser has to follow it there. Absent for a guest, who cannot invite. */
    onMoved?: (to: { meetingId: string; channelId: string }) => void;
    /** Told whether a screen or an enlarged face currently has the big place in
     *  the room. Must keep its identity across renders, as any state setter
     *  does. */
    onStage?: (staged: boolean) => void;
    viewerId?: string;
}) {
    const [inviting, setInviting] = useState(false);
    const [asking, setAsking] = useState(false);
    const [guestLink, setGuestLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [shareError, setShareError] = useState("");

    const canShare = Boolean(viewerId) && call.meeting?.hostId === viewerId;
    /**
     * The two keys every voice application has: F9 mutes, F10 deafens.
     *
     * Bound while the room is on screen and nowhere else, and taken from the
     * browser rather than left to it - F10 opens a menu bar in some of them, and
     * a shortcut that sometimes opens a menu instead of muting you is worse than
     * no shortcut. Function keys type nothing, so this is safe over a composer
     * somebody is writing in.
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
            if (event.key !== "F9" && event.key !== "F10") return;
            event.preventDefault();
            if (event.key === "F9") call.toggleMic();
            else call.toggleDeafen();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [call]);

    const admitted = call.meeting?.participants.filter((person) => person.admission === "admitted");
    /** Whether the call is being written down, and by whom - this browser
     *  included, since the person recording needs telling as much as anybody. */
    const recording = [...call.states].filter(([, state]) => state.recording).map(([id]) => id);
    const recorded = call.recording || recording.length > 0;
    // This browser's own seat, which is where its own face comes from: a guest
    // has no account to draw one from, and the signed-in id is not on the seat.
    const mine = admitted?.find((person) => person.id === call.participantId);
    const waiting = call.meeting?.participants.filter((person) => person.admission === "waiting");
    const recordedBy =
        call.meeting?.participants.find((person) => person.id === recording[0])?.name ??
        "Somebody";

    /**
     * What somebody else's tile says and offers about sharing a room with them.
     *
     * Nothing at all once this device is already quiet for a room: a companion
     * that combined again would be pointing at two devices at once, and the way
     * out of one room before joining another is the strip above.
     */
    const combining = (personId: string) => {
        const together = call.audioMembers.includes(personId);
        // Drawn for anybody who has gone quiet for a room, not only for the
        // room this reader is in. Somebody watching from elsewhere sees two
        // people muted and no reason for it otherwise, which reads as two
        // people refusing to answer.
        const quiet = together || call.states.get(personId)?.group != null;
        if (together || call.audioRole === "companion") return { sameRoom: quiet };
        return {
            sameRoom: quiet,
            onCombine: () => call.combineWith(personId),
            onAskCombine: () => call.askToCombine(personId),
            combineAsked: call.combineAsked === personId
        };
    };
    const columns = gridColumns((admitted?.length ?? 1) || 1);

    /**
     * The one picture filling the room, when somebody has asked for one.
     *
     * A key rather than a participant, because a person can be two pictures at
     * once - their face and the screen they are sharing - and "make that bigger"
     * has to mean the one that was pressed. Dropped when whatever it names is no
     * longer there, so a sharer stopping does not leave the room staring at an
     * empty rectangle.
     */
    const [focused, setFocused] = useState<string | null>(null);
    const focus = (key: string) => setFocused((current) => (current === key ? null : key));

    /** Every screen being shared into this room, this browser's own included -
     *  see `stagesOf`, which is where the reasoning lives. */
    const stages = stagesOf({
        localScreen: call.localScreen,
        participantId: call.participantId,
        screens: call.screens,
        nameOf: (personId) => nameOf(admitted, personId)
    });
    const cameraKeys = (admitted ?? []).map((person) => `camera:${person.id}`);
    const live =
        focused && [...stages.map((stage) => stage.key), ...cameraKeys].includes(focused)
            ? focused
            : null;
    /** What the room is built around right now - see `stagingOf`, which is where
     *  the reasoning lives. */
    const { showing, staged, enlarged } = stagingOf(stages, live);

    /** Said out loud rather than worked out again outside, because it is decided
     *  here: what is being watched turns on what somebody in this room asked
     *  for, and that is this component's own. */
    useEffect(() => {
        onStage?.(staged);
        return () => onStage?.(false);
    }, [onStage, staged]);

    useEffect(() => {
        if (!call.meeting?.guestToken) return;
        setGuestLink(`${window.location.origin}/m/${call.meeting.guestToken}`);
    }, [call.meeting?.guestToken]);

    // The call ending under somebody - the host closing it, or the last other
    // person leaving a one-to-one - is the case that most needs a sound: the
    // screen they are looking at is not this one.
    //
    // Which is exactly why the dashboard sounds it from the provider instead,
    // where it is heard wherever the reader is standing. This is left for the
    // guest page, which has no provider and no other screen to be on.
    const held = useHeldCall();
    /** Whether this screen may start a recording at all: the host, in a browser
     *  that can record video, with the call held above it - the guest page has
     *  no provider and nowhere to put what it would make. */
    const canRecord = canShare && held !== null && held.recording.supported;
    const wasEnded = useRef(false);
    useEffect(() => {
        if (!held && call.ended && !wasEnded.current) playCallSound("hangUp");
        wasEnded.current = call.ended;
    }, [call.ended, held]);

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

            {/* Said before anything else on the screen, and to everybody: a
                call being written down is the one fact in a room that changes
                what people are willing to say in it. */}
            {recorded && (
                <p className="flex shrink-0 items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    <Circle className="size-3 shrink-0 fill-current" />
                    <span className="min-w-0 flex-1">
                        {call.recording
                            ? "You are recording this call. Everybody in it can see that."
                            : `${recordedBy} is recording this call.`}
                    </span>
                </p>
            )}

            <CombineStrip call={call} />

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

            {/* The screens, which are the thing everybody is looking at while
                they are there. Above the faces and across the whole width rather
                than in a tile the size of a head: a shared screen is usually
                text, and text in a ninth of a window is not readable. Side by
                side when there are several, rather than stacked - two shares
                stacked in a panel this tall leave each of them a strip. */}
            {showing.length > 0 && (
                <div className={cn("grid min-h-0 flex-[3] gap-2", gridColumns(showing.length))}>
                    {showing.map((stage) => (
                        <Tile
                            key={stage.key}
                            stream={stage.stream}
                            name={stage.name}
                            personId={null}
                            focused={live === stage.key}
                            onFocus={() => focus(stage.key)}
                            volumeKey={undefined}
                        />
                    ))}
                </div>
            )}

            {/* A face somebody asked to see bigger takes the same place a screen
                would. One at a time: two big pictures is the grid again. */}
            {live?.startsWith("camera:") && (
                <div className="min-h-0 flex-[3]">
                    {live === `camera:${call.participantId}` ? (
                        <Tile
                            stream={call.localStream}
                            name="You"
                            personId={mine?.userId ?? viewerId ?? null}
                            own
                            focused
                            onFocus={() => focus(live)}
                            cameraOff={!call.cameraOn}
                            muted={!call.micOn}
                            deafened={call.deafened}
                        />
                    ) : (
                        (() => {
                            const personId = live.slice("camera:".length);
                            const person = admitted?.find((entry) => entry.id === personId);
                            return (
                                <Tile
                                    stream={call.remote.get(personId) ?? null}
                                    name={person?.name ?? "Somebody"}
                                    personId={person?.userId ?? null}
                                    guest={person?.guest}
                                    focused
                                    onFocus={() => focus(live)}
                                    muted={call.states.get(personId)?.muted}
                                    deafened={call.states.get(personId)?.deafened}
                                    speaking={call.speaking.has(personId)}
                                    recording={call.states.get(personId)?.recording}
                                    volumeKey={person?.userId ?? personId}
                                    {...combining(personId)}
                                />
                            );
                        })()
                    )}
                </div>
            )}

            {/* The faces. Gone entirely while a screen has been asked for by
                name, because they are the only room left to give it: the tile
                asked to be bigger, and the strip along the bottom is the last
                thing between it and the whole panel. */}
            {!enlarged && (
                <div
                    className={cn(
                        "grid min-h-0 gap-2",
                        // A strip of thumbnails along the bottom while something
                        // has the room, and an even grid when nothing does.
                        // Scrolling sideways rather than shrinking further: eight
                        // faces on a phone, each a twelfth of a strip, are eight
                        // grey squares.
                        staged
                            ? "h-24 shrink-0 auto-cols-[9rem] grid-flow-col overflow-x-auto"
                            : cn("flex-1", columns)
                    )}
                >
                    <Tile
                        stream={call.localStream}
                        name="You"
                        personId={mine?.userId ?? viewerId ?? null}
                        own
                        speaking={
                            call.participantId !== null &&
                            call.speaking.has(call.participantId) &&
                            call.micOn
                        }
                        cameraOff={!call.cameraOn}
                        sharing={call.sharing}
                        // Your own tile says it too. It used to be the one tile
                        // that did not: everybody else's face carried the icon
                        // and yours carried nothing, so the only way to tell
                        // whether you were muted was to look away from the
                        // people and down at the buttons - which is the moment
                        // somebody talks into a dead microphone.
                        muted={!call.micOn}
                        deafened={call.deafened}
                        recording={call.recording}
                        sameRoom={call.audioRole !== null}
                        focused={live === `camera:${call.participantId}`}
                        onFocus={
                            call.participantId
                                ? () => focus(`camera:${call.participantId}`)
                                : undefined
                        }
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
                                muted={call.states.get(person.id)?.muted}
                                deafened={call.states.get(person.id)?.deafened}
                                recording={call.states.get(person.id)?.recording}
                                focused={live === `camera:${person.id}`}
                                onFocus={() => focus(`camera:${person.id}`)}
                                {...combining(person.id)}
                                // Their account where they have one, so turning
                                // somebody down holds across calls; their seat
                                // where they do not, which lasts as long as the
                                // seat.
                                volumeKey={person.userId ?? person.id}
                            />
                        ))}
                </div>
            )}

            {/* Never squeezed. It wraps to a second row on a narrow window, and
                a flex row that is allowed to shrink gives that second row away
                to the pictures above it - which is how the button somebody
                needed to leave the call ended up half off the panel. */}
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
                <Split
                    label={call.micOn ? "Mute" : "Unmute"}
                    icon={call.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                    variant={call.micOn ? "secondary" : "danger"}
                    pressed={!call.micOn}
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
                    variant={call.cameraOn ? "secondary" : "danger"}
                    pressed={!call.cameraOn}
                    onClick={call.toggleCamera}
                    devices={call.cameras}
                    chosenId={call.cameraId}
                    devicesLabel="Camera"
                    onChoose={call.chooseCamera}
                    ladder={CAMERA_LADDER}
                    quality={call.cameraQuality}
                    level={call.cameraLevel}
                    onQuality={call.setCameraQuality}
                    qualityLabel="Video quality"
                />

                <Split
                    label={call.sharing ? "Stop sharing" : "Share screen"}
                    icon={
                        call.sharing ? (
                            <MonitorX className="size-4" />
                        ) : (
                            <MonitorUp className="size-4" />
                        )
                    }
                    variant={call.sharing ? "primary" : "secondary"}
                    pressed={call.sharing}
                    onClick={call.toggleShare}
                    // A screen is not a device to pick between: the browser's own
                    // picker does that, every time, and it is the only thing
                    // allowed to.
                    devices={[]}
                    chosenId={null}
                    devicesLabel="Screen"
                    onChoose={() => undefined}
                    ladder={SCREEN_LADDER}
                    quality={call.screenQuality}
                    level={call.screenLevel}
                    onQuality={call.setScreenQuality}
                    qualityLabel="Screen quality"
                />

                {/* Bringing somebody in. In a group they are added and their
                    telephone rings; in a one-to-one the call becomes a group,
                    because a direct message is between the two people it is
                    keyed by. Not offered to a guest, who is in one room on a
                    link and has no conversation to add anybody to. */}
                {viewerId && (
                    <Button size="sm" variant="secondary" onClick={() => setInviting(true)}>
                        <UserPlus className="size-4" />
                        Add people
                    </Button>
                )}

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

                {/* Recording is the host's to start, and only where there is
                    a provider holding the call: the guest page has no dashboard
                    around it and nowhere to put what it made. */}
                {canRecord && (
                    <Button
                        size="sm"
                        variant={call.recording ? "danger" : "secondary"}
                        aria-pressed={call.recording}
                        onClick={() => (call.recording ? held?.recording.stop() : setAsking(true))}
                        title={
                            call.recording
                                ? "Stop recording and keep what was made"
                                : "Write this call to a video file in this browser"
                        }
                    >
                        {call.recording ? (
                            <Square className="size-4 fill-current" />
                        ) : (
                            <Circle className="size-4" />
                        )}
                        {call.recording ? `Stop (${clock(held?.recording.seconds ?? 0)})` : "Record"}
                    </Button>
                )}

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

            {viewerId && (
                <InviteToCallDialog
                    open={inviting}
                    onOpenChange={setInviting}
                    meetingId={meetingId}
                    already={(admitted ?? [])
                        .map((person) => person.userId)
                        .filter((id): id is string => Boolean(id))}
                    onDone={(to) => {
                        setInviting(false);
                        if (to) onMoved?.(to);
                        call.refresh();
                    }}
                />
            )}

            <CombineRequestDialog call={call} />

            {/* Asked once, because it is a decision about everybody in the room
                rather than about the person pressing it. */}
            <Dialog open={asking} onOpenChange={setAsking}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Record this call?</DialogTitle>
                        <DialogDescription>
                            The recording is made in this browser, from what it can see and hear, and
                            it stops if you leave the call or close the tab. Everybody in the call is
                            told while it runs. When you stop, you choose whether it goes into the
                            conversation or stays on this machine.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setAsking(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => {
                                setAsking(false);
                                held?.recording.start();
                            }}
                        >
                            <Circle className="size-4" />
                            Start recording
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
    variant,
    pressed,
    onClick,
    devices,
    chosenId,
    devicesLabel,
    onChoose,
    cleanMic,
    onCleanMic,
    filterRunning,
    licensedOffered,
    ladder,
    quality,
    level,
    onQuality,
    qualityLabel
}: {
    label: string;
    icon: React.ReactNode;
    /** How the button reads: off is danger, on-and-sending is primary. */
    variant: "secondary" | "danger" | "primary";
    pressed: boolean;
    onClick: () => void;
    devices: readonly { id: string; label: string }[];
    chosenId: string | null;
    devicesLabel: string;
    onChoose: (deviceId: string) => void;
    /** How much picture this control sends, when it sends one. Four of these
     *  arrive together or none of them do. */
    ladder?: QualityLadder;
    quality?: CallQuality;
    /** What is going out right now, which under `auto` is not the setting. */
    level?: CallLevel;
    onQuality?: (value: CallQuality) => void;
    qualityLabel?: string;
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
    // sits in a room with a fan in it, and a machine with one screen still has a
    // choice to make about how much of it to send.
    const hasMenu = devices.length > 1 || onCleanMic !== undefined || onQuality !== undefined;
    const showing = ladder && level ? ladder.rungs[level] : null;

    return (
        <span className="flex items-center">
            <Button
                size="sm"
                variant={variant}
                onClick={onClick}
                aria-pressed={pressed}
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
                            variant={variant}
                            aria-label={`${devicesLabel} settings`}
                            className="rounded-l-none border-l border-border-strong px-1.5"
                        >
                            <ChevronUp className="size-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" side="top" className="max-w-72">
                        {onQuality && ladder && quality && level && showing && (
                            <>
                                <DropdownMenuLabel>{qualityLabel}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => onQuality("auto")}>
                                    <Check
                                        className={cn(
                                            "size-3.5 shrink-0",
                                            quality === "auto" ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    <span className="flex min-w-0 flex-col">
                                        <span>Automatic</span>
                                        <span className="text-xs text-muted-foreground">
                                            Drops when the connection struggles and comes back when
                                            it recovers.
                                        </span>
                                    </span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={(event) => {
                                        // The menu would otherwise close on the
                                        // press that moved the bar, which is the
                                        // one control here used by dragging.
                                        event.preventDefault();
                                    }}
                                    className="flex-col items-stretch gap-1.5"
                                >
                                    <span className="flex items-center justify-between text-xs text-muted-foreground">
                                        {/* Always what is going out, never what
                                            was asked for: under Automatic those
                                            are different, and the one worth
                                            reading is the one being sent. */}
                                        <span>{showing.label}</span>
                                        <span className="tabular-nums">{showing.detail}</span>
                                    </span>
                                    <input
                                        type="range"
                                        min={0}
                                        max={LEVELS.length - 1}
                                        step={1}
                                        value={LEVELS.indexOf(level)}
                                        aria-label={qualityLabel}
                                        onChange={(event) => {
                                            const picked = LEVELS[Number(event.target.value)];
                                            // Moving it by hand is how Automatic
                                            // is turned off - there is nothing
                                            // else the gesture could mean.
                                            if (picked) onQuality(picked);
                                        }}
                                        className="w-full accent-primary"
                                    />
                                    <span className="flex items-center justify-between text-[11px] text-foreground-subtle">
                                        <span>Least data</span>
                                        <span>Best picture</span>
                                    </span>
                                </DropdownMenuItem>
                            </>
                        )}
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
                        {devices.length > 1 && (
                            <DropdownMenuLabel>{devicesLabel}</DropdownMenuLabel>
                        )}
                        {devices.length > 1 && <DropdownMenuSeparator />}
                        {devices.map((device) => (
                            <DropdownMenuItem key={device.id} onSelect={() => onChoose(device.id)}>
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

/** Seconds as a clock reads them, for a recording that is running. */
function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How big the face in an empty tile is. One size for every tile: a grid where
 *  the faces are different sizes reads as a mistake. */
const AVATAR_SIZE = 72;

function Tile({
    stream,
    name,
    personId,
    own = false,
    guest = false,
    cameraOff = false,
    sharing = false,
    speaking = false,
    muted = false,
    deafened = false,
    sameRoom = false,
    recording = false,
    focused = false,
    onFocus,
    onCombine,
    onAskCombine,
    combineAsked = false,
    volumeKey
}: {
    stream: MediaStream | null;
    name: string;
    /** Whose picture to draw while there is no video. Their account where they
     *  have one; a guest falls back to initials, which is all there is of
     *  somebody who arrived on a link. */
    personId?: string | null;
    /** Yours. The only tile whose picture may be cropped to fill the frame,
     *  because it is the only one this browser knows the shape of. */
    own?: boolean;
    guest?: boolean;
    cameraOff?: boolean;
    /** Whether you are sharing a screen. Said on your own tile because the
     *  screen itself is up on the stage rather than in it, so nothing else on
     *  this tile would tell you it is going out. */
    sharing?: boolean;
    speaking?: boolean;
    /** This person's microphone is off, or they have stopped listening
     *  altogether. Neither can be heard, so both are drawn - on your own tile as
     *  much as on anybody else's. */
    muted?: boolean;
    deafened?: boolean;
    /** Whether this person is sitting in the same room as the reader, sharing
     *  one microphone between their devices - see `call-combine`. */
    sameRoom?: boolean;
    /** Whether this person is writing the call to a file. */
    recording?: boolean;
    /** Whether this tile is the one filling the room right now. */
    focused?: boolean;
    /** Make this the big one, or put it back. Absent where there is nothing to
     *  enlarge - a tile with no picture in it. */
    onFocus?: () => void;
    /** Go quiet and listen through this person's device, and ask them to go
     *  quiet and listen through this one. Both absent once the two are already
     *  sharing a room, and on a tile that is not somebody else's. */
    onCombine?: () => void;
    onAskCombine?: () => void;
    combineAsked?: boolean;
    /** Who this tile's volume is remembered against. Absent on your own tile,
     *  which has no volume to set - it is never played back. */
    volumeKey?: string;
}) {
    const video = useRef<HTMLVideoElement>(null);
    const frame = useRef<HTMLDivElement>(null);
    const [volume, setVolume] = useCallVolume(volumeKey ?? "");

    /**
     * Full screen, on the tile rather than on the video inside it.
     *
     * A `<video>` taken full screen by the browser draws nothing but the video:
     * the name, the ring that says somebody is talking and the buttons all go
     * with it. Taking the frame instead keeps them, which is also how the camera
     * viewer does it.
     *
     * Tracked rather than assumed, because Escape leaves full screen without
     * pressing anything here.
     */
    const [full, setFull] = useState(false);
    useEffect(() => {
        const onChange = () => setFull(document.fullscreenElement === frame.current);
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    const toggleFull = () => {
        if (document.fullscreenElement === frame.current)
            void document.exitFullscreen().catch(() => undefined);
        else void frame.current?.requestFullscreen().catch(() => undefined);
    };

    /**
     * Attach the stream and start the picture.
     *
     * Picture only: this element is muted, always, whoever it belongs to. The
     * room is played by `call-audio`, which is mounted beside the call rather
     * than beside the grid - a tile that also carried the sound is a tile that
     * takes the sound with it when somebody walks out of the conversation, and
     * that is precisely what left people watching a green ring in silence.
     *
     * Muted media is never refused, so there is nothing here to be blocked on.
     */
    useEffect(() => {
        const element = video.current;
        if (!element || !stream) return;
        element.srcObject = stream;
        void element.play().catch(() => undefined);
    }, [stream]);

    /**
     * Whether there is a picture in this stream at all.
     *
     * Asked of the stream rather than taken from a prop, because for everybody
     * except yourself there is no prop to take it from: a call with the cameras
     * off still has a stream, so the tile drew a black rectangle over the face
     * it was supposed to be showing - no picture, no initials, nothing. A remote
     * video track also starts out muted and unmutes when media arrives, which is
     * the same question asked a moment later.
     */
    const [hasVideo, setHasVideo] = useState(false);
    useEffect(() => {
        if (!stream) {
            setHasVideo(false);
            return;
        }

        // Every track this tile is currently listening to. A remote track arrives
        // muted and unmutes when frames start flowing, so the unmute is the event
        // that says there is a picture - and a track that joins the stream later,
        // which is what turning a camera on mid-call sends, has to be listened to
        // as well. Binding once over the tracks that happened to be there when the
        // stream arrived is what left somebody's camera on at their end and blank
        // at everybody else's: the new track was seen (still muted), never heard
        // from again, and the tile stayed a black rectangle for the rest of the
        // call.
        const bound = new Set<MediaStreamTrack>();

        const look = () => {
            const tracks = stream.getVideoTracks();
            for (const track of tracks) {
                if (bound.has(track)) continue;
                bound.add(track);
                track.addEventListener("mute", look);
                track.addEventListener("unmute", look);
                track.addEventListener("ended", look);
            }
            for (const track of [...bound]) {
                if (tracks.includes(track)) continue;
                bound.delete(track);
                track.removeEventListener("mute", look);
                track.removeEventListener("unmute", look);
                track.removeEventListener("ended", look);
            }
            setHasVideo(tracks.some((track) => track.readyState === "live" && !track.muted));
        };

        look();
        stream.addEventListener("addtrack", look);
        stream.addEventListener("removetrack", look);

        // Asked again on a timer as well, because `addtrack` is the one signal
        // here that browsers disagree about: a track a peer connection puts into
        // a stream it created does not reliably announce itself, and the tile
        // cannot tell the difference between "no camera" and "nobody told us".
        // A second is invisible to somebody watching and cheap enough to run for
        // as long as a call lasts.
        const timer = setInterval(look, 1000);

        return () => {
            clearInterval(timer);
            stream.removeEventListener("addtrack", look);
            stream.removeEventListener("removetrack", look);
            for (const track of bound) {
                track.removeEventListener("mute", look);
                track.removeEventListener("unmute", look);
                track.removeEventListener("ended", look);
            }
        };
    }, [stream]);

    const blank = !stream || cameraOff || !hasVideo;

    const tile = (
        <div
            ref={frame}
            className={cn(
                "group/tile relative min-h-0 overflow-hidden rounded-lg bg-elevated ring-1 transition-shadow duration-fast",
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
                muted
                className={cn(
                    "size-full",
                    // Letterboxed rather than cropped for anything that might be
                    // a screen - and from here, anybody else's picture might be:
                    // nothing says whether what arrived is a camera or a window,
                    // and the edges of somebody's window are usually where the
                    // thing they are pointing at is. Only your own picture is
                    // cropped to fill the tile, because it is the only one this
                    // browser knows the shape of.
                    // Your own is always a camera now - the screen you are
                    // sharing has its own tile up on the stage - so this no
                    // longer has to ask which of the two it is holding.
                    own ? "object-cover" : "object-contain",
                    blank && "invisible"
                )}
            />
            {blank && (
                // A face rather than a name in the middle of an empty rectangle.
                // Most of a call is spent with the cameras off, so this is what
                // a call actually looks like - and a picture is read across a
                // grid of eight far faster than eight names are.
                <span className="absolute inset-0 flex items-center justify-center">
                    <Avatar
                        size={AVATAR_SIZE}
                        person={{ id: personId ?? null, name }}
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
                {/* Drawn because this person cannot be heard, yours included.
                    Deafened wins the space: somebody who is not listening is not
                    reached by talking louder, and their microphone being off
                    follows from it anyway. */}
                {deafened ? (
                    <HeadphoneOff className="size-3 text-danger" aria-label="Not listening" />
                ) : muted ? (
                    <MicOff className="size-3 text-danger" aria-label="Microphone off" />
                ) : null}
                {volumeKey && volume === 0 && (
                    <VolumeX className="size-3 text-danger" aria-label="Silenced for you" />
                )}
                {sameRoom && (
                    <Users
                        className="size-3 text-primary"
                        aria-label="Sharing a room's microphone"
                    />
                )}
                {recording && (
                    <Circle
                        className="size-3 fill-current text-danger"
                        aria-label="Recording this call"
                    />
                )}
            </span>

            {/* Two different things, which is why they are two buttons. Bigger
                keeps the call around it - the other faces, the controls, the
                conversation - and is what somebody wants while a screen is being
                explained to them. Full screen is the whole display and nothing
                else, which is what they want when it is a film. */}
            {!blank && (
                <span className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/tile:opacity-100">
                    {onFocus && (
                        <button
                            type="button"
                            onClick={onFocus}
                            aria-label={focused ? "Back to the grid" : "Make this bigger"}
                            title={focused ? "Back to the grid" : "Make this bigger"}
                            className="rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {focused ? (
                                <Shrink className="size-3.5" />
                            ) : (
                                <Expand className="size-3.5" />
                            )}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={toggleFull}
                        aria-label={full ? "Leave full screen" : "Full screen"}
                        title={full ? "Leave full screen" : "Full screen"}
                        className="rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {full ? (
                            <Minimize2 className="size-3.5" />
                        ) : (
                            <Maximize2 className="size-3.5" />
                        )}
                    </button>
                </span>
            )}
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
                        <span
                            className={cn(
                                "tabular-nums",
                                volume > DEFAULT_VOLUME && "font-medium text-warning"
                            )}
                        >
                            {Math.round(volume * 100)}%
                        </span>
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
                    {/* Where they were sent, marked on a track that runs past
                        it. Without it there is nothing on screen to find your
                        way back to, and "as loud as they actually are" is the
                        one position on this slider anybody looks for. Pressing
                        it is how you get there. */}
                    <button
                        type="button"
                        onClick={() => setVolume(DEFAULT_VOLUME)}
                        disabled={volume === DEFAULT_VOLUME}
                        className="self-start text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground disabled:no-underline disabled:opacity-60"
                    >
                        {volume === DEFAULT_VOLUME
                            ? "As they were sent"
                            : "Back to how they were sent"}
                    </button>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setVolume(volume === 0 ? DEFAULT_VOLUME : 0)}>
                    {volume === 0 ? (
                        <Volume2 className="size-3.5" />
                    ) : (
                        <VolumeX className="size-3.5" />
                    )}
                    {volume === 0 ? "Let them through" : "Silence them for you"}
                </ContextMenuItem>

                {/* The way to combine with somebody this browser did not hear -
                    across a big room, on a laptop with the volume down, or on a
                    machine where listening for the room is switched off. */}
                {(onCombine || onAskCombine) && <ContextMenuSeparator />}
                {onCombine && (
                    <ContextMenuItem onSelect={onCombine}>
                        <Headphones className="size-3.5" />
                        Use their audio
                    </ContextMenuItem>
                )}
                {onAskCombine && (
                    <ContextMenuItem onSelect={onAskCombine} disabled={combineAsked}>
                        <Users className="size-3.5" />
                        {combineAsked ? "Asked to combine" : "Ask them to combine audio"}
                    </ContextMenuItem>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}

/**
 * Bringing somebody into a call that is already running.
 *
 * Its own dialog rather than the one the header uses, because the two do
 * different things: that one adds people to a conversation, and this one adds
 * them to a call - which in a one-to-one means the conversation changes under
 * everybody, and the browser that asked has to be told where the call went.
 */
function InviteToCallDialog({
    open,
    onOpenChange,
    meetingId,
    already,
    onDone
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    meetingId: string;
    /** Who is in the call, so nobody is offered a person that picking would do
     *  nothing about. */
    already: readonly string[];
    onDone: (movedTo: { meetingId: string; channelId: string } | null) => void;
}) {
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const bring = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.inviteToCallAction({
                    meetingId,
                    userIds: picked.map((person) => person.id)
                }),
            setError
        );
        setBusy(false);
        if (!result || result.error) return;
        setPicked([]);
        onDone(
            result.moved && result.meetingId && result.channelId
                ? { meetingId: result.meetingId, channelId: result.channelId }
                : null
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add people</DialogTitle>
                    <DialogDescription>
                        Their telephone rings. Bringing somebody into a one-to-one call makes it a
                        group with the three of you in it.
                    </DialogDescription>
                </DialogHeader>

                <PeoplePicker
                    picked={picked}
                    onChange={setPicked}
                    exclude={already}
                    search={searchPeopleAction}
                />

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={busy || picked.length === 0} onClick={() => void bring()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Add
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Whose screen it is, for the label over it. A participant who left mid-share
 *  is named as somebody rather than as nothing. */
function nameOf(
    people: readonly { id: string; name: string }[] | undefined,
    personId: string
): string {
    return people?.find((person) => person.id === personId)?.name ?? "Somebody";
}

/** Enough columns to keep the tiles roughly square at every size a call can
 *  reach. A lookup rather than a measurement: the room is capped at eight. */
function gridColumns(people: number): string {
    if (people <= 1) return "grid-cols-1";
    if (people <= 4) return "grid-cols-2";
    if (people <= 6) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}

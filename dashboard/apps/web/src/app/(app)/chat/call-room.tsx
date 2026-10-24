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
 * screen, deafen and hang up. Each button carries the state it is in rather than
 * the action it performs, because a row of buttons that all say what they will
 * do cannot be read at a glance to find out what is currently on.
 *
 * They are icons without words, which is what every call client settled on and
 * for the same reason: five labelled buttons is a sentence to read every time
 * somebody wants to mute, and these five shapes are already known by everybody
 * who has ever been in a call. The words are still there for anybody who needs
 * them - as the title and the accessible name - and what is not reached for
 * mid-sentence, raising a hand, adding somebody and recording, sits out of the
 * way at the top rather than competing with the controls at the bottom.
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
import Link from "next/link";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as actions from "./meeting-actions";
import { useHeldCall } from "./call-session";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { NOISE_LEVELS } from "./mic-cleanup";
import {
    BACKGROUNDS,
    BACKGROUND_SCENES,
    sceneOf,
    type BackgroundScene,
    type CameraBackground
} from "./camera-background";
import { ChatPeoplePicker } from "./chat-people-picker";
import { CameraLookMenu } from "./camera-look-menu";
import type { CameraLook } from "./camera-look";
import { cameraProblemText, type CameraProblem } from "./camera-problem";
import { CallNoticeStrip, useCallNotices } from "./call-notice-strip";
import { playCallSound } from "@/lib/call-sounds";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { FACE_MAX, fillsTile, useFaceSize, useTileFit } from "./call-grid";
import type { FilteredMic, MicFilter } from "./mic-filter";
import {
    REACTIONS,
    REACTION_GLYPHS,
    handPlaces,
    type Reaction,
    type ShownReaction
} from "./call-signals";
import { Cue, SoundboardButton } from "./soundboard-picker";
import { LiveBadge } from "./call-roster";
import { useSpeakers } from "./speaker-device";
import { HandStrip } from "./call-hands-panel";
import { CallGamesButton, CallGamesPanel, useCallActivity } from "./call-activity-panel";
import { useCallVolume } from "./call-volumes";
import { MicLevelMeter } from "./mic-level-meter";
import { GAIN_MAX, GAIN_MIN, useMicGain } from "./mic-gain";
import { PersonMenu, StreamMenu, type SeatHosting } from "./call-menus";
import { useZoomPan } from "@/components/use-zoom-pan";
import { setWatchedStreams } from "./call-stream-audio";
import { useStreamFormat } from "./call-stream-format";
import { ControlHint, type ControlHintText } from "./control-hint";
import { useMutedSpeech } from "./muted-speech";
import type { SeatModeration } from "./call-moderation-menu";
import { callBareFaces, directLayout, type CallPlace } from "./call-band";
import { CombineRequestDialog, CombineStrip } from "./call-combine-panel";
import type { PickedPerson } from "@/components/people-picker";
import {
    arrivedKeys,
    canShareScreen,
    LOCAL_SCREEN_KEY,
    putAwayOf,
    stagesOf,
    type CallStage,
    stagingOf,
    stillShared,
    watched
} from "./call-media";
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
    ChevronsDown,
    ChevronsUp,
    Circle,
    Expand,
    Eye,
    EyeOff,
    Hand,
    HeadphoneOff,
    Headphones,
    ImagePlus,
    Link2,
    Loader2,
    Maximize2,
    Mic,
    MicOff,
    Minimize2,
    Monitor,
    MonitorUp,
    MoreHorizontal,
    Smile,
    MonitorX,
    PhoneOff,
    SlidersHorizontal,
    Shrink,
    Square,
    UserPlus,
    Users,
    Video,
    VideoOff,
    VolumeX,
    X
} from "lucide-react";
import {
    Button,
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
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    cn,
    useShortcutHint
} from "@polaris/ui";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { useShareAsked } from "./call-share-ask";
import { ShareStreamItems } from "./share-stream-menu";
import { sharePress } from "./call-share-menu";
import { MeetingLinkLimits } from "./meeting-link-limits";

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
    place,
    call,
    onLeave,
    onMoved,
    onStage,
    expanded = false,
    onExpand,
    /** Whoever is watching, when they have an account. The guest link is the
     *  host's to open and nobody else's, so the control is drawn from who the
     *  call says its host is rather than from who opened this screen - offering
     *  a button that the server will refuse is worse than not offering it. */
    viewerId,
    /** Whether this reader may bring somebody into the conversation this call
     *  is in. False in a group whose owner keeps adding people to themselves,
     *  where the service refuses it. Absent - a meeting of its own, a guest -
     *  means there is no such rule to apply. */
    mayInvite = true,
    /** Whether everybody in the call may record it, not only whoever started
     *  it. True in a direct message or a group, which are between equals: the
     *  person who happened to ring first is not the one who owns the call.
     *  Everybody is told while it runs either way - see `call-recorder`. */
    mayRecord = false,
    hostSeat,
    moreItems
}: {
    meetingId: string;
    /**
     * Where this call is being drawn, which decides both how much of the column
     * it is worth and what the people in it look like - see `call-band`.
     *
     * A room is somewhere somebody walked into: the call is the point, the
     * conversation sits beside it, and the faces are the furniture. A call
     * started inside a conversation is the other way round - it is happening
     * over the top of something somebody was reading, so the people in it are a
     * row of faces rather than a wall of empty rectangles.
     */
    place: CallPlace;
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
    /** A call in a direct message that has been expanded to take the whole
     *  column - see `directLayout` in `call-band`. */
    expanded?: boolean;
    /** Expand the call, or shrink it back to a band. Absent where the call is
     *  not a band to begin with. */
    onExpand?: (expanded: boolean) => void;
    viewerId?: string;
    mayInvite?: boolean;
    mayRecord?: boolean;
    /** What the host of a meeting may do to the person on a seat, on their
     *  right-click. Absent for anybody who is not hosting. */
    hostSeat?: (seatId: string) => SeatHosting | undefined;
    /** More for the call's "more" menu, after recording and adding people:
     *  the host's doors, in a meeting. */
    moreItems?: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const ts = useTranslations("shortcuts");
    // Games played together in this call - see `call-activity-panel`.
    const activity = useCallActivity(meetingId, call, Boolean(viewerId));
    // The key in force for deafening, named in its control's title.
    const deafenKey = useShortcutHint("chat.toggleDeafen");
    const withKey = (label: string) =>
        deafenKey ? ts("withKey", { action: label, keys: deafenKey }) : label;
    const deafenTitle = call.moderation.serverDeafened
        ? t("callRoom.aModeratorDeafenedYou")
        : call.deafened
          ? withKey(t("callRoom.youCannotHearAnybodyAnd"))
          : withKey(t("callRoom.silenceEverybodyAndYourselfWith"));
    // Said over the microphone only when somebody talks into it while it is
    // off - see `muted-speech`. Muted and deafened on their own are already the
    // buttons' red; a word standing over each read as a tooltip stuck open.
    const muted = !call.micOn && call.audioRole !== "companion";
    const talkingMuted = useMutedSpeech(call.localStream?.getAudioTracks()[0] ?? null, muted);
    const micHint: ControlHintText | null = talkingMuted
        ? { text: t("callRoom.hints.talkingMuted"), tone: "warn" }
        : null;
    // A deck key asked to share: the button is pointed at, and kept on the bar
    // even where it would fold into the menu - see `call-share-ask`.
    const shareAsked = useShareAsked() && !call.sharing;
    // Everything the call has to say, weighed once: the strip draws it, and the
    // microphone button carries whichever of it is about the microphone.
    const notices = useCallNotices(call);
    const [inviting, setInviting] = useState(false);
    const [asking, setAsking] = useState(false);
    /** Whether this browser can share a screen. Asked after mounting, as the
     *  composer asks about clips: the server has no browser to ask. */
    const [screenShareable, setScreenShareable] = useState(false);
    useEffect(() => setScreenShareable(canShareScreen()), []);
    const bar = useRef<HTMLDivElement>(null);
    const narrow = useNarrow(bar, NARROW_BAR);

    const canShare = Boolean(viewerId) && call.meeting?.hostId === viewerId;
    const admitted = call.meeting?.participants.filter((person) => person.admission === "admitted");
    /** Whether the call is being written down, and by whom - this browser
     *  included, since the person recording needs telling as much as anybody. */
    const recording = [...call.states].filter(([, state]) => state.recording).map(([id]) => id);
    const recorded = call.recording || recording.length > 0;
    // This browser's own seat, which is where its own face comes from: a guest
    // has no account to draw one from, and the signed-in id is not on the seat.
    const mine = admitted?.find((person) => person.id === call.participantId);
    // Your own tile says "You", and its face is drawn from your name - initials
    // taken from the word on the plate were "YO" for everybody.
    const you = t("callRoom.you");
    const ownName = mine?.name ?? you;
    const waiting = call.meeting?.participants.filter((person) => person.admission === "waiting");
    const recordedBy =
        call.meeting?.participants.find((person) => person.id === recording[0])?.name ??
        t("callRoom.somebody");

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
            combineAsked: call.combineAsked === personId,
            // Offered but greyed out with two people: the two devices would be
            // the whole call. Follows the roster live - see `combineOffered`.
            combineLocked: !call.combineOpen
        };
    };
    /**
     * What a moderator's right-click on this person offers, or nothing for
     * everybody else. Only where the reader moderates the conversation the call
     * belongs to - the server asks again, this only decides what is drawn.
     */
    const moderating = (seatId: string): { moderation?: SeatModeration } => {
        if (!call.meeting?.mayModerate) return {};
        const person = call.meeting.participants.find((entry) => entry.id === seatId);
        if (!person) return {};
        return {
            moderation: {
                participantId: seatId,
                restriction: {
                    serverMuted: person.serverMuted,
                    serverDeafened: person.serverDeafened
                },
                onDone: call.refresh
            }
        };
    };
    /** What this person has reacted with in the last few seconds. Grouped here
     *  rather than filtered in each tile so the list is walked once for a room
     *  rather than once per face in it. */
    const reactionsFor = (personId: string | null): ShownReaction[] =>
        personId ? call.reactions.filter((shown) => shown.from === personId) : [];

    const columns = gridColumns((admitted?.length ?? 1) || 1);
    /** Where each raised hand stands in the queue, so a tile can carry its own
     *  number. Built once for the room: twenty faces each searching a list of
     *  twenty is four hundred comparisons on the screen that redraws whenever
     *  somebody draws breath. */
    const places = handPlaces(call.hands);
    /** Whether a number is worth drawing at all. A lone "1" beside a hand says
     *  nothing that the hand did not already say. */
    const queued = call.hands.length > 1;

    /** Where this browser plays the call. Empty on a browser that cannot be told,
     *  which is what leaves the picker undrawn rather than drawn and ignored. */
    const speakers = useSpeakers();

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
    const shared = stagesOf({
        localScreen: call.localScreen,
        participantId: call.participantId,
        screens: call.screens,
        nameOf: (personId) => nameOf(admitted, personId, t("callRoom.somebody")),
        words: {
            yourScreen: t("callRoom.yourScreen"),
            theirScreen: (name) => t("callRoom.theirScreen", { name })
        }
    });

    /**
     * Screens this reader has put away.
     *
     * One person deciding to share decides what is on everybody's screen, and on
     * a small one that is the entire window: the call claims the height a
     * picture needs and the conversation underneath goes with it. Putting the
     * share away is how somebody says they would rather keep reading - the panel
     * falls back to a band, the messages come back, and they are still in the
     * call and still being heard.
     *
     * Held per screen rather than as one flag, because putting away what one
     * person is showing says nothing about the next person who shares. Keys
     * whose share has ended are dropped as it ends, so somebody who stops
     * sharing and starts again is watched again - a decision about a share that
     * is over must not quietly hide the next one.
     */
    const [away, setAway] = useState<readonly string[]>([]);
    const sharedKeys = shared.map((stage) => stage.key).join("|");
    const [knownKeys, setKnownKeys] = useState(place === "direct" ? "" : sharedKeys);
    if (knownKeys !== sharedKeys) {
        const before = knownKeys.length > 0 ? knownKeys.split("|") : [];
        setKnownKeys(sharedKeys);
        setAway((was) => {
            const kept = stillShared(was, shared);
            // In a direct message a screen is offered rather than taken. The
            // panel there is a band over the conversation it was started from,
            // so a screen arriving into it takes the whole thing before anybody
            // has said they want to watch anything - and the way back was a
            // control that only exists once it has already happened. Everywhere
            // else there is room to spare and a share goes straight up.
            //
            // Not this browser's own: somebody who just pressed Share knows what
            // they shared, and offering it back to them as something to open is
            // a question with one answer.
            if (place !== "direct") return kept;
            const offered = arrivedKeys(before, shared).filter((key) => key !== LOCAL_SCREEN_KEY);
            return [...kept, ...offered.filter((key) => !kept.includes(key))];
        });
    }
    /** What is left to draw, which is what the rest of the room is built from:
     *  a screen put away is not on the stage, does not hold the panel open and
     *  does not push the faces into a strip. */
    const stages = watched(shared, away);
    /**
     * The screens this reader put away that are still going out.
     *
     * Not "everything not on the stage": a share that has ended is gone from the
     * room altogether, and a card about one would be a card about something that
     * is no longer happening. These are the ones still being shared, by somebody
     * who cannot tell they are being ignored - which is the whole reason they get
     * a card instead of disappearing.
     */
    const putAway = putAwayOf(shared, away);

    /** Tell the call's audio which streams are being watched, so their sound
     *  plays - see `call-stream-audio`. */
    const stageKeys = stages.map((stage) => stage.key).join("|");
    useEffect(() => {
        setWatchedStreams(stageKeys ? stageKeys.split("|") : []);
    }, [stageKeys]);

    /** What right-clicking a stream offers. Nothing on this browser's own
     *  screen, which is never played back here. */
    const streamMenu = (stage: CallStage): StreamMenuFor | undefined => {
        if (stage.key === LOCAL_SCREEN_KEY) return undefined;
        const seat = stage.key.slice("screen:".length);
        const person = admitted?.find((entry) => entry.id === seat);
        const watching = !away.includes(stage.key);
        return {
            name: stage.name,
            person: person?.userId ?? seat,
            streamKey: stage.key,
            stream: stage.stream,
            hasSound: stage.stream.getAudioTracks().length > 0,
            watching,
            onWatch: () =>
                setAway((was) =>
                    watching ? [...was, stage.key] : was.filter((key) => key !== stage.key)
                )
        };
    };
    /** A share offered rather than shown, as a card the size of a face. */
    const offer = (stage: CallStage, className: string) => (
        <StreamCard
            key={stage.key}
            name={stage.name}
            className={className}
            onWatch={() => setAway((was) => was.filter((key) => key !== stage.key))}
            menu={streamMenu(stage)}
        />
    );
    /** Everybody in the call, drawn as faces. */
    const faces = () => (
        <>
            <Face
                name={ownName}
                label={you}
                personId={mine?.userId ?? viewerId ?? null}
                speaking={
                    call.participantId !== null &&
                    call.speaking.has(call.participantId) &&
                    call.micOn
                }
                muted={!call.micOn}
                deafened={call.deafened}
                sharing={call.sharing}
                hand={call.handRaised}
                handPlace={
                    queued && call.participantId ? (places.get(call.participantId) ?? null) : null
                }
                reactions={reactionsFor(call.participantId)}
                sameRoom={call.audioRole !== null}
            />
            {(admitted ?? [])
                .filter((person) => person.id !== call.participantId)
                .map((person) => (
                    <Face
                        key={person.id}
                        name={person.name}
                        personId={person.userId ?? null}
                        guest={person.guest}
                        speaking={call.speaking.has(person.id)}
                        muted={call.states.get(person.id)?.muted}
                        deafened={call.states.get(person.id)?.deafened}
                        sharing={call.screens.has(person.id)}
                        hand={call.states.get(person.id)?.hand}
                        handPlace={queued ? (places.get(person.id) ?? null) : null}
                        reactions={reactionsFor(person.id)}
                        {...combining(person.id)}
                        {...moderating(person.id)}
                        hosting={hostSeat?.(person.id)}
                        // The same key a tile uses, so turning somebody down in a
                        // conversation and turning them down in a room are the
                        // one decision: their account where they have one, their
                        // seat where they do not.
                        volumeKey={person.userId ?? person.id}
                    />
                ))}
        </>
    );
    const cameraKeys = (admitted ?? []).map((person) => `camera:${person.id}`);
    const live =
        focused && [...stages.map((stage) => stage.key), ...cameraKeys].includes(focused)
            ? focused
            : null;
    /**
     * The streams drawn as tiles among the people rather than above them.
     *
     * In a direct message a watched stream sits beside the person sharing it,
     * the size of a face, until somebody asks to see it bigger - which is how
     * every voice client draws a call between a few people, and leaves everybody
     * on screen while it is watched. Everywhere else a share goes up above the
     * faces, where a room has the space to give it.
     */
    const inlineStreams = place === "direct" && live === null ? stages : [];
    /** What the room is built around right now - see `stagingOf`, which is where
     *  the reasoning lives. */
    const { showing, staged, enlarged } = stagingOf(inlineStreams.length > 0 ? [] : stages, live);

    /**
     * Whether there is a camera sending anywhere in this call, this browser's
     * own included - the picture somebody checks their own framing in is as much
     * a picture as anybody else's.
     *
     * Asked of the tracks rather than of a flag, because for everybody else
     * there is no flag to ask: nothing is announced about a camera, and a
     * participant is only given a stream while something of theirs is live - see
     * `resort` in `use-sfu-call`. A track that has arrived but is not yet
     * carrying frames counts too, since the tile it lands in draws their face
     * until it does, which is the wait the faces cannot draw at all.
     */
    const pictures =
        call.cameraOn ||
        [...call.remote.values()].some((stream) => stream.getVideoTracks().length > 0);

    /** Whether the people in this call are drawn as faces rather than as tiles -
     *  see `call-band`, which owns both of the questions `place` answers and is
     *  where the reasoning lives. */
    const bareFaces = callBareFaces(place, staged, pictures || inlineStreams.length > 0);
    /** How a direct message's call is laid out around what is being watched -
     *  see `directLayout` in `call-band`, which is where the reasoning lives. */
    const layout = place === "direct" ? directLayout(stages.length > 0, expanded, enlarged) : null;
    /**
     * Whether the people are drawn under whatever is being watched.
     *
     * Everywhere with room for it, yes - a strip of faces under a shared screen
     * is how anybody knows who is still there. In a direct message the panel is
     * a band a few hundred pixels tall, and a screen worth opening plus a strip
     * of heads under it leaves neither of them a usable size: the screen is the
     * thing somebody asked to see bigger, so it gets the band, and the faces come
     * back the moment it is let go of. Expanded, there is room for both, and the
     * people are a row under the stream.
     */
    const peopleShown = place === "direct" ? !staged || layout === "stream-over-people" : !enlarged;
    /** Offered shares sit among the people, first, rather than in a row above
     *  them. Only where the people are drawn in the main area. */
    const offersInline = place === "direct" && peopleShown;
    /** Every tile in the people grid: your own, everybody else's, and the
     *  shares offered among them. */
    const tileCount =
        1 +
        (admitted ?? []).filter((person) => person.id !== call.participantId).length +
        (offersInline ? putAway.length : 0) +
        inlineStreams.length;
    /** Gap between tiles, in pixels: `gap-2`. */
    const tiles = useTileFit<HTMLDivElement>(tileCount, 8);
    /** In the band, a stream asked for by name is all there is: pressing it
     *  again puts it back among the people, which is the way back to say. */
    const letGo = layout === "stream" && !expanded;

    /**
     * The middle size, on the picture itself.
     *
     * A picture worth watching has three sizes and only the outer two were
     * reachable from it: the size the call gives it, and the whole display. The
     * step between them - the call taking the column, the conversation put away
     * behind it - existed but lived in a chevron at the top of the panel, which
     * is not where somebody looking at a screen they cannot read is looking.
     *
     * So it is offered on the picture, beside the other two, wherever there is a
     * column to take: a voice room is already the column, and has none to give.
     */
    const column: { grown?: boolean; onGrow?: () => void } = onExpand
        ? { grown: expanded, onGrow: () => onExpand(!expanded) }
        : {};

    /**
     * An expanded call that was watching something gives the column back when
     * there is nothing left to watch.
     *
     * Expanded for a stream, the call kept the whole column after the stream
     * ended or was put away - a column of empty call with the conversation hidden
     * behind it. Only on that change, though: a call somebody expanded with
     * nothing on the stage stays the size they asked for, and a face enlarged
     * and let go again is not a stream ending.
     */
    const watching = stages.length > 0;
    const seen = useRef({ watching, expanded: false });
    const expandedWatching = useRef(false);
    useEffect(() => {
        const before = seen.current;
        seen.current = { watching, expanded };
        if (expanded && !before.expanded) expandedWatching.current = watching;
        if (expanded && expandedWatching.current && before.watching && !watching) onExpand?.(false);
    }, [watching, expanded, onExpand]);

    /** A stream among the people is still a picture worth room: the band grows
     *  for it as it would for a stream above them. */
    const streamsAmongPeople = inlineStreams.length > 0;
    /** Said out loud rather than worked out again outside, because it is decided
     *  here: what is being watched turns on what somebody in this room asked
     *  for, and that is this component's own. */
    useEffect(() => {
        onStage?.(staged || streamsAmongPeople);
        return () => onStage?.(false);
    }, [onStage, staged, streamsAmongPeople]);

    // The call ending under somebody - the host closing it, or the last other
    // person leaving a one-to-one - is the case that most needs a sound: the
    // screen they are looking at is not this one.
    //
    // Which is exactly why the dashboard sounds it from the provider instead,
    // where it is heard wherever the reader is standing. This is left for the
    // guest page, which has no provider and no other screen to be on.
    const held = useHeldCall();
    /** Whether this screen may start a recording at all: the host - or, in a
     *  conversation of equals, anybody in it - in a browser that can record
     *  video, with the call held above it. The guest page has no provider and
     *  nowhere to put what it would make. */
    const canRecord =
        (canShare || (Boolean(viewerId) && mayRecord)) && held !== null && held.recording.supported;
    // `mayRecord` is the conversation being a direct message or a group, and
    // `canShare` being its host: `mayRecordCall` in `lib/chat/call-remote` is
    // the same rule, asked by the server for a deck's record key.
    const mayAdd = Boolean(viewerId) && (mayInvite || canShare);
    const callItems = (canRecord && !call.recording) || mayAdd || Boolean(moreItems);
    const wasEnded = useRef(false);
    useEffect(() => {
        if (!held && call.ended && !wasEnded.current) playCallSound("hangUp");
        wasEnded.current = call.ended;
    }, [call.ended, held]);

    if (call.ended) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
                <p className="text-sm text-muted-foreground">{t("callRoom.theCallHasEnded")}</p>
                <Button size="sm" onClick={onLeave}>
                    {t("callRoom.close")}
                </Button>
            </div>
        );
    }

    return (
        // Clipped, because the band this is drawn in is capped and nothing in it
        // may paint over the conversation underneath - which is what a short
        // window with a notice up used to look like: the messages drawn under
        // the call's own rows.
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
            {/* What is not a control: raising a hand, bringing somebody in, and
                writing the call down. None of them is reached for mid-sentence,
                so they sit up here as icons and leave the bar at the bottom to
                the controls that are. Always drawn, because the hand is
                everybody's - a guest included. */}
            <div className="flex shrink-0 items-center justify-end gap-1">
                {/* A hand stays up until it is put down, and everybody who
                    joins later sees it. The number says how many are up, on
                    the button that is about hands; the strip below says
                    who. */}
                <button
                    type="button"
                    onClick={() => call.setHandRaised(!call.handRaised)}
                    aria-pressed={call.handRaised}
                    aria-label={
                        call.handRaised ? t("callRoom.lowerYourHand") : t("callRoom.raiseYourHand")
                    }
                    title={
                        call.hands.length > 0
                            ? t(
                                  call.handRaised
                                      ? "callRoom.handsUpLower"
                                      : "callRoom.handsUpRaise",
                                  {
                                      count: call.hands.length
                                  }
                              )
                            : t("callRoom.raiseYourHand")
                    }
                    className={cn(
                        "flex items-center gap-1 rounded p-1.5 transition-colors",
                        call.handRaised
                            ? "bg-warning-soft text-warning-ink hover:bg-warning-soft"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                >
                    <Hand className="size-4 shrink-0" />
                    {call.hands.length > 0 && (
                        <span aria-hidden className="text-xs font-semibold tabular-nums">
                            {call.hands.length}
                        </span>
                    )}
                </button>
                {/* Play a game together, like an activity in the call. Only
                    for an account: a guest holds no permission to play. */}
                {viewerId && <CallGamesButton activity={activity} />}
                {/* The band, made the whole column and back. Where a
                    watched stream gets the people in a row under it -
                    see `directLayout`. */}
                {onExpand && (
                    <button
                        type="button"
                        onClick={() => onExpand(!expanded)}
                        aria-pressed={expanded}
                        aria-label={
                            expanded ? t("callRoom.shrinkTheCall") : t("callRoom.expandTheCall")
                        }
                        title={
                            expanded
                                ? t("callRoom.shrinkTheCallTheConversation")
                                : t("callRoom.expandTheCallToThe")
                        }
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        {expanded ? (
                            <ChevronsUp className="size-4" />
                        ) : (
                            <ChevronsDown className="size-4" />
                        )}
                    </button>
                )}
                {/* A recording running, said up here and nowhere bigger: the
                    time on the button that stops it for whoever is recording,
                    a red mark for everybody else. What it means is in its
                    title rather than in a banner taking the room's height. */}
                {call.recording ? (
                    <button
                        type="button"
                        onClick={() => held?.recording.stop()}
                        aria-pressed
                        aria-label={t("callRoom.stopRecording")}
                        // What does not move. The time runs in the button
                        // itself; a tooltip carrying it changed every second,
                        // and a browser hides one whose text changes.
                        title={t("callRoom.youAreRecordingThisCall")}
                        className="flex items-center gap-1.5 rounded border border-danger-edge bg-danger-soft px-2 py-1 text-danger transition-colors hover:border-danger"
                    >
                        <Circle
                            aria-hidden
                            className="size-2.5 shrink-0 fill-current motion-safe:animate-pulse"
                        />
                        <span className="text-xs font-medium tabular-nums">
                            {clock(held?.recording.seconds ?? 0)}
                        </span>
                        <Square aria-hidden className="size-3 shrink-0 fill-current" />
                    </button>
                ) : (
                    recorded && (
                        <span
                            role="status"
                            title={t("callRoom.recordedBy", { name: recordedBy })}
                            className="flex items-center gap-1.5 rounded border border-danger-edge bg-danger-soft px-2 py-1 text-xs font-medium text-danger"
                        >
                            <Circle aria-hidden className="size-2.5 shrink-0 fill-current" />
                            <span className="sr-only">
                                {t("callRoom.recordedBy", { name: recordedBy })}
                            </span>
                            <span aria-hidden>{t("callRoom.recShort")}</span>
                        </span>
                    )
                )}
            </div>

            {/* What the call says about itself, as one line. These used to be a
                stack of banners, and when the call server went four of them took
                the height the pictures and the controls needed - three of them
                that same fault seen from the microphone. See `call-notice-strip`. */}
            <CallNoticeStrip order={notices} />

            <CombineStrip call={call} />

            {/* Who has asked to speak, and in what order. Here rather than only
                on the faces because a hand raised in a grid of eight thumbnails
                is a hand nobody sees - see `call-hands-panel`. */}
            <HandStrip call={call} />

            {/* A game somebody started in the call: offered to the others, and
                played here by whoever joined. */}
            {viewerId && <CallGamesPanel activity={activity} />}

            {waiting && waiting.length > 0 && (
                <ul className="flex flex-col gap-1">
                    {waiting.map((person) => (
                        <li
                            key={person.id}
                            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                        >
                            <span className="min-w-0 flex-1 truncate">
                                {t.rich("callRoom.wantsToJoin", {
                                    name: person.name,
                                    who: (chunks) => (
                                        <span key="who" className="font-medium">
                                            {chunks}
                                        </span>
                                    ),
                                    rest: (chunks) => (
                                        <span key="rest" className="text-muted-foreground">
                                            {chunks}
                                        </span>
                                    )
                                })}
                            </span>
                            <button
                                type="button"
                                aria-label={t("callRoom.letIn", { name: person.name })}
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
                                aria-label={t("callRoom.turnAway", { name: person.name })}
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

            {/* Whether to watch what is being shared.

                Somebody putting a screen up decides how much room the call
                takes on everybody else's screen, and on a small one that is all
                of it - the panel grows for the picture and the conversation
                underneath goes with it. This is the way out that is not leaving
                the call: put the screen away, the band shrinks back, the
                messages return, and the talking carries on.

                Offered per screen and only while there is one, and named for the
                screen as well as for the act, because with two people sharing
                "stop watching" has to say which.

                Only what is being watched. A screen that was put away has a card
                of its own below, carrying the same name and the same way back -
                and this row used to carry one too, so the two sat one above the
                other offering the identical act twice. What is watched is turned
                off here; what is not is turned back on there. Which is also why
                this is a plain button rather than a toggle: pressing it does not
                flip a state in place, it hands the screen to the card below and
                leaves the row, and a pressed state that never changes on a
                control that disappears is read out as the opposite of what
                happened. */}
            {stages.length > 0 && (
                <ul className="flex shrink-0 flex-wrap items-center gap-1">
                    {stages.map((stage) => (
                        <li key={stage.key}>
                            <button
                                type="button"
                                onClick={() => setAway((was) => [...was, stage.key])}
                                aria-label={t("callRoom.stopWatching", { name: stage.name })}
                                title={t("callRoom.stopWatchingHint", { name: stage.name })}
                                className="flex max-w-52 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground transition-colors"
                            >
                                <Eye className="size-3.5 shrink-0" />
                                <span className="truncate">{stage.name}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {/* A share somebody put away, said out loud rather than left to
                vanish.

                Putting one away removes it from the room - that is what gives
                the conversation its space back - but it also removed every trace
                that it was still happening, so a screen somebody was told about
                a minute ago simply was not there, and the person sharing had no
                way to know nobody was looking. Every client with screens in it
                keeps a tile for the stream with the way back on it; this is
                that, at the size of a line rather than a picture, because the
                reason it was put away was that pictures were taking the room. */}
            {/* Two shapes, because in a direct message these are not the same
                thing. Everywhere else this list is what is left after somebody
                decided they would rather have the room back, and a line is the
                right size for a decision already made. In a direct message a
                share arrives here instead of on the stage, so the same list is
                an offer nobody has answered yet - and an offer reads as a card
                beside the people, the way every client draws one, rather than as
                a row of small print above them. */}
            {putAway.length > 0 && !offersInline && (
                <ul
                    className={cn(
                        "shrink-0",
                        place === "direct"
                            ? "flex flex-wrap items-stretch gap-2"
                            : "flex flex-col gap-1.5"
                    )}
                >
                    {putAway.map((stage) =>
                        place === "direct" ? (
                            <li key={stage.key}>{offer(stage, "h-24 w-40")}</li>
                        ) : (
                            <MaybeStreamMenu key={stage.key} menu={streamMenu(stage)}>
                                <li className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded bg-background">
                                        <EyeOff
                                            className="size-4 text-muted-foreground"
                                            aria-hidden
                                        />
                                    </span>
                                    <span className="flex min-w-0 flex-col">
                                        <span
                                            className="truncate text-sm font-medium"
                                            title={stage.name}
                                        >
                                            {stage.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {t("callRoom.stillSharingYouAreNot")}
                                        </span>
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setAway((was) => was.filter((key) => key !== stage.key))
                                        }
                                        className="ml-auto shrink-0 rounded-md border border-border-strong bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-card-hover"
                                    >
                                        {t("callRoom.watch")}
                                    </button>
                                </li>
                            </MaybeStreamMenu>
                        )
                    )}
                </ul>
            )}

            {/* The screens, which are the thing everybody is looking at while
                they are there. Above the faces and across the whole width rather
                than in a tile the size of a head: a shared screen is usually
                text, and text in a ninth of a window is not readable. Side by
                side when there are several, rather than stacked - two shares
                stacked in a panel this tall leave each of them a strip. */}
            {showing.length > 0 && (
                <div
                    className={cn(
                        "grid min-h-0 min-w-0 flex-[3] gap-2",
                        gridColumns(showing.length)
                    )}
                >
                    {showing.map((stage) => (
                        <Tile
                            key={stage.key}
                            stream={stage.stream}
                            name={stage.name}
                            personId={null}
                            focused={letGo || live === stage.key}
                            onFocus={() => focus(stage.key)}
                            backLabel={letGo ? t("callRoom.backToThePeople") : undefined}
                            {...column}
                            screen
                            // A shared screen is usually text, and the reason
                            // anybody stares at one is to read a line of it.
                            zoomable
                            volumeKey={undefined}
                            streamMenu={streamMenu(stage)}
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
                            name={ownName}
                            label={you}
                            personId={mine?.userId ?? viewerId ?? null}
                            own
                            mirrored={call.mirrored}
                            focused
                            onFocus={() => focus(live)}
                            {...column}
                            cameraOff={!call.cameraOn}
                            muted={!call.micOn}
                            deafened={call.deafened}
                            hand={call.handRaised}
                            handPlace={
                                queued && call.participantId
                                    ? (places.get(call.participantId) ?? null)
                                    : null
                            }
                        />
                    ) : (
                        (() => {
                            const personId = live.slice("camera:".length);
                            const person = admitted?.find((entry) => entry.id === personId);
                            return (
                                <Tile
                                    stream={call.remote.get(personId) ?? null}
                                    name={person?.name ?? t("callRoom.somebody")}
                                    personId={person?.userId ?? null}
                                    guest={person?.guest}
                                    focused
                                    onFocus={() => focus(live)}
                                    {...column}
                                    muted={call.states.get(personId)?.muted}
                                    deafened={call.states.get(personId)?.deafened}
                                    speaking={call.speaking.has(personId)}
                                    recording={call.states.get(personId)?.recording}
                                    hand={call.states.get(personId)?.hand}
                                    handPlace={queued ? (places.get(personId) ?? null) : null}
                                    reactions={reactionsFor(personId)}
                                    volumeKey={person?.userId ?? personId}
                                    {...combining(personId)}
                                    {...moderating(personId)}
                                    hosting={hostSeat?.(personId)}
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
            {/* Bounded and scrolled, the way both tile layouts already are. A
                row of faces that cannot shrink is the one child of a capped band
                that can grow past it: eight people in a group call wrap to a
                second row, and that row plus the control bar under it spill over
                the conversation the band exists to leave room for - taking the
                Leave button with them, which is the failure the comment below
                the bar already records. */}
            {peopleShown && bareFaces && (
                <ul className="flex min-h-0 flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-3 overflow-y-auto overscroll-contain py-1">
                    {offersInline &&
                        putAway.map((stage) => (
                            <li key={stage.key} className="shrink-0">
                                {offer(stage, "h-24 w-40")}
                            </li>
                        ))}
                    {faces()}
                </ul>
            )}

            {peopleShown && !bareFaces && (
                <div
                    ref={staged ? undefined : tiles.ref}
                    style={
                        !staged && tiles.fit.width > 0
                            ? ({
                                  "--tile-w": `${tiles.fit.width}px`,
                                  "--tile-h": `${tiles.fit.height}px`
                              } as React.CSSProperties)
                            : undefined
                    }
                    className={cn(
                        // Room inside the edges for the speaking ring, which is
                        // drawn outside a tile (ring-2): the strip scrolls
                        // sideways, which clips top and bottom too, and the ring
                        // of whoever was talking was cut in half.
                        "grid min-h-0 gap-2 p-0.5",
                        // A strip of thumbnails along the bottom while something
                        // has the room, and an even grid when nothing does.
                        // Scrolling sideways rather than shrinking further: eight
                        // faces on a phone, each a twelfth of a strip, are eight
                        // grey squares.
                        //
                        // As wide as its faces and centred under the screen,
                        // never wider than the panel. Centred with the box, not
                        // with justify-content: a centred track list that
                        // overflows hangs off both ends, and the left one
                        // cannot be scrolled to.
                        staged
                            ? "h-[6.25rem] w-max max-w-full shrink-0 self-center auto-cols-[9rem] grid-flow-col overflow-x-auto"
                            : tiles.fit.width > 0
                              ? // Wide tiles, as big as the panel allows, with a
                                // short last row centred under the others - the
                                // shape every voice channel has. Until the panel
                                // has been measured, the even grid stands in.
                                "flex flex-1 flex-wrap content-center justify-center [&>*]:h-[var(--tile-h)] [&>*]:w-[var(--tile-w)] [&>*]:flex-none"
                              : cn("flex-1", columns)
                    )}
                >
                    {offersInline &&
                        putAway.map((stage) =>
                            offer(
                                stage,
                                cn("size-full", (staged || tiles.fit.width === 0) && "min-h-24")
                            )
                        )}
                    {inlineStreams.map((stage) => (
                        <Tile
                            key={stage.key}
                            stream={stage.stream}
                            name={stage.name}
                            personId={null}
                            screen
                            onFocus={() => focus(stage.key)}
                            {...column}
                            zoomable
                            volumeKey={undefined}
                            streamMenu={streamMenu(stage)}
                        />
                    ))}
                    <Tile
                        stream={call.localStream}
                        name={ownName}
                        label={you}
                        personId={mine?.userId ?? viewerId ?? null}
                        own
                        mirrored={call.mirrored}
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
                        hand={call.handRaised}
                        handPlace={
                            queued && call.participantId
                                ? (places.get(call.participantId) ?? null)
                                : null
                        }
                        reactions={reactionsFor(call.participantId)}
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
                                sharing={call.screens.has(person.id)}
                                recording={call.states.get(person.id)?.recording}
                                hand={call.states.get(person.id)?.hand}
                                handPlace={queued ? (places.get(person.id) ?? null) : null}
                                reactions={reactionsFor(person.id)}
                                focused={live === `camera:${person.id}`}
                                onFocus={() => focus(`camera:${person.id}`)}
                                {...combining(person.id)}
                                {...moderating(person.id)}
                                hosting={hostSeat?.(person.id)}
                                // Their account where they have one, so turning
                                // somebody down holds across calls; their seat
                                // where they do not, which lasts as long as the
                                // seat.
                                volumeKey={person.userId ?? person.id}
                            />
                        ))}
                </div>
            )}

            {/* Grouped the way voice clients draw it: what you send, each with
                its menu; what you put in front of the room; and leaving, apart,
                so it is never the button pressed on the way to another. Never
                squeezed: it wraps to a second row on a narrow window, and a
                flex row that is allowed to shrink gives that second row away
                to the pictures above it - which is how the button somebody
                needed to leave the call ended up half off the panel. */}
            <div ref={bar} className="flex shrink-0 flex-wrap items-center justify-center gap-3">
                <div role="group" aria-label={t("callRoom.bar.media")} className={CLUSTER}>
                    <Split
                        label={call.micOn ? t("callRoom.mute") : t("callRoom.unmute")}
                        // Only a moderator lifts their own mute, so the button says
                        // who has it rather than offering to undo it.
                        title={
                            call.moderation.serverMuted || call.moderation.serverDeafened
                                ? t("callRoom.aModeratorMutedYou")
                                : call.deafened
                                  ? withKey(t("callRoom.youCannotHearAnybodyAnd"))
                                  : undefined
                        }
                        icon={
                            call.micOn && !call.deafened ? (
                                <Mic className="size-4" />
                            ) : (
                                <MicOff className="size-4" />
                            )
                        }
                        hint={micHint}
                        alert={
                            notices.mic
                                ? { reason: notices.mic.short, tone: notices.mic.severity }
                                : null
                        }
                        variant={call.micOn && !call.deafened ? "secondary" : "danger"}
                        pressed={!call.micOn}
                        onClick={call.toggleMic}
                        devices={call.microphones}
                        chosenId={call.microphoneId}
                        devicesLabel={t("callRoom.devices.microphone")}
                        onChoose={call.chooseMicrophone}
                        cleanMic={call.cleanMic}
                        onCleanMic={call.setCleanMic}
                        filterRunning={call.micFilter}
                        licensedOffered={call.licensedFilter}
                        // The call's own microphone, never a second one - see
                        // `MicLevelMeter`.
                        meter={call.localStream?.getAudioTracks()[0] ?? null}
                        sent={call.outgoing}
                        // Deafening and the output it silences live in this menu,
                        // beside the input, the way voice clients lay it out.
                        outputs={speakers}
                        deafen={{
                            on: call.deafened,
                            toggle: call.toggleDeafen,
                            title: deafenTitle
                        }}
                        voiceSettings={Boolean(viewerId)}
                    />

                    {/* Deafening, beside the microphone where voice clients put
                        it, rather than only in the microphone's menu and on a
                        key nobody can find - with its own menu of the outputs,
                        the way the microphone's lists the inputs. A moderator's
                        deafen is drawn locked, with who did it; the title is on
                        a wrapper because a disabled button gets no hover. */}
                    <span title={deafenTitle} className="inline-flex">
                        <Split
                            label={call.deafened ? t("callRoom.undeafen") : t("callRoom.deafen")}
                            title={deafenTitle}
                            icon={
                                call.deafened ? (
                                    <HeadphoneOff className="size-4" />
                                ) : (
                                    <Headphones className="size-4" />
                                )
                            }
                            variant={call.deafened ? "danger" : "secondary"}
                            pressed={call.deafened}
                            onClick={call.toggleDeafen}
                            disabled={call.moderation.serverDeafened}
                            devices={speakers.devices}
                            chosenId={speakers.chosenId}
                            devicesLabel={t("callRoom.outputDevice")}
                            onChoose={speakers.choose}
                            listOne
                        />
                    </span>

                    <Split
                        label={call.cameraOn ? t("callRoom.stopVideo") : t("callRoom.startVideo")}
                        icon={
                            call.cameraOn ? (
                                <Video className="size-4" />
                            ) : (
                                <VideoOff className="size-4" />
                            )
                        }
                        variant={call.cameraOn ? "success" : "secondary"}
                        pressed={!call.cameraOn}
                        onClick={call.toggleCamera}
                        devices={call.cameras}
                        chosenId={call.cameraId}
                        devicesLabel={t("callRoom.devices.camera")}
                        onChoose={call.chooseCamera}
                        ladder={CAMERA_LADDER}
                        quality={call.cameraQuality}
                        level={call.cameraLevel}
                        onQuality={call.setCameraQuality}
                        qualityLabel="Video quality"
                        mirrored={call.mirrored}
                        onMirror={call.flipCamera}
                        background={call.background}
                        onBackground={call.setBackground}
                        backgroundImage={call.backgroundImage}
                        onPickBackground={call.pickBackground}
                        onScene={call.chooseBackgroundScene}
                        backgroundRunning={call.backgroundRunning}
                        backgroundProblem={call.backgroundProblem}
                        look={call.look}
                        onLook={call.setLook}
                    />
                </div>

                <div role="group" aria-label={t("callRoom.bar.sharing")} className={CLUSTER}>
                    {/* Left out where it could only fail - every phone - rather
                        than offered and answered with an error. A share already
                        running is always given its stop. On a narrow bar it
                        moves into the menu at the end of this group. */}
                    {(!narrow || shareAsked) && (screenShareable || call.sharing) && (
                        <Split
                            hint={
                                shareAsked
                                    ? { text: t("callRoom.hints.shareAsked"), tone: "warn" }
                                    : null
                            }
                            label={
                                call.sharing
                                    ? t("callRoom.shareMenu.label")
                                    : t("callRoom.shareScreen")
                            }
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
                            // While a screen is going out the button opens
                            // its menu instead: stop, change what is shared,
                            // quality and sound.
                            pressMenu={
                                sharePress({
                                    sharing: call.sharing,
                                    canShare: screenShareable
                                }) === "menu" ? (
                                    <ShareStreamItems call={call} canShare={screenShareable} />
                                ) : undefined
                            }
                            // A screen is not a device to pick between: the browser's own
                            // picker does that, every time, and it is the only thing
                            // allowed to.
                            devices={[]}
                            chosenId={null}
                            devicesLabel={t("callRoom.devices.screen")}
                            onChoose={() => undefined}
                            ladder={SCREEN_LADDER}
                            quality={call.screenQuality}
                            level={call.screenLevel}
                            onQuality={call.setScreenQuality}
                            qualityLabel="Screen quality"
                        />
                    )}

                    {/* A reaction is over in three seconds, so it stays beside
                        the controls. The raised hand, which stays up until it is
                        put down, sits in the row at the top. */}
                    {!narrow && <ReactionMenu onReact={call.react} />}

                    {/* Sounds everybody hears - see `soundboard-picker`. Drawn
                        for every seat, disabled with the reason for one that may
                        not play. Its picker is anchored to its own button, so it
                        stays out even on a narrow bar. */}
                    <SoundboardButton meetingId={meetingId} call={call} />

                    {/* Everything not reached for mid-sentence: recording,
                        bringing somebody in, what the caller adds - a meeting's
                        doors - and, on a narrow bar, the rest of this group. */}
                    {(narrow || callItems || viewerId) && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="icon"
                                    variant="secondary"
                                    aria-label={t("callRoom.moreForThisCall")}
                                    title={t("callRoom.moreForThisCall")}
                                >
                                    <MoreHorizontal className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" side="top" className="w-72">
                                {narrow && !shareAsked && call.sharing && (
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <MonitorUp className="size-4 shrink-0" />
                                            {t("callRoom.shareMenu.label")}
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent className="w-64">
                                            <ShareStreamItems
                                                call={call}
                                                canShare={screenShareable}
                                            />
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                )}
                                {narrow && !shareAsked && screenShareable && !call.sharing && (
                                    <DropdownMenuItem onSelect={call.toggleShare}>
                                        <MonitorUp className="size-4 shrink-0" />
                                        {t("callRoom.shareScreen")}
                                    </DropdownMenuItem>
                                )}
                                {narrow && (
                                    <>
                                        <DropdownMenuSub>
                                            <DropdownMenuSubTrigger>
                                                <Smile className="size-4 shrink-0" />
                                                {t("callRoom.react")}
                                            </DropdownMenuSubTrigger>
                                            <DropdownMenuSubContent className="flex w-auto gap-1 p-1">
                                                <ReactionItems onReact={call.react} />
                                            </DropdownMenuSubContent>
                                        </DropdownMenuSub>
                                        {(callItems || viewerId) && <DropdownMenuSeparator />}
                                    </>
                                )}
                                {canRecord && !call.recording && (
                                    <DropdownMenuItem
                                        title={t("callRoom.writeThisCallToA")}
                                        onSelect={() => setAsking(true)}
                                    >
                                        <RecordGlyph />
                                        {t("callRoom.recordThisCall")}
                                    </DropdownMenuItem>
                                )}
                                {mayAdd && (
                                    <DropdownMenuItem onSelect={() => setInviting(true)}>
                                        <UserPlus className="size-4" />
                                        {mayInvite
                                            ? t("callRoom.addPeople")
                                            : t("callRoom.shareALinkToThis")}
                                    </DropdownMenuItem>
                                )}
                                {moreItems && (
                                    <>
                                        {((canRecord && !call.recording) || mayAdd) && (
                                            <DropdownMenuSeparator />
                                        )}
                                        {moreItems}
                                    </>
                                )}
                                {viewerId && (
                                    <>
                                        {callItems && <DropdownMenuSeparator />}
                                        <VoiceSettingsItem />
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>

                {/* Red and nothing else, as tall as the groups beside it (their
                    button, padding and frame) so it does not sit lower than them. */}
                <Button
                    variant="hangUp"
                    className="h-[2.625rem] w-[3.25rem] rounded-xl"
                    aria-label={t("callRoom.leaveTheCall")}
                    title={t("callRoom.leaveTheCall")}
                    onClick={() => {
                        // A held call sounds it as the provider lets go (`leave`
                        // in `call-session`), whichever control hung up; the
                        // guest page has no provider, so it is sounded here.
                        if (!held) playCallSound("hangUp");
                        onLeave();
                    }}
                >
                    <PhoneOff className="size-4" />
                </Button>
            </div>

            {viewerId && (mayInvite || canShare) && (
                <InviteToCallDialog
                    open={inviting}
                    // Whether people in Polaris may be picked. The link beside
                    // the picker is the host's own and answers to nothing here:
                    // it adds nobody to the conversation.
                    mayInvite={mayInvite}
                    forGroup={place === "direct"}
                    onOpenChange={setInviting}
                    meetingId={meetingId}
                    already={(admitted ?? [])
                        .map((person) => person.userId)
                        .filter((id): id is string => Boolean(id))}
                    // The link is a second way to do the same thing - bring
                    // somebody in - so it is offered where that is asked for
                    // rather than as a button of its own beside the microphone.
                    canShare={canShare}
                    guestToken={call.meeting?.guestToken ?? null}
                    onShared={call.refresh}
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
                        <DialogTitle>{t("callRoom.recordThisCall2")}</DialogTitle>
                        <DialogDescription>{t("callRoom.theRecordingIsMadeIn")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setAsking(false)}>
                            {t("callRoom.cancel")}
                        </Button>
                        <Button
                            onClick={() => {
                                setAsking(false);
                                held?.recording.start();
                            }}
                        >
                            <Circle aria-hidden className="size-3 fill-current text-danger" />
                            {t("callRoom.startRecording")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
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
    qualityLabel,
    mirrored,
    onMirror,
    meter,
    sent,
    background,
    onBackground,
    backgroundImage,
    onPickBackground,
    onScene,
    backgroundRunning,
    backgroundProblem,
    look,
    onLook,
    outputs,
    deafen,
    voiceSettings,
    title,
    hint,
    alert,
    disabled = false,
    listOne = false,
    pressMenu
}: {
    label: string;
    /** Rows the button itself opens instead of acting - the stream menu while a
     *  screen is going out. */
    pressMenu?: React.ReactNode;
    /** The control itself can't be pressed - a moderator's deafen. Its menu
     *  still opens: the device is the reader's to choose either way. */
    disabled?: boolean;
    /** Offer the menu for a single device too: the outputs, where seeing which
     *  one the call comes out of is the point even when there is only one. */
    listOne?: boolean;
    /** Something wrong with what this control sends, marked on it as a dot and
     *  said in its name - the microphone not being sent, picking nothing up,
     *  arriving too quiet. The sentence itself is in the call notices. */
    alert?: { reason: string; tone: "error" | "warning" | "info" } | null;
    /** A word drawn over the control while its state needs saying - "Muted",
     *  "Deafened" - or a warning that has to be seen now. */
    hint?: ControlHintText | null;
    /** What the tooltip says, where it is worth more words than the accessible
     *  name - deafening is the one that needs explaining. */
    title?: string;
    icon: React.ReactNode;
    /** How the button reads: a red tint for a microphone that is off, a
     *  green one for a camera that is on, primary for a screen being sent. */
    variant: "secondary" | "danger" | "success" | "primary";
    /** Microphone only: the outputs, and deafening - both in its menu, beside
     *  the input, rather than a third button of their own. */
    outputs?: ReturnType<typeof useSpeakers>;
    deafen?: { on: boolean; toggle: () => void; title: string };
    /** Whether the way to the devices screen is offered - only to somebody
     *  signed in, since a guest who follows it leaves the call for a sign-in. */
    voiceSettings?: boolean;
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
    /** Camera only: which way round your own picture is drawn for you. It lives
     *  in this menu because it is a fact about this camera, and it is the menu
     *  somebody opens when the picture looks wrong. */
    mirrored?: boolean;
    onMirror?: () => void;
    /** Microphone only: the track whose level the menu draws while it is open.
     *  Null while the call has no microphone open yet - the meter then stays
     *  empty rather than opening one of its own. */
    meter?: MediaStreamTrack | null;
    /** Microphone only: what the call is actually sending, after the noise
     *  model and the volume. Drawn as a second row when it is not the device
     *  itself, because a device that reads healthy and a voice that leaves
     *  quiet is exactly the case one row cannot show. */
    sent?: MediaStreamTrack | null;
    /** Camera only: what is drawn behind you, and the picture it uses when that
     *  is a picture. The six arrive together or none of them do. */
    background?: CameraBackground;
    onBackground?: (value: CameraBackground) => void;
    backgroundImage?: string | null;
    onPickBackground?: (file: File) => Promise<void>;
    onScene?: (scene: BackgroundScene) => void;
    /** What is actually being drawn, which for the seconds the model takes to
     *  arrive is not yet what was asked for. */
    backgroundRunning?: CameraBackground | null;
    backgroundProblem?: CameraProblem | null;
    /** Camera only: its light, colour and framing. */
    look?: CameraLook;
    onLook?: (patch: Partial<CameraLook>) => void;
}) {
    const t = useTranslations("chat");
    // The picker lives outside the menu on purpose: a menu that has closed has
    // unmounted its contents, and a file input that is chosen from after that is
    // an input nothing is listening to.
    const [chooseFiles, chooser] = useChooseFiles();
    const [pickProblem, setPickProblem] = useState<string | null>(null);

    /** Asks for a picture to sit behind you. */
    const askPicture = () =>
        void chooseFiles({ accept: "image/*", onFailed: setPickProblem }).then(([file]) => {
            if (!file || !onPickBackground) return;
            setPickProblem(null);
            void onPickBackground(file).catch((caught: unknown) =>
                setPickProblem(
                    caught instanceof Error ? caught.message : "Polaris could not use that picture."
                )
            );
        });
    /** Whether the picture in use is one of theirs rather than one of ours. */
    const ownPicture = Boolean(backgroundImage) && sceneOf(backgroundImage ?? null) === null;

    // Worth a menu for the setting alone: a machine with one microphone still
    // sits in a room with a fan in it, and a machine with one screen still has a
    // choice to make about how much of it to send.
    const hasMenu =
        devices.length > 1 ||
        (listOne && devices.length > 0) ||
        outputs !== undefined ||
        onCleanMic !== undefined ||
        onQuality !== undefined ||
        onBackground !== undefined ||
        onLook !== undefined ||
        onMirror !== undefined;
    const showing = ladder && level ? ladder.rungs[level] : null;
    const anchor = useRef<HTMLSpanElement>(null);
    const alertId = useId();

    return (
        <span ref={anchor} className="relative flex items-center">
            <ControlHint anchor={anchor} hint={hint ?? null} />
            {/* The icon alone. What it does is in the title and in the
                accessible name, which is where a person who needs the words
                looks and where a screen reader reads from - the shape is what
                everybody else has already learned from every other call they
                have been in. */}
            {pressMenu ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon"
                            variant={variant === "primary" ? "primary" : "secondary"}
                            disabled={disabled}
                            aria-label={label}
                            title={title ?? label}
                            className={cn(TINTS[variant], hasMenu && "rounded-r-none")}
                        >
                            {icon}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" side="top" className="w-64">
                        {pressMenu}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : (
                <Button
                    size="icon"
                    variant={variant === "primary" ? "primary" : "secondary"}
                    onClick={onClick}
                    disabled={disabled}
                    aria-pressed={pressed}
                    aria-label={label}
                    aria-describedby={alert ? alertId : undefined}
                    title={alert ? `${title ?? label}\n${alert.reason}` : (title ?? label)}
                    className={cn(TINTS[variant], hasMenu && "rounded-r-none")}
                >
                    {icon}
                </Button>
            )}
            {alert && (
                <>
                    <span id={alertId} className="sr-only">
                        {alert.reason}
                    </span>
                    <span
                        aria-hidden
                        className={cn(
                            "pointer-events-none absolute -left-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-background",
                            alert.tone === "error" ? "bg-danger" : "bg-warning"
                        )}
                    />
                </>
            )}
            {hasMenu && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon"
                            variant={variant === "primary" ? "primary" : "secondary"}
                            aria-label={t("callRoom.deviceSettings", { device: devicesLabel })}
                            title={t("callRoom.deviceSettings", { device: devicesLabel })}
                            className={cn("w-6 rounded-l-none", TINTS[variant])}
                        >
                            <ChevronUp className="size-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" side="top" className="max-w-72">
                        {/* Which device, as a row naming the one in use - the
                            list itself one step in, because it is chosen once
                            and read every time the menu opens. */}
                        {devices.length > 0 && (
                            <ChoiceSub
                                label={outputs ? t("callRoom.inputDevice") : devicesLabel}
                                current={nameOfDevice(devices, chosenId, t)}
                            >
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
                            </ChoiceSub>
                        )}
                        {onMirror && (
                            <>
                                <DropdownMenuItem onSelect={onMirror}>
                                    <Check
                                        className={cn(
                                            "size-3.5 shrink-0",
                                            mirrored ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    <span className="flex min-w-0 flex-col">
                                        <span>{t("callRoom.mirrorMyPicture")}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {t("callRoom.onlyHowYouSeeYourself")}
                                        </span>
                                    </span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                            </>
                        )}
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
                                        <span>{t("callRoom.automatic")}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {t("callRoom.dropsWhenTheConnectionStruggles")}
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
                                        <span>{t(showing.label)}</span>
                                        <span className="tabular-nums">
                                            {showing.detailKey
                                                ? t(showing.detailKey)
                                                : showing.detail}
                                        </span>
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
                                    <span className="flex items-center justify-between text-[0.6875rem] text-foreground-subtle">
                                        <span>{t("callRoom.leastData")}</span>
                                        <span>{t("callRoom.bestPicture")}</span>
                                    </span>
                                </DropdownMenuItem>
                            </>
                        )}
                        {onBackground && background && (
                            <>
                                <DropdownMenuLabel>{t("callRoom.background")}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {BACKGROUNDS.map((choice) => (
                                    <DropdownMenuItem
                                        key={choice.value}
                                        onSelect={(event) => {
                                            // With no picture chosen yet there
                                            // is nothing for this row to turn
                                            // on, so it asks for one instead.
                                            if (choice.value === "image" && !backgroundImage) {
                                                event.preventDefault();
                                                askPicture();
                                                return;
                                            }
                                            onBackground(choice.value);
                                        }}
                                    >
                                        <Check
                                            className={cn(
                                                "size-3.5 shrink-0",
                                                background === choice.value
                                                    ? "opacity-100"
                                                    : "opacity-0"
                                            )}
                                        />
                                        <span className="flex min-w-0 flex-col">
                                            <span>{t(choice.label)}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {t(choice.help)}
                                            </span>
                                        </span>
                                        {choice.value === "image" && backgroundImage && (
                                            <img
                                                src={backgroundImage}
                                                alt=""
                                                className="ml-auto size-8 shrink-0 rounded object-cover"
                                            />
                                        )}
                                    </DropdownMenuItem>
                                ))}
                                {/* The pictures themselves, because a list of
                                    words is not how anybody picks one. Kept in
                                    the menu rather than behind a dialog: this is
                                    two presses from the call bar and nothing
                                    about it is worth a screen of its own. */}
                                {onScene && (
                                    <DropdownMenuItem
                                        // The grid is a set of targets, not one
                                        // row: a press inside it is a choice
                                        // already made by the button under the
                                        // finger, and closing on the item as
                                        // well would fire this row's own select.
                                        onSelect={(event) => event.preventDefault()}
                                        className="flex-col items-stretch gap-1.5"
                                    >
                                        <span className="grid grid-cols-4 gap-1">
                                            {BACKGROUND_SCENES.map((scene) => (
                                                <button
                                                    key={scene.id}
                                                    type="button"
                                                    title={t(scene.label)}
                                                    aria-label={t(scene.label)}
                                                    aria-pressed={backgroundImage === scene.src}
                                                    onClick={() => onScene(scene)}
                                                    className={cn(
                                                        "overflow-hidden rounded border-2 transition-colors",
                                                        backgroundImage === scene.src
                                                            ? "border-primary"
                                                            : "border-transparent hover:border-border-strong"
                                                    )}
                                                >
                                                    <img
                                                        src={scene.thumb}
                                                        alt=""
                                                        className="aspect-video w-full object-cover"
                                                    />
                                                </button>
                                            ))}
                                            <button
                                                type="button"
                                                title={t("callRoom.useAPictureOfYour")}
                                                aria-label={t("callRoom.useAPictureOfYour")}
                                                aria-pressed={ownPicture}
                                                onClick={askPicture}
                                                className={cn(
                                                    "flex aspect-video items-center justify-center overflow-hidden rounded border-2 text-muted-foreground transition-colors",
                                                    ownPicture
                                                        ? "border-primary"
                                                        : "border-dashed border-border-strong hover:border-primary"
                                                )}
                                            >
                                                {ownPicture && backgroundImage ? (
                                                    <img
                                                        src={backgroundImage}
                                                        alt=""
                                                        className="size-full object-cover"
                                                    />
                                                ) : (
                                                    <ImagePlus className="size-3.5 shrink-0" />
                                                )}
                                            </button>
                                        </span>
                                    </DropdownMenuItem>
                                )}
                                {/* Said only while it is not yet true. The first
                                    background on a machine waits for a model to
                                    download, and a menu that looks like it did
                                    nothing is a menu somebody presses again. */}
                                {background !== "off" &&
                                    !pressed &&
                                    !backgroundProblem &&
                                    backgroundRunning !== background && (
                                        <p className="px-2 pb-1 text-xs text-muted-foreground">
                                            {t("callRoom.startingTheModelDownloadsOnce")}
                                        </p>
                                    )}
                                {backgroundProblem && (
                                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                                        {t("callRoom.noBackground", {
                                            problem: cameraProblemText(backgroundProblem, t)
                                        })}
                                    </p>
                                )}
                                {pickProblem && (
                                    <p className="px-2 pb-1 text-xs text-danger">{pickProblem}</p>
                                )}
                            </>
                        )}
                        {onLook && look && <CameraLookMenu look={look} onLook={onLook} />}
                        {onCleanMic && (
                            <ChoiceSub
                                label={t("callRoom.inputProfile")}
                                current={t(
                                    (NOISE_LEVELS.find((level) => level.value === cleanMic) ??
                                        NOISE_LEVELS[0])!.label
                                )}
                            >
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
                                            <span>{t(level.label)}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {t(level.help)}
                                            </span>
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                                {/* Said only when it differs from what was asked
                                    for. A line confirming that the thing you
                                    chose is the thing running is noise. */}
                                {cleanMic === "enhanced" && filterRunning === "light" && (
                                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                                        {t("callRoom.thisMachineIsRunningThe")}
                                    </p>
                                )}
                                {cleanMic === "licensed" && filterRunning !== "licensed" && (
                                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                                        {t("callRoom.theLicensedFilterDidNot")}
                                    </p>
                                )}
                            </ChoiceSub>
                        )}
                        {/* Where the call comes out. Only where the browser lets
                            a page choose - see `speaker-device`. */}
                        {outputs && outputs.devices.length > 0 && (
                            <ChoiceSub
                                label={t("callRoom.outputDevice")}
                                current={nameOfDevice(outputs.devices, outputs.chosenId, t)}
                            >
                                {outputs.devices.map((device) => (
                                    <DropdownMenuItem
                                        key={device.id}
                                        onSelect={() => outputs.choose(device.id)}
                                    >
                                        <Check
                                            className={cn(
                                                "size-3.5 shrink-0",
                                                device.id === outputs.chosenId
                                                    ? "opacity-100"
                                                    : "opacity-0"
                                            )}
                                        />
                                        <span className="truncate" title={device.label}>
                                            {device.label}
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                            </ChoiceSub>
                        )}
                        {/* How loud you go out, and whether the microphone
                            picked is hearing anything. Only measured while the
                            menu is open - see `MicLevelMeter`. */}
                        {meter !== undefined && (
                            <>
                                <DropdownMenuSeparator />
                                <MicVolumeItem />
                                <DropdownMenuLabel>{t("callRoom.inputLevel")}</DropdownMenuLabel>
                                <div className="px-2 pb-2">
                                    <MicLevelMeter track={meter} />
                                </div>
                                {sent && sent !== meter && (
                                    <>
                                        <DropdownMenuLabel>
                                            {t("callRoom.sentLevel")}
                                        </DropdownMenuLabel>
                                        <div className="px-2 pb-2">
                                            <MicLevelMeter track={sent} />
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                        {deafen && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    role="menuitemcheckbox"
                                    aria-checked={deafen.on}
                                    title={deafen.title}
                                    // Kept open, so the box is seen to take.
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        deafen.toggle();
                                    }}
                                >
                                    <span
                                        aria-hidden
                                        className={cn(
                                            "flex size-4 shrink-0 items-center justify-center rounded border",
                                            deafen.on
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-border-strong"
                                        )}
                                    >
                                        {deafen.on && <Check className="size-3 shrink-0" />}
                                    </span>
                                    {t("callRoom.deafen")}
                                </DropdownMenuItem>
                                {voiceSettings && <VoiceSettingsItem />}
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {chooser}
        </span>
    );
}

/** The bar's groups: one rounded tray each, the buttons inside it touching. */
/**
 * A group of controls on the call bar: one pill, and the buttons inside it draw
 * no edge of their own - only a background, and a neutral one only on hover, the
 * way voice clients draw it. Each button's own border was a second outline
 * inside the pill's. Made transparent rather than removed, so the button keeps
 * its size and nothing in the bar moves when it is hovered or changes state.
 */
const CLUSTER = cn(
    "polaris-control-nudge flex items-center gap-1 rounded-xl border border-border bg-muted/60 p-1",
    "[&_button]:border-transparent [&_button]:shadow-none",
    "[&_button.bg-muted]:bg-transparent [&_button.bg-muted:hover]:bg-card-hover [&_button.bg-muted:active]:bg-card-hover/80"
);

/** Below this the sharing group folds into its "more" menu. A phone, and the
 *  call drawn in a side panel, are both under it. */
const NARROW_BAR = 440;

/** The state a control is in, said as a tint over the neutral button - so a
 *  muted microphone reads red and a camera that is on reads green without
 *  either shouting the way a solid fill does. */
const TINTS: Record<"secondary" | "danger" | "success" | "primary", string | undefined> = {
    secondary: undefined,
    primary: undefined,
    // No hover colour of their own: the icon answers the pointer instead - see
    // `polaris-control-nudge` - so a red control does not read redder.
    danger: "border-danger-edge bg-danger-soft text-danger-ink hover:bg-danger-soft",
    success: "border-success-edge bg-success-soft text-success-ink hover:bg-success-soft"
};

/** Where the devices, the voice and the camera are set for good. */
const VOICE_SETTINGS = "/account/devices";

/** Whether the element is narrower than `below`, kept true to it as it resizes. */
function useNarrow(ref: React.RefObject<HTMLElement | null>, below: number): boolean {
    const [narrow, setNarrow] = useState(false);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const width = element.getBoundingClientRect().width;
        if (width > 0) setNarrow(width < below);
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setNarrow(entry.contentRect.width < below);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref, below]);
    return narrow;
}

/** The name of the device in use, or what the system picks when none is. */
function nameOfDevice(
    devices: readonly { id: string; label: string }[],
    chosenId: string | null,
    t: ReturnType<typeof useTranslations>
): string {
    return devices.find((device) => device.id === chosenId)?.label ?? t("callRoom.systemDefault");
}

/** A setting as one row naming its current value, its choices one step in. */
function ChoiceSub({
    label,
    current,
    children
}: {
    label: string;
    current: string;
    children: React.ReactNode;
}) {
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <span className="flex min-w-0 flex-col">
                    <span>{label}</span>
                    <span className="truncate text-xs text-muted-foreground" title={current}>
                        {current}
                    </span>
                </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-72">{children}</DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

/** The way to the devices screen, where all of this is set for every call. */
function VoiceSettingsItem() {
    const t = useTranslations("chat");
    return (
        <DropdownMenuItem asChild>
            <Link href={VOICE_SETTINGS}>
                <SlidersHorizontal className="size-4 shrink-0" />
                {t("callRoom.voiceSettings")}
            </Link>
        </DropdownMenuItem>
    );
}

/** Seconds as a clock reads them, for a recording that is running. */
function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What a stream's menu needs, less the thing it wraps. */
type StreamMenuFor = Omit<React.ComponentProps<typeof StreamMenu>, "children">;

/** A stream's menu around something, when it has one. */
function MaybeStreamMenu({
    menu,
    children
}: {
    menu: StreamMenuFor | undefined;
    children: React.ReactElement;
}) {
    return menu ? <StreamMenu {...menu}>{children}</StreamMenu> : children;
}

/**
 * A stream somebody is sharing that this reader is not watching yet.
 *
 * The whole card is the button: what somebody is reaching for is the screen,
 * and a target the size of a word inside a target the size of a card is the
 * smaller of the two. Right-clicking it offers the stream's own menu, so its
 * sound can be settled before it is opened.
 */
function StreamCard({
    name,
    className,
    onWatch,
    menu
}: {
    name: string;
    className: string;
    onWatch: () => void;
    menu?: StreamMenuFor;
}) {
    const t = useTranslations("chat");
    const card = (
        <button
            type="button"
            onClick={onWatch}
            title={t("callRoom.watchNamed", { name })}
            className={cn(
                "flex flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 text-center transition-colors hover:border-border-strong hover:bg-card-hover",
                className
            )}
        >
            <MonitorUp className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="w-full truncate text-xs font-medium">{name}</span>
            <span className="text-xs text-muted-foreground">{t("callRoom.watch")}</span>
        </button>
    );
    return <MaybeStreamMenu menu={menu}>{card}</MaybeStreamMenu>;
}

/**
 * One person in a call that is not a room.
 *
 * Everything a tile says about somebody is still said here, because it is all
 * still true: the ring while they are talking, the raised hand and its place in
 * the queue, what they reacted with, why they cannot be heard, and what
 * right-clicking them offers. What is dropped is the frame around it - which in
 * a call with the cameras off is a rectangle drawn around an avatar and nothing
 * else.
 *
 * No video, and nothing here has to hold one: a camera sending anywhere in the
 * call is a picture worth the room, so the room is back to tiles and the strip
 * before there is anything for a face to draw - see `callBareFaces`.
 */
function Face({
    name,
    label,
    personId,
    guest = false,
    speaking = false,
    muted = false,
    deafened = false,
    sharing = false,
    sameRoom = false,
    hand = false,
    handPlace = null,
    reactions = [],
    onCombine,
    onAskCombine,
    combineAsked = false,
    combineLocked = false,
    moderation,
    hosting,
    volumeKey
}: {
    name: string;
    /** What the plate says, when it is not the name - your own face says "You". */
    label?: string;
    personId: string | null;
    guest?: boolean;
    speaking?: boolean;
    muted?: boolean;
    deafened?: boolean;
    /** Sharing a screen: the LIVE mark beside the name. */
    sharing?: boolean;
    /** Whether this person is sitting in the same room as the reader, sharing
     *  one microphone between their devices - see `call-combine`. Said here for
     *  the reason a tile says it: otherwise they are somebody muted for no
     *  reason anybody can see. */
    sameRoom?: boolean;
    hand?: boolean;
    handPlace?: number | null;
    reactions?: readonly ShownReaction[];
    onCombine?: () => void;
    onAskCombine?: () => void;
    combineAsked?: boolean;
    combineLocked?: boolean;
    /** Mute, deafen and disconnect, for a reader who moderates the call. */
    moderation?: SeatModeration;
    /** Make host and remove, for the host of a meeting. */
    hosting?: SeatHosting;
    /** Who this face's volume is remembered against. Absent on your own, which
     *  has no volume to set - it is never played back. */
    volumeKey?: string;
}) {
    const t = useTranslations("chat");
    const [volume] = useCallVolume(volumeKey ?? "");

    const face = (
        <li className="flex w-20 shrink-0 flex-col items-center gap-1">
            <span className="relative">
                <Avatar
                    size={FACE_MAX}
                    person={{ id: personId, name }}
                    callBadge={deafened ? "deafened" : muted ? "muted" : null}
                    className={cn(
                        "transition-shadow duration-fast",
                        speaking && "ring-2 ring-success"
                    )}
                />
                {hand && (
                    <span
                        className="call-hand-up pointer-events-none absolute -left-1 -top-1 flex items-center gap-1 rounded-full bg-warning py-0.5 pl-1 pr-1.5 text-[0.6875rem] font-semibold text-warning-foreground shadow-sm"
                        aria-label={
                            handPlace
                                ? t("callRoom.handUpPlace", { place: handPlace })
                                : t("callRoom.handUp")
                        }
                    >
                        <Hand className="size-3.5 shrink-0" />
                        {handPlace !== null && <span>{handPlace}</span>}
                    </span>
                )}
                {reactions.length > 0 && (
                    <span
                        className="pointer-events-none absolute inset-x-0 -bottom-2 flex justify-center gap-1 text-xl"
                        aria-live="polite"
                    >
                        {reactions.map((shown) => (
                            <Cue key={shown.id} shown={shown} />
                        ))}
                    </span>
                )}
            </span>
            <span className="flex max-w-full items-center gap-1 text-xs">
                <span className="truncate">{label ?? name}</span>
                {sharing && <LiveBadge />}
                {/* Muted and deafened are on the face itself, the way a voice
                    channel shows them - see `callBadge`. */}
                {/* Said for the same reason a tile says it: somebody turned all
                    the way down is somebody this reader cannot hear, and with
                    nothing on screen saying so it reads as a person who has
                    stopped talking. */}
                {volumeKey && volume === 0 && (
                    <VolumeX
                        className="size-3 shrink-0 text-danger"
                        aria-label={t("callRoom.silencedForYou")}
                    />
                )}
                {sameRoom && (
                    <Users
                        className="size-3 shrink-0 text-primary"
                        aria-label={t("callRoom.sharingARoomSMicrophone")}
                    />
                )}
            </span>
            {guest && (
                <span className="text-[0.6875rem] text-muted-foreground">
                    {t("callRoom.guest")}
                </span>
            )}
        </li>
    );

    if (!volumeKey) return face;

    return (
        <PersonMenu
            name={name}
            volumeKey={volumeKey}
            onCombine={onCombine}
            onAskCombine={onAskCombine}
            combineAsked={combineAsked}
            combineLocked={combineLocked}
            moderation={moderation}
            hosting={hosting}
        >
            {face}
        </PersonMenu>
    );
}

function Tile({
    stream,
    name,
    label,
    personId,
    own = false,
    mirrored = false,
    zoomable = false,
    screen = false,
    guest = false,
    cameraOff = false,
    sharing = false,
    speaking = false,
    muted = false,
    deafened = false,
    sameRoom = false,
    recording = false,
    hand = false,
    handPlace = null,
    reactions = [],
    focused = false,
    onFocus,
    backLabel,
    grown = false,
    onGrow,
    onCombine,
    onAskCombine,
    combineAsked = false,
    combineLocked = false,
    streamMenu,
    moderation,
    hosting,
    volumeKey
}: {
    stream: MediaStream | null;
    name: string;
    /** What the plate says, when it is not the name - your own tile says "You". */
    label?: string;
    /** Whose picture to draw while there is no video. Their account where they
     *  have one; a guest falls back to initials, which is all there is of
     *  somebody who arrived on a link. */
    personId?: string | null;
    /** Yours. The only tile whose picture may be cropped to fill the frame,
     *  because it is the only one this browser knows the shape of. */
    own?: boolean;
    /** Draw it the way a mirror would. Your own tile only, and never what is
     *  sent - see `call-mirror`. */
    mirrored?: boolean;
    /** Whether the wheel pushes into this picture and it can be dragged around.
     *  For a shared screen, where reading one line of it is the whole reason
     *  anybody is looking. */
    zoomable?: boolean;
    /** Whether this tile is a shared screen rather than a person: it carries a
     *  screen beside its name and, over the picture, what it is arriving at
     *  and the LIVE mark - see `call-stream-format`. */
    screen?: boolean;
    guest?: boolean;
    cameraOff?: boolean;
    /** Whether this person is sharing a screen. Said on the tile because the
     *  screen itself is up on the stage, or put away, rather than in it - the
     *  LIVE mark every voice client puts beside somebody streaming. */
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
    /** Whether their hand is up. Drawn on the picture rather than only in a
     *  list, because the point of raising one is to be seen. */
    hand?: boolean;
    /** Where they stand in the queue of raised hands, counting from one, or null
     *  when there is only one hand up and a number would say nothing. */
    handPlace?: number | null;
    /** What they have reacted with in the last few seconds. Over the picture and
     *  gone again - see `call-signals`. */
    reactions?: readonly ShownReaction[];
    /** Whether this tile is the one filling the room right now. */
    focused?: boolean;
    /** Make this the big one, or put it back. Absent where there is nothing to
     *  enlarge - a tile with no picture in it. */
    onFocus?: () => void;
    /** What pressing a focused tile goes back to, said on the button. */
    backLabel?: string;
    /** Whether the call this picture is in has taken the whole column already. */
    grown?: boolean;
    /** Give the call the whole column - the conversation put away behind it - or
     *  hand it back. The middle of the three sizes a picture has, between the
     *  room the call gives it and the whole display. Absent where there is no
     *  column to take: a voice room is one, and a tile with nothing in it is not
     *  worth one. */
    onGrow?: () => void;
    /** Go quiet and listen through this person's device, and ask them to go
     *  quiet and listen through this one. Both absent once the two are already
     *  sharing a room, and on a tile that is not somebody else's. */
    onCombine?: () => void;
    onAskCombine?: () => void;
    combineAsked?: boolean;
    combineLocked?: boolean;
    /** Set on a stream somebody else is sharing: its right-click menu. */
    streamMenu?: StreamMenuFor;
    /** Mute, deafen and disconnect, for a reader who moderates the call. */
    moderation?: SeatModeration;
    /** Make host and remove, for the host of a meeting. */
    hosting?: SeatHosting;
    /** Who this tile's volume is remembered against. Absent on your own tile,
     *  which has no volume to set - it is never played back. */
    volumeKey?: string;
}) {
    const t = useTranslations("chat");
    const video = useRef<HTMLVideoElement>(null);
    const frame = useRef<HTMLDivElement | null>(null);
    /** The face in an empty tile, sized to the tile: a fixed one spilled over
     *  the name of every tile in a phone's grid. */
    const face = useFaceSize(frame);
    /** Pushing into the picture. Held for every tile and used by the ones that
     *  say so - a face in a grid of eight is not a thing anybody zooms. */
    const look = useZoomPan();
    /** Read for the name plate only. Changing it is the menu's, which is shared
     *  with the faces - see `PersonMenu`. */
    const [volume] = useCallVolume(volumeKey ?? "");

    /**
     * The picture's shape and the tile's, as width over height.
     *
     * Read from the video itself, and again whenever it changes size - a phone
     * turned on its side, a camera swapped, a quality step - because the tile
     * decides from them whether your own picture is trimmed to fill it or shown
     * whole. See `fillsTile`.
     */
    const [pictureShape, setPictureShape] = useState<number | null>(null);
    const [tileShape, setTileShape] = useState<number | null>(null);
    useEffect(() => {
        const node = frame.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            const box = entry?.contentRect;
            setTileShape(box && box.height > 0 ? box.width / box.height : null);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    const onShape = (element: HTMLVideoElement) => {
        const { videoWidth, videoHeight } = element;
        const picture = videoHeight > 0 ? videoWidth / videoHeight : null;
        setPictureShape(picture);
        if (!zoomable) return;
        const box = frame.current?.getBoundingClientRect();
        look.measure(picture, box && box.height > 0 ? box.width / box.height : null);
    };

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
    const format = useStreamFormat(video, screen && !blank);

    const tile = (
        <div
            ref={(node) => {
                frame.current = node;
                if (zoomable) look.frameRef(node);
            }}
            {...(zoomable ? look.frameProps : {})}
            className={cn(
                "group/tile relative min-h-0 overflow-hidden rounded-lg bg-elevated ring-1 transition-shadow duration-fast",
                // Two rings rather than a thicker one: a border that appears and
                // disappears would move everything inside the tile by two pixels
                // every time somebody drew breath.
                // Talking wins the ring, because it is about this second and a
                // hand is about the next minute - and the badge below says the
                // hand loudly enough on its own. Otherwise a raised hand takes
                // it: across a grid of eight faces the ring is what the eye
                // actually finds.
                speaking ? "ring-2 ring-success" : hand ? "ring-2 ring-warning" : "ring-border",
                zoomable && look.zoomed && "cursor-grab active:cursor-grabbing"
            )}
        >
            <video
                ref={video}
                autoPlay
                playsInline
                muted
                // No transition on this. It is dragged and wheeled, and an eased
                // transform lags a finger by its own duration.
                style={zoomable ? { transform: look.transform } : undefined}
                onLoadedMetadata={(event) => onShape(event.currentTarget)}
                // Fired when the picture changes size mid-stream: a phone turned
                // upright, a camera swapped, a quality step.
                onResize={(event) => onShape(event.currentTarget)}
                className={cn(
                    zoomable && "origin-center will-change-transform",
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
                    // And never stretched: both keep the picture's own shape. Your
                    // own is trimmed only when its shape is near the tile's - an
                    // upright phone in a wide tile is shown whole rather than cut
                    // down to a strip across the face. See `fillsTile`.
                    own && fillsTile(pictureShape, tileShape) ? "object-cover" : "object-contain",
                    // Yours only. Everybody else's picture is already the right
                    // way round for the person watching it, and flipping what
                    // goes out would turn the writing on your shirt backwards
                    // for them.
                    mirrored && "-scale-x-100",
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
                        size={face}
                        person={{ id: personId ?? null, name }}
                        // In a call, so no presence dot - but no badge either:
                        // the name plate below says it.
                        callBadge={null}
                        className={cn(
                            "transition-shadow duration-fast",
                            speaking && "ring-2 ring-success"
                        )}
                    />
                </span>
            )}
            {reactions.length > 0 && (
                // Over the face rather than beside the name, because it is a
                // gesture about that person and it has three seconds to be seen.
                // `pointer-events-none` so it never eats the press that makes a
                // tile the big one.
                <span
                    className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center gap-1 text-2xl"
                    aria-live="polite"
                >
                    {reactions.map((shown) => (
                        <Cue key={shown.id} shown={shown} />
                    ))}
                </span>
            )}
            {hand && (
                // A badge on the picture rather than a twelve-pixel icon in the
                // name plate, which is where this was and where nobody saw it:
                // beside up to five other icons of the same size and colour, at
                // a ninth of a window, a raised hand read as another status
                // light. It is the one thing on a tile that is a person asking
                // for something, so it is the one thing drawn away from the rest
                // - top left, in the colour nothing else here uses, carrying its
                // place in the queue when there is a queue to be in.
                //
                // `pointer-events-none` so it never eats the press that makes a
                // tile the big one.
                <span
                    className="call-hand-up pointer-events-none absolute left-1 top-1 flex items-center gap-1 rounded-full bg-warning py-0.5 pl-1 pr-1.5 text-[0.6875rem] font-semibold text-warning-foreground shadow-sm"
                    aria-label={
                        handPlace
                            ? t("callRoom.handUpPlace", { place: handPlace })
                            : t("callRoom.handUp")
                    }
                >
                    <Hand className="size-3.5 shrink-0" />
                    {handPlace !== null && <span>{handPlace}</span>}
                </span>
            )}
            {/* One line, whatever the tile's width: a long name truncates
                rather than wrapping into a plate that covers the picture. */}
            <span className="absolute bottom-1 left-1 flex min-w-0 max-w-[calc(100%-0.5rem)] items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[0.6875rem]">
                {screen && <Monitor className="size-3 shrink-0" aria-hidden />}
                <span className="min-w-0 truncate" title={label ?? name}>
                    {label ?? name}
                </span>
                {/* Drawn because this person cannot be heard, yours included,
                    camera on or off. After the name rather than ahead of it:
                    ahead, muting pushed the name sideways every time, the jump
                    a voice client never makes. It used to sit on the face when the
                    camera was off, a badge on the circle that read as part of
                    the picture. Deafened wins the space: somebody who is not
                    listening is not reached by talking louder, and their
                    microphone being off follows from it anyway. */}
                {deafened ? (
                    <HeadphoneOff
                        className="size-3 shrink-0 text-danger"
                        aria-label={t("callRoom.notListening")}
                    />
                ) : muted ? (
                    <MicOff
                        className="size-3 shrink-0 text-danger"
                        aria-label={t("callRoom.microphoneOff")}
                    />
                ) : null}
                {guest && (
                    <span className="shrink-0 text-muted-foreground">{t("callRoom.guest")}</span>
                )}
                {sharing && <LiveBadge />}
                {volumeKey && volume === 0 && (
                    <VolumeX
                        className="size-3 shrink-0 text-danger"
                        aria-label={t("callRoom.silencedForYou")}
                    />
                )}
                {sameRoom && (
                    <Users
                        className="size-3 shrink-0 text-primary"
                        aria-label={t("callRoom.sharingARoomSMicrophone")}
                    />
                )}
                {recording && (
                    <Circle
                        className="size-3 shrink-0 fill-current text-danger"
                        aria-label={t("callRoom.recordingThisCall")}
                    />
                )}
            </span>

            {/* Three sizes, which is why they are three buttons. Bigger keeps the
                call around it - the other faces, the controls, the conversation -
                and is what somebody wants while a screen is being explained to
                them. The column is the call over the conversation, which is put
                away behind it: the size for reading somebody's screen without
                leaving Polaris, and the one that used to be missing here. Full
                screen is the whole display and nothing else, which is what they
                want when it is a film. */}
            {screen && !blank && (
                // What the share is arriving at and that it is live, top right
                // where every voice client puts it. Out of the way of the three
                // size buttons, which take the same corner on hover.
                // Each mark stays on one line; on a tile too narrow for both,
                // the LIVE mark moves under the format instead of either
                // breaking or running off the edge.
                <span className="pointer-events-none absolute right-1 top-1 flex max-w-[calc(100%-0.5rem)] flex-wrap items-center justify-end gap-1 transition-opacity group-focus-within/tile:opacity-0 group-hover/tile:opacity-0">
                    {format && (
                        <span className="whitespace-nowrap rounded bg-background/80 px-1 text-[0.625rem] font-bold leading-4 tabular-nums">
                            {t("callRoom.streamFormat", { height: format.height, fps: format.fps })}
                        </span>
                    )}
                    <LiveBadge />
                </span>
            )}
            {!blank && (
                <span className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/tile:opacity-100">
                    {onFocus && (
                        <button
                            type="button"
                            onClick={onFocus}
                            aria-label={
                                focused
                                    ? (backLabel ?? t("callRoom.backToTheGrid"))
                                    : t("callRoom.makeThisBigger")
                            }
                            title={
                                focused
                                    ? (backLabel ?? t("callRoom.backToTheGrid"))
                                    : t("callRoom.makeThisBigger")
                            }
                            className="rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {focused ? (
                                <Shrink className="size-3.5" />
                            ) : (
                                <Expand className="size-3.5" />
                            )}
                        </button>
                    )}
                    {onGrow && (
                        <button
                            type="button"
                            onClick={onGrow}
                            aria-pressed={grown}
                            aria-label={
                                grown
                                    ? t("callRoom.bringTheConversationBack")
                                    : t("callRoom.fillTheColumn")
                            }
                            title={
                                grown
                                    ? t("callRoom.shrinkTheCallTheConversation")
                                    : t("callRoom.fillTheColumnTheConversation")
                            }
                            className="rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {grown ? (
                                <ChevronsUp className="size-3.5" />
                            ) : (
                                <ChevronsDown className="size-3.5" />
                            )}
                        </button>
                    )}
                    {/* Only where the wheel already does it, and only once it
                        has been used: a button that says 1.0x is a button that
                        says nothing. */}
                    {zoomable && look.zoomed && (
                        <button
                            type="button"
                            onClick={look.reset}
                            aria-label={t("callRoom.fitThePictureAgain")}
                            title={t("callRoom.fitThePictureAgain")}
                            className="rounded bg-background/80 px-1.5 py-1 text-[0.625rem] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {look.zoom.scale.toFixed(1)}x
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={toggleFull}
                        aria-label={full ? t("callRoom.leaveFullScreen") : t("callRoom.fullScreen")}
                        title={full ? t("callRoom.leaveFullScreen") : t("callRoom.fullScreen")}
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

    if (streamMenu) return <MaybeStreamMenu menu={streamMenu}>{tile}</MaybeStreamMenu>;
    if (!volumeKey) return tile;

    return (
        <PersonMenu
            name={name}
            volumeKey={volumeKey}
            onCombine={onCombine}
            onAskCombine={onAskCombine}
            combineAsked={combineAsked}
            combineLocked={combineLocked}
            moderation={moderation}
            hosting={hosting}
        >
            {tile}
        </PersonMenu>
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
    mayInvite,
    canShare,
    guestToken,
    onShared,
    onDone,
    forGroup
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    meetingId: string;
    /** Whether whoever is brought in ends up in a group - a call in a direct
     *  message or a group, where only friends and colleagues may be picked. */
    forGroup: boolean;
    /** Who is in the call, so nobody is offered a person that picking would do
     *  nothing about. */
    already: readonly string[];
    /** Whether this reader may bring people in at all. False leaves the link,
     *  which is the host's own and adds nobody to the conversation. */
    mayInvite: boolean;
    /** Whether this reader may open the call to people with no account. The
     *  host's decision and nobody else's, so the section is simply absent for
     *  everybody else rather than drawn and refused. */
    canShare: boolean;
    /** The link's token, when one has already been opened. */
    guestToken: string | null;
    /** Told when a link is opened, so the call refreshes and everybody's copy
     *  of the meeting carries the token. */
    onShared: () => void;
    onDone: (movedTo: { meetingId: string; channelId: string } | null) => void;
}) {
    const t = useTranslations("chat");
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [opening, setOpening] = useState(false);

    // Built after mount rather than in the initial state: the address of the
    // page is not something a server render knows.
    useEffect(() => {
        setLink(guestToken ? `${window.location.origin}/m/${guestToken}` : null);
    }, [guestToken]);

    /** Open a link if there is not one yet, then put it on the clipboard. One
     *  press either way: "create a link" and "copy the link" are the same
     *  intention a moment apart. */
    const share = async () => {
        setOpening(true);
        setError("");
        let address = link;
        if (!address) {
            const result = await actions.setGuestLinkAction(meetingId, true, true);
            if (result.error) {
                setOpening(false);
                setError(result.error);
                return;
            }
            if (result.token) {
                address = `${window.location.origin}/m/${result.token}`;
                setLink(address);
                onShared();
            }
        }
        setOpening(false);
        if (!address) return;
        await navigator.clipboard.writeText(address).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

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
                    <DialogTitle>
                        {mayInvite ? t("callRoom.addPeople") : t("callRoom.anybodyWithALink")}
                    </DialogTitle>
                    <DialogDescription>
                        {mayInvite
                            ? t("callRoom.theirTelephoneRingsBringingSomebody")
                            : t("callRoom.onlyTheOwnerOfThis")}
                    </DialogDescription>
                </DialogHeader>

                {mayInvite && (
                    <ChatPeoplePicker
                        forGroup={forGroup}
                        meetingId={meetingId}
                        picked={picked}
                        onChange={setPicked}
                        exclude={already}
                    />
                )}

                {/* The other way to bring somebody in, for the people who
                    have no account here. Beside the picker rather than a button
                    of its own out on the call bar: it answers the same question
                    and is asked far less often. */}
                {canShare && (
                    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">
                                {t("callRoom.anybodyWithALink")}
                            </span>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={opening}
                                onClick={() => void share()}
                            >
                                <Link2 className="size-4" />
                                {link
                                    ? copied
                                        ? t("callRoom.copied")
                                        : t("callRoom.copyLink")
                                    : t("callRoom.createALink")}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {link
                                ? t("callRoom.anybodyWithItCanAsk")
                                : t("callRoom.forSomebodyWithNoAccount")}
                        </p>
                        {link && <MeetingLinkLimits meetingId={meetingId} />}
                    </div>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("callRoom.close")}
                    </Button>
                    {mayInvite && (
                        <Button disabled={busy || picked.length === 0} onClick={() => void bring()}>
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            {t("callRoom.add")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Whose screen it is, for the label over it. A participant who left mid-share
 *  is named as somebody rather than as nothing. */
function nameOf(
    people: readonly { id: string; name: string }[] | undefined,
    personId: string,
    somebody: string
): string {
    return people?.find((person) => person.id === personId)?.name ?? somebody;
}

/** Enough columns to keep the tiles roughly square at every size a call can
 *  reach. A lookup rather than a measurement: the room is capped at eight. */
function gridColumns(people: number): string {
    if (people <= 1) return "grid-cols-1";
    if (people <= 4) return "grid-cols-2";
    if (people <= 6) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}

/**
 * The reactions, behind one button.
 *
 * A menu rather than a row of six on the control bar: the bar already wraps to a
 * second line on a laptop, and six more buttons on it would push the one people
 * need most - leaving - off the end of it. A closed list rather than an emoji
 * picker, for the reason in `call-signals`: what is chosen here appears over
 * everybody else's picture.
 */
function ReactionMenu({ onReact }: { onReact: (reaction: Reaction) => void }) {
    const t = useTranslations("chat");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="icon"
                    variant="secondary"
                    aria-label={t("callRoom.react")}
                    title={t("callRoom.react")}
                >
                    <Smile className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top" className="flex w-auto gap-1 p-1">
                <ReactionItems onReact={onReact} />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The reactions themselves, for the button's menu and the narrow bar's. */
function ReactionItems({ onReact }: { onReact: (reaction: Reaction) => void }) {
    const t = useTranslations("chat");
    return REACTIONS.map((reaction) => (
        <DropdownMenuItem
            key={reaction}
            onSelect={() => onReact(reaction)}
            aria-label={t(`callRoom.reactions.${reaction}`)}
            title={t(`callRoom.reactions.${reaction}`)}
            className="justify-center px-2 text-lg"
        >
            {REACTION_GLYPHS[reaction]}
        </DropdownMenuItem>
    ));
}

/**
 * The microphone volume, in the menu somebody opens when they are told they are
 * quiet. The same setting as the devices screen's, and it applies to the call
 * while it runs - see `useSfuCall`.
 */
function MicVolumeItem() {
    const t = useTranslations("chat");
    const [gain, setGain] = useMicGain();
    return (
        <DropdownMenuItem
            // The menu would otherwise close on the press that moved the slider.
            onSelect={(event) => event.preventDefault()}
            className="flex-col items-stretch gap-1.5"
        >
            <span className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("micSettings.microphoneVolume")}</span>
                <span className="tabular-nums">{Math.round(gain * 100)}%</span>
            </span>
            <input
                type="range"
                min={GAIN_MIN * 100}
                max={GAIN_MAX * 100}
                step={5}
                value={Math.round(gain * 100)}
                aria-label={t("micSettings.microphoneVolume")}
                onChange={(event) => setGain(Number(event.target.value) / 100)}
                className="w-full accent-primary"
            />
        </DropdownMenuItem>
    );
}

/**
 * The record mark every recorder uses - a red dot inside a ring - so the button
 * reads as "record" before anybody hovers it. A bare ring, which is what this
 * was, is the shape of a radio button or an empty status, not of a recorder.
 * The ring takes the button's colour and the dot stays red: red marks what the
 * button does, not that it is already doing it.
 */
function RecordGlyph() {
    return (
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0">
            <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8" cy="8" r="3.75" className="fill-danger" />
        </svg>
    );
}

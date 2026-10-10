/**
 * A call in progress, as the screens that draw one receive it.
 *
 * The room is written against `CallState`, a plain shape, rather than against
 * the media server - so a call can be drawn from the state alone. The same state
 * draws all three kinds of call: the stand-up voice room (no cameras, the way a
 * voice room is used), a meeting with cameras on, and a call in a group chat.
 *
 * A camera here is a canvas with the person's fixture photo on it, sent as a
 * real video track: the room plays it through the same tile it plays a webcam in.
 */

import { CREW, TEAM, VIEWER, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { CallHold } from "@/app/(app)/chat/call-hold";
import type { CallRecording } from "@/app/(app)/chat/call-recorder";
import type { CallState, PeerState } from "@/app/(app)/chat/call-state";
import type { MeetingSummary } from "@/lib/chat/meetings";
import type { MeetingLine } from "@/lib/chat/meeting-chat";
import { GROUP_ID, VOICE_ID } from "./chat";

export const VOICE_CHANNEL_ID = VOICE_ID;
export const MEETING_ID = id("meeting", 2);
/** A meeting of its own, not held in any conversation. */
export const PLANNING_ID = id("meeting", 3);
/** The call in the group chat with Lena, Grace and Mateo. */
export const GROUP_CALL_ID = id("meeting", 4);

/** The seat each person sits in, which is what the room keys everything by. */
const seat = (n: number) => id("meeting-seat", n);

type Person = { readonly id: string; readonly name: string };

const nothing = (): void => undefined;

const cameras = new Map<string, MediaStream | null>();

/** A fixture camera for somebody: their photo filling a canvas, sent as a video
 *  track. The picture drifts and breathes a little, as a face in front of a
 *  webcam does; `index` sets each person apart so the tiles do not move in step.
 *  Made once per person, so a re-render does not restart the picture. */
function camera(person: Person, index: number): MediaStream | null {
    const known = cameras.get(person.id);
    if (known !== undefined) return known;
    if (typeof document === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) {
        return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const pen = canvas.getContext("2d")!;
    const photo = new Image();
    // The webcam framing of the same photo the avatar is cut from (faces/).
    photo.src = `/readme-media/camera/${person.id}`;
    const phase = index * 1.7;
    const draw = () => {
        pen.fillStyle = "#0b0f19";
        pen.fillRect(0, 0, 640, 360);
        if (!photo.complete || photo.naturalWidth === 0) return;
        const t = performance.now() / 1000 + phase;
        // Covers the frame at its smallest, then a slow lean in and out.
        const cover = Math.max(640 / photo.naturalWidth, 360 / photo.naturalHeight);
        const scale = cover * (1.06 + 0.015 * Math.sin(t * 0.7));
        const width = photo.naturalWidth * scale;
        const height = photo.naturalHeight * scale;
        const x = (640 - width) / 2 + 9 * Math.sin(t * 0.37);
        const y = (360 - height) / 2 + 5 * Math.sin(t * 0.53 + 1);
        pen.drawImage(photo, x, y, width, height);
    };
    draw();
    photo.onload = draw;
    // A canvas track only sends a frame when it is drawn on, so it is drawn on.
    setInterval(draw, 100);
    const stream = canvas.captureStream(10);
    cameras.set(person.id, stream);
    return stream;
}

/** One kind of call: who is in it, where, and what they have on. */
export interface CallShape {
    readonly meetingId: string;
    readonly channelId: string | null;
    readonly title: string;
    readonly people: readonly Person[];
    /** Whose cameras are on, the viewer's included. */
    readonly cameras?: readonly string[];
    /** Microphones off. */
    readonly muted?: readonly string[];
    /** Who is talking. */
    readonly speaking?: readonly string[];
    /** Hands up. */
    readonly hands?: readonly string[];
    readonly standalone?: boolean;
    readonly recording?: boolean;
}

export function standupShape(ctx: SceneContext): CallShape {
    return {
        meetingId: MEETING_ID,
        channelId: VOICE_CHANNEL_ID,
        title: ctx.say("standup", "daily"),
        people: [VIEWER, TEAM.ana, TEAM.priya, TEAM.kenji, TEAM.sam],
        muted: [TEAM.sam.id],
        speaking: [TEAM.ana.id]
    };
}

export function planningShape(ctx: SceneContext): CallShape {
    const people = [VIEWER, TEAM.ana, TEAM.kenji, TEAM.lena, CREW.grace, CREW.mateo];
    return {
        meetingId: PLANNING_ID,
        channelId: null,
        title: ctx.say("Sprint planning", "Planificación del sprint"),
        people,
        cameras: [VIEWER.id, TEAM.ana.id, TEAM.kenji.id, TEAM.lena.id, CREW.grace.id],
        muted: [CREW.mateo.id, TEAM.lena.id],
        speaking: [TEAM.kenji.id],
        hands: [CREW.grace.id],
        standalone: true
    };
}

export function groupShape(ctx: SceneContext): CallShape {
    return {
        meetingId: GROUP_CALL_ID,
        channelId: GROUP_ID,
        title: ctx.say("Call", "Llamada"),
        people: [VIEWER, TEAM.lena, CREW.grace, CREW.mateo],
        cameras: [TEAM.lena.id, CREW.grace.id],
        speaking: [CREW.grace.id],
        recording: true
    };
}

function peer(mic: PeerState["mic"], extra: Partial<PeerState> = {}): PeerState {
    return {
        mic,
        muted: mic === "muted",
        deafened: false,
        recording: false,
        hand: false,
        handAt: 0,
        group: null,
        ...extra
    };
}

export function callState(ctx: SceneContext, shape: CallShape = standupShape(ctx)): CallState {
    const has = (list: readonly string[] | undefined, who: string) => list?.includes(who) ?? false;
    const participants = shape.people.map((person, index) => ({
        id: seat(index + 1),
        userId: person.id,
        name: person.name,
        admission: "admitted" as const,
        guest: false,
        joinedAt: ago(ctx.now, 9 - index),
        serverMuted: false,
        serverDeafened: false
    }));
    const others = participants.slice(1);
    const states = new Map<string, PeerState>(
        others.map((person) => [
            person.id,
            peer(has(shape.muted, person.userId) ? "muted" : "on", {
                hand: has(shape.hands, person.userId),
                handAt: has(shape.hands, person.userId) ? ctx.now - 60_000 : 0
            })
        ])
    );
    const remote = new Map<string, MediaStream>();
    others.forEach((person, index) => {
        if (!has(shape.cameras, person.userId)) return;
        const stream = camera({ id: person.userId, name: person.name }, index + 1);
        if (stream) remote.set(person.id, stream);
    });
    const viewerCamera = has(shape.cameras, VIEWER.id) ? camera(VIEWER, 0) : null;
    return {
        meeting: {
            id: shape.meetingId,
            channelId: shape.channelId,
            hostId: VIEWER.id,
            title: shape.title,
            startedAt: ago(ctx.now, 9),
            ended: false,
            guestToken: null,
            approveGuests: false,
            requireAccount: false,
            scheduledAt: null,
            standalone: shape.standalone ?? false,
            mayModerate: true,
            participants
        },
        participantId: seat(1),
        localStream: viewerCamera,
        localScreen: null,
        remote,
        screens: new Map(),
        speaking: new Set(
            participants.filter((one) => has(shape.speaking, one.userId)).map((one) => one.id)
        ),
        states,
        micOn: true,
        cameraOn: viewerCamera !== null,
        hasCamera: true,
        sharing: false,
        deafened: false,
        moderation: { serverMuted: false, serverDeafened: false },
        ended: false,
        saidAt: 0,
        error: "",
        microphones: [
            { id: "default", label: ctx.say("Built-in microphone", "Micrófono integrado") }
        ],
        cameras: [{ id: "default", label: ctx.say("Built-in camera", "Cámara integrada") }],
        microphoneId: "default",
        cameraId: "default",
        mirrored: true,
        flipCamera: nothing,
        cameraQuality: "auto",
        screenQuality: "auto",
        cameraLevel: "high",
        screenLevel: "high",
        setCameraQuality: nothing,
        setScreenQuality: nothing,
        cleanMic: "standard",
        setCleanMic: nothing,
        micFilter: null,
        licensedFilter: false,
        background: "off",
        setBackground: nothing,
        backgroundImage: null,
        pickBackground: async () => undefined,
        chooseBackgroundScene: nothing,
        backgroundRunning: null,
        backgroundProblem: null,
        look: { light: "off", style: "none", frame: "off" },
        setLook: nothing,
        toggleMic: nothing,
        toggleCamera: nothing,
        toggleShare: nothing,
        toggleDeafen: nothing,
        chooseMicrophone: nothing,
        chooseCamera: nothing,
        refresh: nothing,
        nearby: new Set(),
        audioRole: null,
        audioHost: null,
        audioMembers: [],
        combineOpen: false,
        combineAsked: null,
        combineRequest: null,
        combineWith: nothing,
        askToCombine: nothing,
        answerCombine: nothing,
        leaveCombine: nothing,
        recording: shape.recording ?? false,
        setRecording: nothing,
        handRaised: false,
        setHandRaised: nothing,
        hands: participants.filter((one) => has(shape.hands, one.userId)).map((one) => one.id),
        lowerHand: nothing,
        hosting: true,
        reactions: [],
        react: nothing,
        audio: { ok: true, blame: "fault", farEnd: false, headline: "", fix: "", lines: [] },
        outgoing: null
    };
}

/** The held call: this tab is in the call `shape` describes - the stand-up
 *  unless told otherwise. */
export function callHold(ctx: SceneContext, shape: CallShape = standupShape(ctx)): CallHold {
    return {
        call: callState(ctx, shape),
        recording: {
            running: shape.recording ?? false,
            seconds: shape.recording ? 754 : 0,
            bytes: shape.recording ? 61_000_000 : 0,
            file: null,
            error: "",
            supported: true,
            start: nothing,
            stop: nothing,
            discard: nothing
        } satisfies CallRecording,
        session: {
            meetingId: shape.meetingId,
            channelId: shape.channelId ?? "",
            title: shape.title,
            ...(shape.standalone ? { href: `/chat/meetings/${shape.meetingId}` } : {})
        },
        viewerId: VIEWER.id,
        enter: nothing,
        leave: nothing,
        withVideo: (shape.cameras?.length ?? 0) > 0
    };
}

/** The meeting as its own page lists it before anybody joins. */
export function meetingSummary(ctx: SceneContext, shape: CallShape): MeetingSummary {
    return {
        id: shape.meetingId,
        title: shape.title,
        hostId: VIEWER.id,
        hostName: VIEWER.name,
        scheduledAt: ago(ctx.now, 10),
        startedAt: ago(ctx.now, 9),
        present: shape.people.length,
        people: shape.people.map((person, index) => ({
            id: seat(index + 1),
            name: person.name,
            userId: person.id,
            muted: shape.muted?.includes(person.id) ?? false,
            deafened: false,
            streaming: false,
            serverMuted: false,
            serverDeafened: false
        })),
        guestToken: "fixture-guest-link",
        requireAccount: false,
        approveGuests: true,
        mine: true,
        invited: shape.people.slice(1).map(({ id: who, name }) => ({ id: who, name }))
    };
}

/** What has been said in the meeting's own chat. */
export function meetingLines(ctx: SceneContext): MeetingLine[] {
    const line = (n: number, who: Person, seatNo: number, minutes: number, body: string) => ({
        id: id("meeting-line", n),
        participantId: seat(seatNo),
        name: who.name,
        guest: false,
        userId: who.id,
        body,
        at: ago(ctx.now, minutes),
        files: [],
        poll: null
    });
    return [
        line(
            1,
            TEAM.kenji,
            3,
            7,
            ctx.say(
                "Board is up, we start with the API tickets.",
                "El tablero está listo, empezamos por las tareas de la API."
            )
        ),
        line(
            2,
            TEAM.ana,
            2,
            5,
            ctx.say("I'll take the import bug.", "Me quedo con el fallo de importación.")
        ),
        line(
            3,
            CREW.grace,
            5,
            2,
            ctx.say(
                "Hand up for the design estimates.",
                "Mano levantada para las estimaciones de diseño."
            )
        )
    ];
}

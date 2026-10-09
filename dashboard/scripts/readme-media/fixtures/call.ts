/**
 * A call in progress, as the screens that draw one receive it.
 *
 * The room is written against `CallState`, a plain shape, rather than against
 * the media server - so a call can be drawn from the state alone. Five people in
 * the stand-up voice room, Ana talking, Sam with his microphone off. No cameras:
 * a picture cannot carry somebody's face honestly, and a voice room is how the
 * stand-up is held anyway.
 */

import { TEAM, VIEWER, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { CallHold } from "@/app/(app)/chat/call-hold";
import type { CallRecording } from "@/app/(app)/chat/call-recorder";
import type { CallState, PeerState } from "@/app/(app)/chat/call-state";

export const VOICE_CHANNEL_ID = id("channel", 5);
export const MEETING_ID = id("meeting", 2);

/** The seat each person sits in, which is what the room keys everything by. */
const seat = (n: number) => id("meeting-seat", n);

const PEOPLE = [VIEWER, TEAM.ana, TEAM.priya, TEAM.kenji, TEAM.sam];

const nothing = (): void => undefined;

function peer(mic: PeerState["mic"]): PeerState {
    return { mic, muted: mic === "muted", deafened: false, recording: false, hand: false, handAt: 0, group: null };
}

export function callState(ctx: SceneContext): CallState {
    const participants = PEOPLE.map((person, index) => ({
        id: seat(index + 1),
        userId: person.id,
        name: person.name,
        admission: "admitted" as const,
        guest: false,
        joinedAt: ago(ctx.now, 9 - index),
        serverMuted: false,
        serverDeafened: false
    }));
    const states = new Map<string, PeerState>(
        participants.slice(1).map((person) => [person.id, peer(person.userId === TEAM.sam.id ? "muted" : "on")])
    );
    return {
        meeting: {
            id: MEETING_ID,
            channelId: VOICE_CHANNEL_ID,
            hostId: VIEWER.id,
            title: ctx.say("standup", "daily"),
            startedAt: ago(ctx.now, 9),
            ended: false,
            guestToken: null,
            approveGuests: false,
            requireAccount: false,
            scheduledAt: null,
            standalone: false,
            mayModerate: true,
            participants
        },
        participantId: seat(1),
        localStream: null,
        localScreen: null,
        remote: new Map(),
        screens: new Map(),
        // Ana has the floor.
        speaking: new Set([seat(2)]),
        states,
        micOn: true,
        cameraOn: false,
        hasCamera: true,
        sharing: false,
        deafened: false,
        moderation: { serverMuted: false, serverDeafened: false },
        ended: false,
        saidAt: 0,
        error: "",
        microphones: [{ id: "default", label: ctx.say("Built-in microphone", "Micrófono integrado") }],
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
        recording: false,
        setRecording: nothing,
        handRaised: false,
        setHandRaised: nothing,
        hands: [],
        lowerHand: nothing,
        hosting: true,
        reactions: [],
        react: nothing,
        audio: { ok: true, blame: "fault", farEnd: false, headline: "", fix: "", lines: [] },
        outgoing: null
    };
}

/** The held call: this tab is in the stand-up. */
export function callHold(ctx: SceneContext): CallHold {
    return {
        call: callState(ctx),
        recording: {
            running: false,
            seconds: 0,
            bytes: 0,
            file: null,
            error: "",
            supported: true,
            start: nothing,
            stop: nothing,
            discard: nothing
        } satisfies CallRecording,
        session: { meetingId: MEETING_ID, channelId: VOICE_CHANNEL_ID, title: ctx.say("standup", "daily") },
        viewerId: VIEWER.id,
        enter: nothing,
        leave: nothing,
        withVideo: false
    };
}

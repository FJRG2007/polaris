"use client";

/**
 * A call through the media server.
 *
 * The only way a call is carried. Each browser opens **one** connection,
 * publishes its microphone and camera **once**, and receives everybody else's
 * back from the server - rather than one connection and one upload of the same
 * camera per other person, which is fine for two people on one wifi and falls
 * over at four on domestic upstream.
 *
 * Three things follow from having something in the middle, and they are the
 * reasons for doing it rather than side effects:
 *
 * - **It connects.** The server has an address both browsers can reach, so
 *   neither has to discover its own and neither needs a relay of its own.
 * - **It sends less.** `dynacast` stops publishing the quality layers nobody is
 *   currently watching, and `adaptiveStream` asks for the resolution a tile is
 *   actually being drawn at - so a face in a 160px tile is not a 720p stream
 *   being thrown away after decode, and a call in a background tab pauses
 *   instead of paying for frames nobody sees.
 * - **There is nothing to negotiate.** No offers, no answers, no candidates, no
 *   book of which slot carries the screen. Publishing a track says what it is,
 *   and a subscriber is told.
 *
 * What Polaris still owns is everything about *who*: the meeting, the roster,
 * the waiting room, and the ticket that lets a browser in - see `call-server`.
 * The media server is only ever told "this identity may be in this room", and it
 * is the seat somebody already holds that decides whether they get told that.
 *
 * The microphone is opened here rather than by the media server's own helper,
 * because the noise filter lives between the device and the call: what gets
 * published is the track that comes out of the model - see `mic-filter` - and
 * the raw device track stays behind it, which is what mute, the device picker
 * and the teardown all refer to.
 */

import { z } from "zod";
import { setMicDevice } from "./mic-device";
import { callDeviceId } from "./call-device";
import * as actions from "./meeting-actions";
import { callServerUrl } from "./call-address";
import { playCallSound } from "@/lib/call-sounds";
import type { MeetingView } from "@/lib/chat/meetings";
import { callDevices, openMedia, settle } from "./call-media";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CallDevice, CallState, PeerState } from "./call-state";
import { filterMic, type FilteredMic, type MicFilter } from "./mic-filter";
import type { Participant, Room, Track, TrackPublication } from "livekit-client";
import { applyMicCleanup, micCleanup, micConstraints, useMicCleanup } from "./mic-cleanup";

/** How often the server is told this browser is still on the call. Comfortably
 *  inside the window it sweeps on. */
const KEEPALIVE_MS = 10_000;

/**
 * The client for the media server, fetched at the moment a call needs it.
 *
 * Types at the top of the file, code only here. The provider that holds a call
 * is mounted above every screen in Polaris - which is what lets somebody walk
 * around mid-call - so anything imported here for real would be in the bundle of
 * the settings page, the deploy page and every other page, downloaded by people
 * who will never be in a call and by instances that have no call server at all.
 * A few hundred kilobytes of media client is not the price of opening a
 * dashboard.
 *
 * Cached across calls, because the second call of the day should not fetch it
 * again.
 */
type LiveKit = typeof import("livekit-client");
let client: LiveKit | null = null;

async function livekit(): Promise<LiveKit> {
    client ??= await import("livekit-client");
    return client;
}

/**
 * The three kinds of thing a browser publishes, spelled out.
 *
 * These are the values of the media client's own enum, written here so that
 * naming one does not drag the module in - an enum is a runtime object, and
 * importing it for a constant would undo the whole of the paragraph above.
 * Asserted to the enum's type rather than declared as strings, so a rename on
 * the other side is a build error here.
 */
const MICROPHONE = "microphone" as Track.Source;
const CAMERA = "camera" as Track.Source;
const SCREEN = "screen_share" as Track.Source;
const SCREEN_AUDIO = "screen_share_audio" as Track.Source;
/** What `Room.state` reads when the connection is up, spelled out for the same
 *  reason. */
const CONNECTED = "connected" as Room["state"];

/**
 * The meeting's own stream, which is about people rather than media.
 *
 * Only the room, never the media: with a server in the middle there is nothing
 * for one browser to say to another. What is left is who is here, who is
 * waiting, and whether it is over.
 */
const frameSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("seated"),
        participantId: z.string(),
        admission: z.string()
    }),
    z.object({ kind: z.literal("roster") }),
    z.object({ kind: z.literal("ended") }),
    /** Another browser of this same account took the call. */
    z.object({ kind: z.literal("claimed"), deviceId: z.string().optional() })
]);

/**
 * Where "they have their headphones off" is written down.
 *
 * A muted microphone the media server already knows about - a publication is
 * muted or it is not, and everybody is told. Deafening it cannot know, because
 * nothing about it is visible in what somebody sends: they publish exactly the
 * same audio either way. So it rides in a participant attribute, which is the
 * one small key-value bag the server keeps per person and gossips to the room.
 */
const DEAFENED = "deafened";

/** What asking for a ticket answers. Named so a request that could not be made
 *  at all can be turned into the same shape and read the same way. */
type CallTicket = Awaited<ReturnType<typeof actions.callTokenAction>>;

export function useSfuCall(meetingId: string | null, options?: { video?: boolean }): CallState {
    const withVideo = options?.video ?? true;

    const [meeting, setMeeting] = useState<MeetingView | null>(null);
    const [participantId, setParticipantId] = useState<string | null>(null);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remote, setRemote] = useState<ReadonlyMap<string, MediaStream>>(new Map());
    const [screens, setScreens] = useState<ReadonlyMap<string, MediaStream>>(new Map());
    const [states, setStates] = useState<ReadonlyMap<string, PeerState>>(new Map());
    const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
    const [micOn, setMicOn] = useState(true);
    const [cameraOn, setCameraOn] = useState(withVideo);
    const [hasCamera, setHasCamera] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [deafened, setDeafened] = useState(false);
    const [ended, setEnded] = useState(false);
    const [error, setError] = useState("");
    const [microphones, setMicrophones] = useState<readonly CallDevice[]>([]);
    const [cameras, setCameras] = useState<readonly CallDevice[]>([]);
    const [microphoneId, setMicrophoneId] = useState<string | null>(null);
    const [cameraId, setCameraId] = useState<string | null>(null);
    const [micFilter, setMicFilter] = useState<FilteredMic["using"] | null>(null);
    const [licensedFilter, setLicensedFilter] = useState(false);

    /** The connection to the media server, for as long as this browser is in the
     *  call. One of them, whatever the size of the room. */
    const room = useRef<Room | null>(null);
    // The three devices this browser can put on the wire, held separately: what
    // is published is one of them, and the others have to stay openable without
    // a second permission prompt.
    const mic = useRef<MediaStreamTrack | null>(null);
    const camera = useRef<MediaStreamTrack | null>(null);
    const screen = useRef<MediaStreamTrack | null>(null);
    // The microphone with a model between it and the call, when one is running.
    const filtered = useRef<FilteredMic | null>(null);
    const licensed = useRef<{ moduleUrl: string; token: string } | null>(null);
    const me = useRef<string | null>(null);
    /**
     * Whether this browser was pushed off the call by another device of the same
     * account, rather than leaving.
     *
     * The two look identical on the way out and must not be treated alike. An
     * account has one seat, so both devices are the same participant row: a
     * browser that tears down and releases the seat releases the seat the OTHER
     * device is sitting in. Picking a call up on a phone therefore killed it on
     * the phone a moment later - the row went to `leftAt`, the heartbeat could
     * never revive it, the phone was gone from everybody's roster while still
     * holding a microphone, and getting back in took a reload.
     *
     * So this says which of the two happened. Displaced, the seat is not this
     * browser's to give up; it hangs up and says nothing to the server.
     */
    const displaced = useRef(false);
    /** Whether this pair of ears is switched off, held beside the state it
     *  mirrors so a connection made after the press still says so. */
    const deafenedRef = useRef(false);

    /** The stream the local tile shows: whatever is going out right now. */
    const publishLocalPreview = useCallback(() => {
        const tracks = [mic.current, screen.current ?? camera.current].filter(
            (track): track is MediaStreamTrack => track !== null
        );
        setLocalStream(tracks.length > 0 ? new MediaStream(tracks) : null);
    }, []);

    /** What this browser has to offer, named. */
    const listDevices = useCallback(async () => {
        const found = await callDevices();
        setMicrophones(found.microphones);
        setCameras(found.cameras);
    }, []);

    const refresh = useCallback(() => {
        if (!meetingId) return;
        void actions.readCallAction(meetingId).then((result) => {
            // No seat. This browser is not in that call - it ended, the seat was
            // swept, or another device took it over - and the honest thing is to
            // let go rather than draw a sentence under a bar for a room nobody
            // is in.
            if (result.gone) {
                setEnded(true);
                return;
            }
            if (result.error) {
                setError(result.error);
                return;
            }
            setMeeting(result.meeting ?? null);
            if (result.participantId) {
                me.current = result.participantId;
                setParticipantId(result.participantId);
            }
            if (result.meeting?.ended) setEnded(true);
        });
    }, [meetingId]);

    /**
     * Rebuild who is sending what, from the tracks currently subscribed to.
     *
     * Read off the room rather than accumulated as events arrive, because the
     * room is the thing that is actually true: a participant who republishes,
     * reconnects or is resubscribed to would otherwise leave a dead track behind
     * in a map nobody rebuilt.
     *
     * Which tile a track belongs in is the publication's `source`, decided by
     * the publisher when it published and carried by the server, so there is no
     * book of which slot carries what and nothing to keep in step.
     *
     * Everybody's is worked out, and only the ones that actually changed get a
     * new `MediaStream` - see `settle`. A stream object is what a tile is pointed
     * at, so handing back new ones for the whole room whenever one person turns a
     * camera on would restart every video element on the screen.
     */
    const resort = useCallback(() => {
        const current = room.current;
        if (!current) return;

        const faces = new Map<string, MediaStreamTrack[]>();
        const shared = new Map<string, MediaStreamTrack[]>();
        for (const participant of current.remoteParticipants.values()) {
            const camera: MediaStreamTrack[] = [];
            const display: MediaStreamTrack[] = [];
            for (const publication of participant.trackPublications.values()) {
                const track = publication.track?.mediaStreamTrack;
                if (!track || track.readyState !== "live") continue;
                const onScreen =
                    publication.source === SCREEN || publication.source === SCREEN_AUDIO;
                (onScreen ? display : camera).push(track);
            }
            faces.set(participant.identity, camera);
            // A screen tile with nothing live in it is not a screen: left out, so
            // the big tile closes when somebody stops sharing rather than
            // freezing on the last frame they sent.
            if (display.length > 0) shared.set(participant.identity, display);
        }
        setRemote((held) => settle(held, faces));
        setScreens((held) => settle(held, shared));
    }, []);

    /** What everybody's controls are set to, from what the server already knows
     *  plus the one thing it cannot: whether they are listening. */
    const resortStates = useCallback(() => {
        const current = room.current;
        if (!current) return;
        const next = new Map<string, PeerState>();
        for (const participant of current.remoteParticipants.values()) {
            next.set(participant.identity, {
                muted: !participant.isMicrophoneEnabled,
                deafened: participant.attributes?.[DEAFENED] === "1"
            });
        }
        setStates(next);
    }, []);

    /** What the call sends as this browser's voice: the filtered track when a
     *  model is running, and the microphone itself otherwise. */
    const outgoingMic = useCallback(
        (): MediaStreamTrack | null => filtered.current?.track ?? mic.current,
        []
    );

    /**
     * Put a track on the connection in place of whatever was in that slot, or
     * take it off.
     *
     * One publication per source, and a swap is a swap rather than a teardown:
     * a different microphone or a rebuilt filter is `replaceTrack` on the
     * publication that is already up, which changes nothing about the session
     * and is not noticed by anybody receiving it. Publishing again instead would
     * make every subscriber resubscribe, which is a second of silence for the
     * whole room every time somebody opens the device menu.
     *
     * Nothing here stops a device. The tracks are this hook's, stopped once at
     * the end - stopping one on unpublish would cost a permission prompt to turn
     * a camera back on.
     */
    const publish = useCallback(async (source: Track.Source, track: MediaStreamTrack | null) => {
        const current = room.current;
        if (!current || current.state !== CONNECTED) return;
        const local = current.localParticipant;
        const existing = local.getTrackPublication(source);

        if (!track) {
            if (existing?.track) {
                await local.unpublishTrack(existing.track, false).catch(() => undefined);
            }
            return;
        }
        if (existing?.track) {
            // `true` is "this track is the caller's": the old one is left
            // alone rather than stopped, which is what makes a microphone
            // swap reversible.
            await existing.track.replaceTrack(track, true).catch(() => undefined);
            return;
        }
        await local
            .publishTrack(track, {
                source,
                // A screen is text as often as it is video, and text survives
                // a dropped frame far better than it survives being blurred.
                degradationPreference: source === SCREEN ? "maintain-resolution" : undefined
            })
            .catch(() => undefined);
    }, []);

    /**
     * Turn this browser's voice on or off.
     *
     * Both tracks, because there are two: the device track going quiet is what
     * stops the filter having anything to work on, and the published track going
     * quiet is what stops the packets. The publication is muted as well as the
     * track - which is what tells everybody else, without a message of our own.
     */
    const setVoiceEnabled = useCallback((on: boolean) => {
        if (mic.current) mic.current.enabled = on;
        if (filtered.current) filtered.current.track.enabled = on;
        const publication = room.current?.localParticipant.getTrackPublication(MICROPHONE);
        if (!publication?.track) return;
        if (on) void publication.track.unmute().catch(() => undefined);
        else void publication.track.mute().catch(() => undefined);
    }, []);

    /**
     * Put the chosen filter between the microphone and the call, or take away
     * the one that was there.
     */
    const startFilter = useCallback(async () => {
        await filtered.current?.stop();
        filtered.current = null;
        setMicFilter(null);

        const track = mic.current;
        if (!track) return;

        // The browser's own processors first, whatever comes after them.
        await applyMicCleanup(track);

        const built = await filterMic(track, micCleanup(), licensed.current);
        if (!built) return;
        // The microphone may have been muted while the model was loading.
        built.track.enabled = track.enabled;
        filtered.current = built;
        setMicFilter(built.using);
    }, []);

    /**
     * Everything that was true of the last call and is not true of this one.
     *
     * A hook outlives the calls it carries - the provider holding it is above
     * every screen in Polaris - so state left behind is state the next call
     * starts with. What is deliberately not reset is the microphone and camera:
     * they are set from what opens, a moment later, and blanking them here would
     * flicker the controls on the way in.
     */
    const forget = useCallback(() => {
        setMeeting(null);
        setEnded(false);
        setError("");
        setRemote(new Map());
        setScreens(new Map());
        setStates(new Map());
        setSpeaking(new Set());
    }, []);

    /** Open the devices, connect, publish, and take it all down again. */
    useEffect(() => {
        if (!meetingId) return;
        const inCall = meetingId;
        let stopped = false;
        let source: EventSource | null = null;
        let beat: ReturnType<typeof setInterval> | null = null;
        /**
         * Whether the connection has been made, so the waiting room does not
         * make it twice.
         *
         * Somebody let in from the lobby gets no ticket until they are admitted,
         * so the attempt is repeated on each roster change until it lands. This
         * is what keeps it from being repeated afterwards as well.
         */
        let connecting = false;
        /**
         * What a failed attempt put on screen, so the attempt that succeeds can
         * take it back down.
         *
         * Only that message. A call that opens while the media server is
         * restarting fails once and joins on the next roster change, and the
         * banner it left said the call reached nobody while both people could
         * hear each other. What the devices had to say - no microphone, no
         * camera - is not this and stays where it is.
         */
        let reported = "";

        /** Say why the call has not started. */
        function report(message: string): void {
            reported = message;
            setError(message);
        }

        /** Take back what the last failed attempt said, if it is still what the
         *  screen is showing. */
        function connected(): void {
            if (!reported) return;
            const stale = reported;
            reported = "";
            setError((current) => (current === stale ? "" : current));
        }

        // This is a different call, so nothing about the last one is true of it.
        // `ended` in particular: it is only ever set, never cleared, so a second
        // call in the same tab opened straight onto "the call has ended" - the
        // answer to a question about a room nobody is in any more.
        forget();

        /**
         * Ask for the ticket and join, if there is one to be had.
         *
         * Waiting is the ordinary case and says nothing: somebody in the lobby
         * is told "not yet", and the next roster change asks again. Anything
         * else has gone wrong and goes on screen - most often a media server
         * that is not answering, which without this was a room that showed
         * everybody's name and carried no sound, with nothing to read.
         */
        async function connect(): Promise<void> {
            if (stopped || connecting || room.current) return;
            const ticket = await actions
                .callTokenAction(inCall)
                .catch(
                    () => ({ error: "The call could not be reached. Try again." }) as CallTicket
                );
            if (stopped) return;
            if (ticket.waiting) return;
            if (ticket.error) {
                report(ticket.error);
                return;
            }
            if (!ticket.url || !ticket.token) return;

            connecting = true;
            // Fetched now rather than imported: see `livekit` above. It is one
            // request, cached, and it happens while the browser is already
            // waiting on the ticket.
            const { Room, RoomEvent } = await livekit();
            if (stopped) {
                connecting = false;
                return;
            }

            const joined = new Room({
                // Ask for the resolution the tile is actually drawn at, and stop
                // the flow entirely while it is off screen. On a wall of eight
                // faces this is most of the bandwidth.
                adaptiveStream: true,
                // Stop sending the quality layers nobody is subscribed to.
                dynacast: true,
                publishDefaults: {
                    // Three sizes of the same camera, so the server has something
                    // to give a small tile and a slow connection without asking
                    // the publisher to change anything.
                    simulcast: true,
                    // Cheap on the wire and free of charge: silence costs nothing
                    // to send, and a lost audio packet is covered by the next.
                    dtx: true,
                    red: true
                },
                // The devices are opened by this hook, filtered, and handed over -
                // so nothing here should go looking for one of its own.
                stopLocalTrackOnUnpublish: false
            });
            room.current = joined;

            joined
                // Both, because a track arriving is also the first thing that
                // says whether the microphone behind it is muted: somebody who
                // joined muted publishes a muted track and never fires a mute
                // event, so their icon would only appear if they happened to
                // unmute and mute again.
                .on(RoomEvent.TrackSubscribed, () => {
                    resort();
                    resortStates();
                })
                .on(RoomEvent.TrackUnsubscribed, () => {
                    resort();
                    resortStates();
                })
                .on(RoomEvent.LocalTrackPublished, () => publishLocalPreview())
                .on(RoomEvent.TrackMuted, onMuteChanged)
                .on(RoomEvent.TrackUnmuted, onMuteChanged)
                .on(RoomEvent.ParticipantAttributesChanged, () => resortStates())
                .on(RoomEvent.ParticipantConnected, () => {
                    resort();
                    resortStates();
                })
                .on(RoomEvent.ParticipantDisconnected, () => {
                    resort();
                    resortStates();
                })
                .on(RoomEvent.ActiveSpeakersChanged, onSpeakers)
                .on(RoomEvent.Disconnected, () => {
                    // Only ever after it has given up: a connection that drops is
                    // retried by the client on its own, and only the last one is
                    // reported here. Not on the way out, where a disconnection is
                    // what leaving is.
                    if (stopped) return;
                    setRemote(new Map());
                    setScreens(new Map());
                    setError(
                        "This call lost the call server. Nothing more will be heard until it is back."
                    );
                });

            try {
                await joined.connect(callServerUrl(ticket.url), ticket.token);
            } catch {
                connecting = false;
                room.current = null;
                report(
                    "This call could not reach the call server. It may be starting up, or an administrator may need to look at it."
                );
                return;
            }
            connecting = false;
            if (stopped) {
                await joined.disconnect().catch(() => undefined);
                room.current = null;
                return;
            }
            connected();

            // Everything this browser already had open goes up now. Nothing was
            // published before the connection existed, so this is the one place
            // the first publication happens.
            await publish(MICROPHONE, outgoingMic());
            await publish(CAMERA, camera.current);
            if (screen.current) await publish(SCREEN, screen.current);
            if (deafenedRef.current) {
                await joined.localParticipant
                    .setAttributes({ [DEAFENED]: "1" })
                    .catch(() => undefined);
            }
            publishLocalPreview();
            resort();
            resortStates();
        }

        /** Somebody muted or unmuted something, ours included. */
        function onMuteChanged(_publication: TrackPublication, participant: Participant): void {
            if (participant.isLocal) return;
            resortStates();
        }

        /** Who is talking, measured by the server rather than by this browser.
         *  One number per participant instead of an analyser per stream. */
        function onSpeakers(speakers: Participant[]): void {
            setSpeaking(new Set(speakers.map((speaker) => speaker.identity)));
        }

        async function start(): Promise<void> {
            licensed.current = await actions.licensedFilterAction(inCall).catch(() => null);
            setLicensedFilter(licensed.current !== null);

            const opened = await openMedia(withVideo);
            if (stopped) {
                for (const track of opened.stream?.getTracks() ?? []) track.stop();
                return;
            }
            if (opened.stream) {
                mic.current = opened.stream.getAudioTracks()[0] ?? null;
                camera.current = opened.stream.getVideoTracks()[0] ?? null;
                setHasCamera(camera.current !== null);
                setMicOn(mic.current !== null);
                setCameraOn(camera.current !== null);
                setMicrophoneId(mic.current?.getSettings().deviceId ?? null);
                setCameraId(camera.current?.getSettings().deviceId ?? null);
                publishLocalPreview();
                void listDevices();
                // Built before anything is published, so the first packet already
                // carries the filtered track and nobody hears the raw room for
                // the second it would take to swap.
                await startFilter();
            }
            // A call with no camera, or none with no microphone, is still a call.
            // What could not be opened is said out loud, because sitting in a
            // room where nobody can hear you and nothing says so is the worst
            // version of this.
            if (opened.note) setError(opened.note);

            if (stopped) return;

            source = new EventSource(`/api/chat/meetings/${inCall}/stream`);
            source.onmessage = (event) => {
                let raw: unknown;
                try {
                    raw = JSON.parse(event.data);
                } catch {
                    return;
                }
                const frame = frameSchema.safeParse(raw);
                if (!frame.success) return;

                if (frame.data.kind === "seated") {
                    me.current = frame.data.participantId;
                    setParticipantId(frame.data.participantId);
                    refresh();
                    if (frame.data.admission === "admitted") void connect();
                    // This browser is on the call now, so say so. Any other
                    // browser of the same account that thought it was hangs up
                    // on hearing it - one seat, one device, and the newest press
                    // is the one that meant it.
                    if (frame.data.admission === "admitted") {
                        void actions.claimCallAction(inCall, callDeviceId());
                    }
                    return;
                }
                if (frame.data.kind === "roster") {
                    refresh();
                    // Somebody may have just been let out of the waiting room,
                    // and it may have been us.
                    void connect();
                    return;
                }
                // Another browser of this account took the seat. An account has
                // one place in a call, so this browser no longer has it - and
                // being told is the whole point: without it two devices sat on
                // one seat, both holding a microphone, neither aware.
                if (frame.data.kind === "claimed") {
                    if (frame.data.deviceId && frame.data.deviceId !== callDeviceId()) {
                        // Marked before the teardown it is about to cause, so
                        // the cleanup below knows not to hand back a seat that
                        // is now the other device's.
                        displaced.current = true;
                        setEnded(true);
                    }
                    return;
                }
                if (frame.data.kind === "ended") setEnded(true);
            };

            beat = setInterval(() => void actions.keepSeatAction(inCall), KEEPALIVE_MS);
            refresh();
            await connect();
        }

        void start();

        return () => {
            stopped = true;
            if (beat) clearInterval(beat);
            source?.close();
            void room.current?.disconnect().catch(() => undefined);
            room.current = null;
            // The filter first: it reads from the microphone, and a graph left
            // running over a stopped track is a wasm module and an audio thread
            // nobody ever closes.
            void filtered.current?.stop();
            filtered.current = null;
            for (const track of [mic.current, camera.current, screen.current]) track?.stop();
            mic.current = null;
            camera.current = null;
            screen.current = null;
            // Leaving releases the participant row, and an account has one of
            // those however many devices it is signed in on. So a browser that
            // was displaced must not: the row it would hand back is the one the
            // phone that just took the call is sitting in, and handing it back
            // struck that phone off the roster mid-call, with a heartbeat that
            // could never revive it and a reload the only way back in.
            if (!displaced.current) void actions.leaveCallAction(inCall);
        };
    }, [
        forget,
        listDevices,
        meetingId,
        outgoingMic,
        publish,
        publishLocalPreview,
        refresh,
        resort,
        resortStates,
        startFilter,
        withVideo
    ]);

    const toggleMic = useCallback(() => {
        const track = mic.current;
        if (!track) return;
        setVoiceEnabled(!track.enabled);
        setMicOn(track.enabled);
    }, [setVoiceEnabled]);

    /**
     * Turn the camera on or off.
     *
     * Off is unpublished rather than left running and disabled: with a server in
     * the middle, an unpublished track is one everybody stops being sent, and a
     * disabled one is a black rectangle the server still has to deliver. The
     * device itself stays open underneath, so coming back costs nothing.
     */
    const toggleCamera = useCallback(() => {
        const existing = camera.current;
        if (existing) {
            const next = !cameraOn;
            existing.enabled = next;
            setCameraOn(next);
            void publish(CAMERA, next ? existing : null);
            publishLocalPreview();
            return;
        }
        void navigator.mediaDevices
            .getUserMedia({ video: true })
            .then(async (stream) => {
                const track = stream.getVideoTracks()[0] ?? null;
                camera.current = track;
                setHasCamera(track !== null);
                setCameraOn(track !== null);
                setCameraId(track?.getSettings().deviceId ?? null);
                await publish(CAMERA, track);
                publishLocalPreview();
                void listDevices();
            })
            .catch(() => setError("Polaris could not reach your camera."));
    }, [cameraOn, listDevices, publish, publishLocalPreview]);

    /**
     * Share a screen, or stop.
     *
     * Its own publication beside the camera, rather than in place of it: the
     * server sends each subscriber only what they are watching, so a sharer's
     * face costs nothing to keep on and everybody can share at once.
     */
    const toggleShare = useCallback(() => {
        if (screen.current) {
            screen.current.stop();
            screen.current = null;
            void publish(SCREEN, null);
            publishLocalPreview();
            setSharing(false);
            playCallSound("shareOff");
            return;
        }
        void navigator.mediaDevices
            .getDisplayMedia({ video: true })
            .then(async (stream) => {
                const track = stream.getVideoTracks()[0];
                if (!track) return;
                // The browser's own "stop sharing" bar ends the track without
                // going through this hook, and the call has to notice.
                track.onended = () => {
                    screen.current = null;
                    void publish(SCREEN, null);
                    publishLocalPreview();
                    setSharing(false);
                    playCallSound("shareOff");
                };
                screen.current = track;
                await publish(SCREEN, track);
                publishLocalPreview();
                setSharing(true);
                playCallSound("shareOn");
            })
            .catch(() => {
                // Cancelling the picker is the ordinary way out of this dialog,
                // not a failure worth a line on the screen.
            });
    }, [publish, publishLocalPreview]);

    /**
     * Silence everybody, and yourself with them.
     *
     * Said out loud, because it is the one thing about somebody's controls the
     * media server cannot work out for itself: a deafened person publishes
     * exactly what an attentive one does.
     */
    const toggleDeafen = useCallback(() => {
        setDeafened((current) => {
            const next = !current;
            deafenedRef.current = next;
            if (mic.current) {
                setVoiceEnabled(!next);
                setMicOn(mic.current.enabled);
            }
            void room.current?.localParticipant
                .setAttributes({ [DEAFENED]: next ? "1" : "" })
                .catch(() => undefined);
            return next;
        });
    }, [setVoiceEnabled]);

    /** Swap one input for another, mid-call. */
    const chooseDevice = useCallback(
        (kind: "audio" | "video", deviceId: string) => {
            const constraints: MediaStreamConstraints =
                kind === "audio"
                    ? { audio: micConstraints(deviceId) }
                    : { video: { deviceId: { exact: deviceId } } };
            void navigator.mediaDevices
                .getUserMedia(constraints)
                .then(async (stream) => {
                    const track =
                        kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
                    if (!track) return;
                    const previous = kind === "audio" ? mic.current : camera.current;
                    previous?.stop();
                    if (kind === "audio") {
                        track.enabled = !deafened && micOn;
                        mic.current = track;
                        setMicrophoneId(deviceId);
                        // Remembered for this browser, so the next call and the
                        // next voice message use the microphone somebody went to
                        // the trouble of picking.
                        setMicDevice(deviceId);
                        // Rebuilt against the new device: the old graph was
                        // reading from the track just stopped.
                        await startFilter();
                        await publish(MICROPHONE, outgoingMic());
                    } else {
                        track.enabled = cameraOn;
                        camera.current = track;
                        setCameraId(deviceId);
                        // The screen is its own publication, so a camera swap
                        // never touches it: picking a different camera is not a
                        // decision to stop sharing.
                        if (cameraOn) await publish(CAMERA, track);
                    }
                    publishLocalPreview();
                })
                .catch(() => setError("Polaris could not open that device."));
        },
        [cameraOn, deafened, micOn, outgoingMic, publish, publishLocalPreview, startFilter]
    );

    const chooseMicrophone = useCallback(
        (deviceId: string) => chooseDevice("audio", deviceId),
        [chooseDevice]
    );
    const chooseCamera = useCallback(
        (deviceId: string) => chooseDevice("video", deviceId),
        [chooseDevice]
    );

    /**
     * Change how much is done to the microphone, mid-call.
     *
     * The device is never reopened: the browser's three processors move on the
     * track that is already open, and the model is a graph built beside it. What
     * is published is then swapped, which nobody else notices.
     */
    const [cleanMic, rememberCleanMic] = useMicCleanup();
    const setCleanMic = useCallback(
        (level: MicFilter) => {
            rememberCleanMic(level);
            void (async () => {
                await startFilter();
                await publish(MICROPHONE, outgoingMic());
                publishLocalPreview();
            })();
        },
        [outgoingMic, publish, publishLocalPreview, rememberCleanMic, startFilter]
    );

    /**
     * Somebody arrived, or somebody left.
     *
     * Sounded rather than only drawn: whoever is in a call is usually looking at
     * something else, which is the whole reason to be on a call rather than in a
     * document together. The first roster is not announced - joining a call of
     * four is not four people arriving.
     */
    const roster = useRef<readonly string[] | null>(null);
    useEffect(() => {
        const inside = (meeting?.participants ?? [])
            .filter((person) => person.admission === "admitted")
            .map((person) => person.id);
        const before = roster.current;
        roster.current = inside;
        if (before === null) return;
        if (inside.some((id) => !before.includes(id))) playCallSound("join");
        else if (before.some((id) => !inside.includes(id))) playCallSound("leave");
    }, [meeting]);

    return {
        meeting,
        participantId,
        localStream,
        remote,
        screens,
        speaking,
        states,
        cleanMic,
        setCleanMic,
        micFilter,
        licensedFilter,
        micOn,
        cameraOn,
        hasCamera,
        sharing,
        deafened,
        ended,
        error,
        microphones,
        cameras,
        microphoneId,
        cameraId,
        toggleMic,
        toggleCamera,
        toggleShare,
        toggleDeafen,
        chooseMicrophone,
        chooseCamera,
        refresh
    };
}

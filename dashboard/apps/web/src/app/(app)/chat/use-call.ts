"use client";

/**
 * A call, in the browser.
 *
 * Every participant connects to every other one directly - a mesh - so the audio
 * and video never pass through Polaris. That is what makes a call possible on a
 * box on somebody's shelf, and it is also why a call is capped at a handful of
 * people: each browser sends its own video once per other participant, and the
 * cost is the square of the room.
 *
 * **Negotiation.** The hard part of a mesh is glare: two peers offering each
 * other a connection at the same instant. This uses the perfect-negotiation
 * pattern - of any two participants the one with the larger id is *polite* and
 * rolls its own offer back when one collides, and the other one ignores the
 * collision and presses on. Both sides work that out on their own from ids they
 * already have, so there is nothing to agree on and nothing to race over.
 *
 * That matters more than it looks. The older rule here was "the smaller id
 * offers, once" - which is enough to start a call and not enough to change one.
 * Turning a camera on, picking a different microphone and sharing a screen all
 * mean the set of tracks changes mid-call, and every one of those has to be
 * renegotiated by whichever side changed. Perfect negotiation is what makes that
 * safe from both ends.
 *
 * **Missing tracks are still negotiated.** Somebody who joined with audio only,
 * or whose camera was refused, adds a receive-only transceiver in its place.
 * Without it the offer carries no video line at all and the other side has
 * nowhere to send theirs, so the person with no camera would also see nobody.
 *
 * Everything is torn down on the way out: tracks stopped, connections closed,
 * seat given up. A camera light left on after somebody closed the tab is the
 * kind of bug people do not forgive.
 */

import { z } from "zod";
import { useSpeaking } from "./use-speaking";
import * as actions from "./meeting-actions";
import { playCallSound } from "@/lib/call-sounds";
import type { MeetingView } from "@/lib/chat/meetings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterMic, type FilteredMic, type MicFilter } from "./mic-filter";
import { applyMicCleanup, micCleanup, micConstraints, useMicCleanup } from "./mic-cleanup";

/** How often the server is told this browser is still on the call. Comfortably
 *  inside the window it sweeps on. */
const KEEPALIVE_MS = 10_000;

const frameSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("seated"),
        participantId: z.string(),
        admission: z.string()
    }),
    z.object({ kind: z.literal("signal"), fromId: z.string(), payload: z.string() }),
    z.object({ kind: z.literal("roster") }),
    z.object({ kind: z.literal("ended") })
]);

const signalSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("offer"), sdp: z.string() }),
    z.object({ type: z.literal("answer"), sdp: z.string() }),
    z.object({
        type: z.literal("candidate"),
        candidate: z.string(),
        sdpMid: z.string().nullable(),
        sdpMLineIndex: z.number().nullable()
    })
]);

/** One microphone or camera, as the picker lists it. */
export interface CallDevice {
    readonly id: string;
    readonly label: string;
}

/** One connection and the small amount of state perfect negotiation needs. */
interface Peer {
    readonly connection: RTCPeerConnection;
    /**
     * The two slots this browser sends through, kept rather than looked up.
     *
     * Searching the transceiver list for "the one carrying video" only works
     * while there is something on it: a slot with no track and no incoming
     * track yet answers to neither kind, so the search misses it and a camera
     * turned on mid-call is added as a *second* video slot instead of filling
     * the empty one. The far side, which negotiated one, then shows nothing.
     * Holding the references makes the question unnecessary.
     */
    readonly audio: RTCRtpTransceiver | null;
    readonly video: RTCRtpTransceiver | null;
    /** True while an offer of ours is in flight, which is half of what makes a
     *  collision a collision. */
    makingOffer: boolean;
    /** True while we are deliberately ignoring the other side's offer, so the
     *  candidates that follow it are ignored too rather than throwing. */
    ignoring: boolean;
}

export interface CallState {
    readonly meeting: MeetingView | null;
    readonly participantId: string | null;
    readonly localStream: MediaStream | null;
    /** Remote video and audio, by the participant id it belongs to. */
    readonly remote: ReadonlyMap<string, MediaStream>;
    /** The participant ids talking right now, this browser's own included.
     *  Measured here rather than announced by anybody - see `useSpeaking`. */
    readonly speaking: ReadonlySet<string>;
    readonly micOn: boolean;
    readonly cameraOn: boolean;
    /** Whether this browser has a camera to turn on at all. */
    readonly hasCamera: boolean;
    /** Whether a screen is going out in place of the camera. */
    readonly sharing: boolean;
    /** Whether everybody else is silenced here. Nobody else is told: it is a
     *  decision about this pair of ears. */
    readonly deafened: boolean;
    readonly ended: boolean;
    /** What went wrong, in a sentence the call screen can show. Most often the
     *  browser refusing the camera, which is the reader's decision to reverse. */
    readonly error: string;
    readonly microphones: readonly CallDevice[];
    readonly cameras: readonly CallDevice[];
    readonly microphoneId: string | null;
    readonly cameraId: string | null;
    /** How much is being done to what the microphone hears. */
    readonly cleanMic: MicFilter;
    setCleanMic: (level: MicFilter) => void;
    /** Which filter is actually running, or null for none. Not always the one
     *  asked for: a model can fail to start, and a licence can fail to load. */
    readonly micFilter: FilteredMic["using"] | null;
    /** Whether this instance has a licensed filter connected at all. */
    readonly licensedFilter: boolean;
    toggleMic: () => void;
    toggleCamera: () => void;
    toggleShare: () => void;
    toggleDeafen: () => void;
    chooseMicrophone: (deviceId: string) => void;
    chooseCamera: (deviceId: string) => void;
    refresh: () => void;
}

/**
 * @param meetingId - The call to be in, or null for none. Null is what lets this
 *   live above the screen that shows a call: the provider holds one of these for
 *   the whole dashboard, and a browser that is not in a call is a browser where
 *   nothing here opens, connects or beats.
 */
export function useCall(meetingId: string | null, options?: { video?: boolean }): CallState {
    const withVideo = options?.video ?? true;

    const [meeting, setMeeting] = useState<MeetingView | null>(null);
    const [participantId, setParticipantId] = useState<string | null>(null);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remote, setRemote] = useState<ReadonlyMap<string, MediaStream>>(new Map());
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
    // Which filter is actually running, which is not always the one asked for:
    // the better model can fail to start, and a licence can fail to load.
    const [micFilter, setMicFilter] = useState<FilteredMic["using"] | null>(null);
    // Whether this instance has a licensed filter at all, which is what decides
    // if the menu offers it. Nobody should be shown a setting for something an
    // administrator has not bought.
    const [licensedFilter, setLicensedFilter] = useState(false);

    const peers = useRef(new Map<string, Peer>());
    const ice = useRef<RTCIceServer[]>([]);
    // The three tracks this browser can put on the wire, held separately: what
    // goes out as video is the screen when there is one and the camera
    // otherwise, and keeping the camera alive underneath is what makes stopping
    // a share instant rather than a second permission prompt.
    const mic = useRef<MediaStreamTrack | null>(null);
    const camera = useRef<MediaStreamTrack | null>(null);
    const screen = useRef<MediaStreamTrack | null>(null);
    // The microphone with a model between it and the call, when one is running.
    // A different track to the one above, and both matter: that one is the
    // device - muting, its id, stopping it - and this one is what goes out.
    const filtered = useRef<FilteredMic | null>(null);
    // The filter an administrator connected, read once per call from the server
    // rather than held in the page: it is instance configuration.
    const licensed = useRef<{ moduleUrl: string; token: string } | null>(null);
    const me = useRef<string | null>(null);
    // Candidates that arrived before the description they belong to, which is
    // ordinary rather than exceptional - the two travel over different requests.
    const early = useRef(new Map<string, RTCIceCandidateInit[]>());
    // One stream per other participant, built here rather than taken from the
    // track event: a track added without a stream arrives with none attached,
    // and a tile pointed at nothing shows nothing.
    const inbound = useRef(new Map<string, MediaStream>());

    /** What the call sends as this browser's voice: the filtered track when a
     *  model is running, and the microphone itself otherwise. */
    const outgoingMic = useCallback(
        (): MediaStreamTrack | null => filtered.current?.track ?? mic.current,
        []
    );

    /**
     * Turn this browser's voice on or off.
     *
     * Both tracks, because there are two: the device track going quiet is what
     * stops the filter having anything to work on, and the sent track going
     * quiet is what stops the packets. Muting only the first would keep sending
     * a stream of processed silence.
     */
    const setVoiceEnabled = useCallback((on: boolean) => {
        if (mic.current) mic.current.enabled = on;
        if (filtered.current) filtered.current.track.enabled = on;
    }, []);

    /** The stream the local tile shows: whatever is going out right now. */
    const publishLocalPreview = useCallback(() => {
        const tracks = [mic.current, screen.current ?? camera.current].filter(
            (track): track is MediaStreamTrack => track !== null
        );
        setLocalStream(tracks.length > 0 ? new MediaStream(tracks) : null);
    }, []);

    /** What this browser has to offer, named. Labels are only filled in once a
     *  permission has been granted, which is why this runs after the stream. */
    const listDevices = useCallback(async () => {
        const found = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        const named = (kind: MediaDeviceKind, fallback: string): CallDevice[] =>
            found
                .filter((device) => device.kind === kind && device.deviceId)
                .map((device, index) => ({
                    id: device.deviceId,
                    label: device.label || `${fallback} ${index + 1}`
                }));
        setMicrophones(named("audioinput", "Microphone"));
        setCameras(named("videoinput", "Camera"));
    }, []);

    const refresh = useCallback(() => {
        if (!meetingId) return;
        void actions.readCallAction(meetingId).then((result) => {
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

    const send = useCallback(
        async (toId: string, payload: unknown) => {
            if (!meetingId) return;
            await fetch(`/api/chat/meetings/${meetingId}/signal`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ toId, payload: JSON.stringify(payload) })
            }).catch(() => undefined);
        },
        [meetingId]
    );

    /**
     * Put a track on every connection, or take one off.
     *
     * `replaceTrack` on its own changes nothing about the shape of the session,
     * so swapping a camera for a screen costs no renegotiation at all. Turning
     * one on where there was none does, and the direction change is what asks
     * for it.
     */
    const publishTrack = useCallback((kind: "audio" | "video", track: MediaStreamTrack | null) => {
        for (const peer of peers.current.values()) {
            if (peer.connection.connectionState === "closed") continue;
            const transceiver = kind === "audio" ? peer.audio : peer.video;
            if (!transceiver) continue;
            void transceiver.sender.replaceTrack(track).catch(() => undefined);
            // The direction is what actually opens the tap. `replaceTrack` on a
            // slot that is only receiving succeeds and sends nothing, which is
            // the shape of "I turned my camera on and nobody saw it"; changing
            // the direction is also what asks for the renegotiation that tells
            // the other side to expect it.
            const wanted = track ? "sendrecv" : "recvonly";
            if (transceiver.direction !== wanted) transceiver.direction = wanted;
        }
    }, []);

    /** The connection to one other participant, made if it does not exist. */
    const peerFor = useCallback(
        (otherId: string): RTCPeerConnection => {
            const existing = peers.current.get(otherId);
            if (existing) return existing.connection;

            const connection = new RTCPeerConnection({ iceServers: ice.current });

            // Two slots, always, in the same order on both sides, whether or not
            // there is anything to put in them yet. A slot that is only
            // receiving still puts its line in the offer - which is why somebody
            // with no camera can see everybody else - and, just as importantly,
            // it is the slot a camera turned on later goes into. `addTransceiver`
            // rather than `addTrack` in both cases, so the reference is the
            // return value rather than something to go looking for.
            const voice = outgoingMic();
            const audio = connection.addTransceiver("audio", {
                direction: voice ? "sendrecv" : "recvonly"
            });
            if (voice) void audio.sender.replaceTrack(voice).catch(() => undefined);

            const outgoing = screen.current ?? camera.current;
            const video = connection.addTransceiver("video", {
                direction: outgoing ? "sendrecv" : "recvonly"
            });
            if (outgoing) void video.sender.replaceTrack(outgoing).catch(() => undefined);

            const peer: Peer = { connection, audio, video, makingOffer: false, ignoring: false };
            peers.current.set(otherId, peer);

            connection.onicecandidate = (event) => {
                if (!event.candidate) return;
                void send(otherId, {
                    type: "candidate",
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                });
            };

            connection.ontrack = (event) => {
                const stream = inbound.current.get(otherId) ?? new MediaStream();
                inbound.current.set(otherId, stream);
                if (!stream.getTracks().some((track) => track.id === event.track.id)) {
                    stream.addTrack(event.track);
                }
                // A new Map each time, because the stream object is the same one
                // and React would otherwise see no change at all.
                setRemote((current) => new Map(current).set(otherId, stream));
            };

            connection.onconnectionstatechange = () => {
                if (["failed", "closed"].includes(connection.connectionState)) {
                    inbound.current.delete(otherId);
                    setRemote((current) => {
                        const next = new Map(current);
                        next.delete(otherId);
                        return next;
                    });
                }
            };

            // Every change to what we are sending comes back through here,
            // whichever side made it. Without this a call could be started and
            // never altered.
            connection.onnegotiationneeded = async () => {
                try {
                    peer.makingOffer = true;
                    await connection.setLocalDescription();
                    await send(otherId, {
                        type: "offer",
                        sdp: connection.localDescription?.sdp ?? ""
                    });
                } catch {
                    // A connection torn down mid-negotiation. The teardown is
                    // the outcome; there is nothing to report.
                } finally {
                    peer.makingOffer = false;
                }
            };

            return connection;
        },
        [send]
    );

    /**
     * Put the chosen filter between the microphone and the call, or take away
     * the one that was there.
     *
     * Rebuilt rather than reconfigured whenever the setting or the device
     * changes: the graph is three nodes and a wasm module, and a filter that
     * tried to survive a device swap is a filter reading from a track that has
     * been stopped.
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

    /** Open the microphone and camera, then the stream, then the connections. */
    useEffect(() => {
        // Not in a call: nothing is opened, nothing connects, nothing beats.
        if (!meetingId) return;
        const inCall = meetingId;
        let stopped = false;
        let source: EventSource | null = null;
        let beat: ReturnType<typeof setInterval> | null = null;

        async function start(): Promise<void> {
            ice.current = await actions.iceServersAction(inCall).catch(() => []);
            licensed.current = await actions.licensedFilterAction(inCall).catch(() => null);
            setLicensedFilter(licensed.current !== null);

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    // Echo, background noise and a level that keeps somebody
                    // audible from across the room, all handled by the browser
                    // before anything is sent - see `mic-cleanup`.
                    audio: micConstraints(),
                    video: withVideo
                });
                if (stopped) {
                    for (const track of stream.getTracks()) track.stop();
                    return;
                }
                mic.current = stream.getAudioTracks()[0] ?? null;
                camera.current = stream.getVideoTracks()[0] ?? null;
                setHasCamera(camera.current !== null);
                setMicrophoneId(mic.current?.getSettings().deviceId ?? null);
                setCameraId(camera.current?.getSettings().deviceId ?? null);
                publishLocalPreview();
                void listDevices();
                // Built before the connections are, so the first offer already
                // carries the filtered track and nobody hears the raw room for
                // the second it would take to swap.
                await startFilter();
            } catch {
                // A call with no camera is still a call: the connections are made
                // either way and this browser simply sends nothing.
                setError(
                    "Polaris could not reach your camera or microphone. You can still hear and see everybody else."
                );
            }

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
                    return;
                }
                if (frame.data.kind === "roster") {
                    refresh();
                    return;
                }
                if (frame.data.kind === "ended") {
                    setEnded(true);
                    return;
                }
                void onSignal(frame.data.fromId, frame.data.payload);
            };

            beat = setInterval(() => void actions.keepSeatAction(inCall), KEEPALIVE_MS);
            refresh();
        }

        /**
         * One signal from one other participant.
         *
         * The three lines that matter are the collision test and what each side
         * does about it. Everything else is the ordinary handshake.
         */
        async function onSignal(fromId: string, raw: string): Promise<void> {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                return;
            }
            const signal = signalSchema.safeParse(parsed);
            if (!signal.success) return;

            const connection = peerFor(fromId);
            const peer = peers.current.get(fromId);
            if (!peer) return;

            if (signal.data.type === "candidate") {
                const candidate: RTCIceCandidateInit = {
                    candidate: signal.data.candidate,
                    sdpMid: signal.data.sdpMid ?? undefined,
                    sdpMLineIndex: signal.data.sdpMLineIndex ?? undefined
                };
                if (!connection.remoteDescription) {
                    const held = early.current.get(fromId) ?? [];
                    held.push(candidate);
                    early.current.set(fromId, held);
                    return;
                }
                // A candidate for an offer we chose to ignore belongs to a
                // description that never arrived, so it is dropped with it.
                await connection.addIceCandidate(candidate).catch(() => undefined);
                return;
            }

            // Of any two participants the larger id is the polite one. Both
            // sides run this line and reach opposite answers, which is what
            // makes it a decision rather than a negotiation.
            const polite = (me.current ?? "") > fromId;
            const collision =
                signal.data.type === "offer" &&
                (peer.makingOffer || connection.signalingState !== "stable");
            peer.ignoring = !polite && collision;
            if (peer.ignoring) return;

            await connection
                .setRemoteDescription({ type: signal.data.type, sdp: signal.data.sdp })
                .catch(() => undefined);

            for (const candidate of early.current.get(fromId) ?? []) {
                await connection.addIceCandidate(candidate).catch(() => undefined);
            }
            early.current.delete(fromId);

            if (signal.data.type === "offer") {
                await connection.setLocalDescription();
                void send(fromId, {
                    type: "answer",
                    sdp: connection.localDescription?.sdp ?? ""
                });
            }
        }

        void start();

        return () => {
            stopped = true;
            if (beat) clearInterval(beat);
            source?.close();
            for (const peer of peers.current.values()) peer.connection.close();
            peers.current.clear();
            // The filter first: it reads from the microphone, and a graph left
            // running over a stopped track is a wasm module and an audio thread
            // nobody ever closes.
            void filtered.current?.stop();
            filtered.current = null;
            for (const track of [mic.current, camera.current, screen.current]) track?.stop();
            mic.current = null;
            camera.current = null;
            screen.current = null;
            void actions.leaveCallAction(inCall);
        };
    }, [listDevices, meetingId, peerFor, publishLocalPreview, refresh, send, startFilter, withVideo]);

    /**
     * Open a connection to everybody new whose id is bigger than ours.
     *
     * Only one of the two sides opens it, so a call of six does not build every
     * connection twice; the other side builds its own when the offer arrives.
     * The offer itself is not made here - adding the tracks does that, through
     * negotiation, which is also what carries every later change.
     */
    useEffect(() => {
        const mine = me.current;
        if (!meeting || !mine) return;

        const others = meeting.participants
            .filter((person) => person.admission === "admitted" && person.id !== mine)
            .map((person) => person.id);

        for (const otherId of others) {
            if (peers.current.has(otherId)) continue;
            if (mine >= otherId) continue;
            peerFor(otherId);
        }

        // Anybody who left takes their connection with them.
        for (const [otherId, peer] of peers.current) {
            if (others.includes(otherId)) continue;
            peer.connection.close();
            peers.current.delete(otherId);
            inbound.current.delete(otherId);
            setRemote((current) => {
                const next = new Map(current);
                next.delete(otherId);
                return next;
            });
        }
    }, [meeting, peerFor]);

    const toggleMic = useCallback(() => {
        const track = mic.current;
        if (!track) return;
        setVoiceEnabled(!track.enabled);
        setMicOn(track.enabled);
    }, [setVoiceEnabled]);

    /**
     * Turn the camera on or off.
     *
     * Off is the track disabled rather than stopped: stopping it turns the
     * camera light out but costs a second permission prompt to come back, and a
     * disabled track sends nothing either way.
     *
     * On, when the call started without video, is the one case that has to open
     * the camera - and then put it on every connection, which is a renegotiation.
     */
    const toggleCamera = useCallback(() => {
        const existing = camera.current;
        if (existing) {
            existing.enabled = !existing.enabled;
            setCameraOn(existing.enabled);
            return;
        }
        void navigator.mediaDevices
            .getUserMedia({ video: true })
            .then((stream) => {
                const track = stream.getVideoTracks()[0] ?? null;
                camera.current = track;
                setHasCamera(track !== null);
                setCameraOn(track !== null);
                setCameraId(track?.getSettings().deviceId ?? null);
                if (!screen.current) publishTrack("video", track);
                publishLocalPreview();
                void listDevices();
            })
            .catch(() => setError("Polaris could not reach your camera."));
    }, [listDevices, publishLocalPreview, publishTrack]);

    /**
     * Share a screen, or stop.
     *
     * The screen goes out in place of the camera rather than beside it, so
     * everybody in the room can share at once without the call growing a second
     * stream per person - which on a mesh is what would actually break it. The
     * cost is that a sharer's face is not on screen while they share, which is
     * the trade every browser-side mesh makes.
     */
    const toggleShare = useCallback(() => {
        if (screen.current) {
            screen.current.stop();
            screen.current = null;
            publishTrack("video", camera.current);
            publishLocalPreview();
            setSharing(false);
            playCallSound("shareOff");
            return;
        }
        void navigator.mediaDevices
            .getDisplayMedia({ video: true })
            .then((stream) => {
                const track = stream.getVideoTracks()[0];
                if (!track) return;
                // The browser's own "stop sharing" bar ends the track without
                // going through this hook, and the call has to notice.
                track.onended = () => {
                    screen.current = null;
                    publishTrack("video", camera.current);
                    publishLocalPreview();
                    setSharing(false);
                    playCallSound("shareOff");
                };
                screen.current = track;
                publishTrack("video", track);
                publishLocalPreview();
                setSharing(true);
                playCallSound("shareOn");
            })
            .catch(() => {
                // Cancelling the picker is the ordinary way out of this dialog,
                // not a failure worth a line on the screen.
            });
    }, [publishLocalPreview, publishTrack]);

    /** Silence everybody, and yourself with them - which is what the word means
     *  everywhere else, and what stops a deafened microphone carrying a room
     *  nobody in it can hear. */
    const toggleDeafen = useCallback(() => {
        setDeafened((current) => {
            const next = !current;
            if (mic.current) {
                setVoiceEnabled(!next);
                setMicOn(mic.current.enabled);
            }
            return next;
        });
    }, [setVoiceEnabled]);

    /** Swap one input for another, mid-call, without dropping the connections. */
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
                        // Rebuilt against the new device: the old graph was
                        // reading from the track just stopped.
                        await startFilter();
                        publishTrack("audio", outgoingMic());
                    } else {
                        track.enabled = cameraOn;
                        camera.current = track;
                        setCameraId(deviceId);
                        // A screen being shared stays on the wire: picking a
                        // different camera is not a decision to stop sharing.
                        if (!screen.current) publishTrack("video", track);
                    }
                    publishLocalPreview();
                })
                .catch(() => setError("Polaris could not open that device."));
        },
        [cameraOn, deafened, micOn, outgoingMic, publishLocalPreview, publishTrack, startFilter]
    );

    /**
     * Everything with sound in it, by the participant it belongs to, so one
     * meter can watch the whole room.
     *
     * This browser's own is in it under its own participant id: somebody needs
     * to see that their microphone is working at least as much as they need to
     * see that somebody else's is, and it is the same measurement.
     */
    const audible = useMemo(() => {
        const streams = new Map<string, MediaStream | null>(remote);
        if (participantId) streams.set(participantId, localStream);
        return streams;
    }, [remote, localStream, participantId]);

    const speaking = useSpeaking(audible, !ended);

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

    const chooseMicrophone = useCallback(
        (deviceId: string) => chooseDevice("audio", deviceId),
        [chooseDevice]
    );

    /**
     * Change how much is done to the microphone, mid-call.
     *
     * The device is never reopened: the browser's three processors move on the
     * track that is already open, and the model is a graph built beside it. What
     * the call sends is then swapped with `replaceTrack`, so nobody is
     * renegotiated at and nothing pauses.
     */
    const [cleanMic, rememberCleanMic] = useMicCleanup();
    const setCleanMic = useCallback(
        (level: MicFilter) => {
            rememberCleanMic(level);
            void (async () => {
                await startFilter();
                publishTrack("audio", outgoingMic());
                publishLocalPreview();
            })();
        },
        [outgoingMic, publishLocalPreview, publishTrack, rememberCleanMic, startFilter]
    );
    const chooseCamera = useCallback(
        (deviceId: string) => chooseDevice("video", deviceId),
        [chooseDevice]
    );

    return {
        meeting,
        participantId,
        localStream,
        remote,
        speaking,
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

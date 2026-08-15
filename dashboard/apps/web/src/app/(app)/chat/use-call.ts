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
 * The one genuinely hard part of a mesh is glare: two peers offering each other
 * a connection at the same instant, each rejecting the other's offer. The fix
 * here is to make the decision unilateral rather than negotiated - of any two
 * participants, the one with the smaller id offers and the other one answers.
 * Both sides can work that out on their own from ids they already have, so there
 * is nothing to agree on and nothing to race over.
 *
 * Everything is torn down on the way out: tracks stopped, connections closed,
 * seat given up. A camera light left on after somebody closed the tab is the
 * kind of bug people do not forgive.
 */

import { z } from "zod";
import * as actions from "./meeting-actions";
import type { MeetingView } from "@/lib/chat/meetings";
import { useCallback, useEffect, useRef, useState } from "react";

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

export interface CallState {
    readonly meeting: MeetingView | null;
    readonly participantId: string | null;
    readonly localStream: MediaStream | null;
    /** Remote video and audio, by the participant id it belongs to. */
    readonly remote: ReadonlyMap<string, MediaStream>;
    readonly micOn: boolean;
    readonly cameraOn: boolean;
    readonly ended: boolean;
    /** What went wrong, in a sentence the call screen can show. Most often the
     *  browser refusing the camera, which is the reader's decision to reverse. */
    readonly error: string;
    toggleMic: () => void;
    toggleCamera: () => void;
    refresh: () => void;
}

export function useCall(meetingId: string): CallState {
    const [meeting, setMeeting] = useState<MeetingView | null>(null);
    const [participantId, setParticipantId] = useState<string | null>(null);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remote, setRemote] = useState<ReadonlyMap<string, MediaStream>>(new Map());
    const [micOn, setMicOn] = useState(true);
    const [cameraOn, setCameraOn] = useState(true);
    const [ended, setEnded] = useState(false);
    const [error, setError] = useState("");

    const peers = useRef(new Map<string, RTCPeerConnection>());
    const ice = useRef<RTCIceServer[]>([]);
    const local = useRef<MediaStream | null>(null);
    const me = useRef<string | null>(null);
    // Candidates that arrived before the description they belong to, which is
    // ordinary rather than exceptional - the two travel over different requests.
    const early = useRef(new Map<string, RTCIceCandidateInit[]>());

    const refresh = useCallback(() => {
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
            await fetch(`/api/chat/meetings/${meetingId}/signal`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ toId, payload: JSON.stringify(payload) })
            }).catch(() => undefined);
        },
        [meetingId]
    );

    /** The connection to one other participant, made if it does not exist. */
    const peerFor = useCallback(
        (otherId: string): RTCPeerConnection => {
            const existing = peers.current.get(otherId);
            if (existing) return existing;

            const connection = new RTCPeerConnection({ iceServers: ice.current });
            peers.current.set(otherId, connection);

            for (const track of local.current?.getTracks() ?? []) {
                connection.addTrack(track, local.current!);
            }

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
                const stream = event.streams[0];
                if (!stream) return;
                setRemote((current) => new Map(current).set(otherId, stream));
            };

            connection.onconnectionstatechange = () => {
                if (["failed", "closed"].includes(connection.connectionState)) {
                    setRemote((current) => {
                        const next = new Map(current);
                        next.delete(otherId);
                        return next;
                    });
                }
            };

            return connection;
        },
        [send]
    );

    /** Open the microphone and camera, then the stream, then the connections. */
    useEffect(() => {
        let stopped = false;
        let source: EventSource | null = null;
        let beat: ReturnType<typeof setInterval> | null = null;

        async function start(): Promise<void> {
            ice.current = await actions.iceServersAction(meetingId).catch(() => []);

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: true
                });
                if (stopped) {
                    for (const track of stream.getTracks()) track.stop();
                    return;
                }
                local.current = stream;
                setLocalStream(stream);
            } catch {
                // A call with no camera is still a call: the connections are made
                // either way and this browser simply sends nothing.
                setError(
                    "Polaris could not reach your camera or microphone. You can still hear and see everybody else."
                );
            }

            if (stopped) return;

            source = new EventSource(`/api/chat/meetings/${meetingId}/stream`);
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

            beat = setInterval(() => void actions.keepSeatAction(meetingId), KEEPALIVE_MS);
            refresh();
        }

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
                await connection.addIceCandidate(candidate).catch(() => undefined);
                return;
            }

            await connection.setRemoteDescription({
                type: signal.data.type,
                sdp: signal.data.sdp
            });

            for (const candidate of early.current.get(fromId) ?? []) {
                await connection.addIceCandidate(candidate).catch(() => undefined);
            }
            early.current.delete(fromId);

            if (signal.data.type === "offer") {
                const answer = await connection.createAnswer();
                await connection.setLocalDescription(answer);
                void send(fromId, { type: "answer", sdp: answer.sdp ?? "" });
            }
        }

        void start();

        return () => {
            stopped = true;
            if (beat) clearInterval(beat);
            source?.close();
            for (const connection of peers.current.values()) connection.close();
            peers.current.clear();
            for (const track of local.current?.getTracks() ?? []) track.stop();
            local.current = null;
            void actions.leaveCallAction(meetingId);
        };
    }, [meetingId, peerFor, refresh, send]);

    /**
     * Offer a connection to everybody new whose id is bigger than ours.
     *
     * The comparison is the whole glare protocol: the other side runs the same
     * line, reaches the opposite answer, and waits for our offer.
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
            const connection = peerFor(otherId);
            void connection
                .createOffer()
                .then(async (offer) => {
                    await connection.setLocalDescription(offer);
                    await send(otherId, { type: "offer", sdp: offer.sdp ?? "" });
                })
                .catch(() => undefined);
        }

        // Anybody who left takes their connection with them.
        for (const [otherId, connection] of peers.current) {
            if (others.includes(otherId)) continue;
            connection.close();
            peers.current.delete(otherId);
            setRemote((current) => {
                const next = new Map(current);
                next.delete(otherId);
                return next;
            });
        }
    }, [meeting, peerFor, send]);

    const toggleMic = useCallback(() => {
        const tracks = local.current?.getAudioTracks() ?? [];
        const next = !tracks.every((track) => track.enabled);
        for (const track of tracks) track.enabled = next;
        setMicOn(next);
    }, []);

    const toggleCamera = useCallback(() => {
        const tracks = local.current?.getVideoTracks() ?? [];
        const next = !tracks.every((track) => track.enabled);
        for (const track of tracks) track.enabled = next;
        setCameraOn(next);
    }, []);

    return {
        meeting,
        participantId,
        localStream,
        remote,
        micOn,
        cameraOn,
        ended,
        error,
        toggleMic,
        toggleCamera,
        refresh
    };
}

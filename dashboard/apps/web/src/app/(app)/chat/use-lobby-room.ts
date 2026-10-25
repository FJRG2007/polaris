"use client";

/**
 * A game lobby's room: the media server's data channel and attributes, and
 * nothing else - no microphone, no camera, no ringing. It gives the activity
 * hook (`useCallActivity`) exactly what a call gives it, so a game plays the
 * same in a lobby as in a call. The ticket says the same: it cannot publish a
 * track (`lobbyToken`).
 */

import type { Room } from "livekit-client";
import { callServerUrl } from "./call-address";
import type { ActivityTransport } from "./call-activity-panel";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVITY_ATTRIBUTE, ACTIVITY_TOPIC } from "@/lib/chat/call-activity";

export interface LobbyTicket {
    readonly url: string;
    readonly token: string;
    readonly seat: string;
}

export type LobbyRoom = ActivityTransport & {
    readonly status: "connecting" | "connected" | "failed";
};

interface Peer {
    readonly id: string;
    readonly name: string;
    readonly activity: string;
}

export function useLobbyRoom(ticket: LobbyTicket | null): LobbyRoom {
    const room = useRef<Room | null>(null);
    const heard = useRef<((from: string, raw: unknown) => void) | null>(null);
    const mine = useRef("");
    const [peers, setPeers] = useState<readonly Peer[]>([]);
    const [status, setStatus] = useState<LobbyRoom["status"]>("connecting");

    useEffect(() => {
        if (!ticket) return;
        let stopped = false;
        let joined: Room | null = null;
        setStatus("connecting");
        void (async () => {
            try {
                const { Room: LiveRoom, RoomEvent } = await import("livekit-client");
                if (stopped) return;
                joined = new LiveRoom({ adaptiveStream: false, dynacast: false });
                const read = () => {
                    const current = joined;
                    if (!current) return;
                    setPeers(
                        [...current.remoteParticipants.values()].map((participant) => ({
                            id: participant.identity,
                            name: participant.name ?? "",
                            activity: participant.attributes?.[ACTIVITY_ATTRIBUTE] ?? ""
                        }))
                    );
                };
                joined
                    .on(RoomEvent.ParticipantConnected, read)
                    .on(RoomEvent.ParticipantDisconnected, read)
                    .on(RoomEvent.ParticipantAttributesChanged, read)
                    .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
                        if (topic !== ACTIVITY_TOPIC || !participant) return;
                        try {
                            const raw: unknown = JSON.parse(new TextDecoder().decode(payload));
                            heard.current?.(participant.identity, raw);
                        } catch {
                            // Not JSON: dropped, like anything else that does not fit.
                        }
                    })
                    .on(RoomEvent.Disconnected, () => {
                        if (!stopped) setStatus("failed");
                    });
                await joined.connect(callServerUrl(ticket.url), ticket.token);
                if (stopped) {
                    void joined.disconnect();
                    return;
                }
                room.current = joined;
                if (mine.current)
                    void joined.localParticipant
                        .setAttributes({ [ACTIVITY_ATTRIBUTE]: mine.current })
                        .catch(() => undefined);
                read();
                setStatus("connected");
            } catch {
                if (!stopped) setStatus("failed");
            }
        })();
        return () => {
            stopped = true;
            room.current = null;
            void joined?.disconnect();
        };
    }, [ticket]);

    const setActivity = useCallback((claim: string) => {
        mine.current = claim;
        void room.current?.localParticipant
            .setAttributes({ [ACTIVITY_ATTRIBUTE]: claim })
            .catch(() => undefined);
    }, []);

    const sendActivity = useCallback((to: readonly string[], message: unknown) => {
        const local = room.current?.localParticipant;
        if (!local || to.length === 0) return;
        void local
            .publishData(new TextEncoder().encode(JSON.stringify(message)), {
                reliable: false,
                topic: ACTIVITY_TOPIC,
                destinationIdentities: [...to]
            })
            .catch(() => undefined);
    }, []);

    const listenActivity = useCallback((listener: (from: string, raw: unknown) => void) => {
        heard.current = listener;
        return () => {
            if (heard.current === listener) heard.current = null;
        };
    }, []);

    const [states, setStates] = useState<ReadonlyMap<string, { readonly activity?: string }>>(
        new Map()
    );
    const [meeting, setMeeting] = useState<LobbyRoom["meeting"]>(null);
    useEffect(() => {
        setStates(new Map(peers.map((peer) => [peer.id, { activity: peer.activity }])));
        setMeeting({ participants: peers.map((peer) => ({ id: peer.id, name: peer.name })) });
    }, [peers]);

    return {
        participantId: status === "connected" ? (ticket?.seat ?? null) : null,
        states,
        meeting,
        setActivity,
        sendActivity,
        listenActivity,
        status
    };
}

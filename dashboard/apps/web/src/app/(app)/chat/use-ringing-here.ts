"use client";

/**
 * Whether this conversation is ringing at the reader, for the call stage.
 *
 * Read off the same frames the corner card reads, and kept in step with it
 * through the channel the tabs already share: a call the card declined or
 * answered stops ringing here, and one declined here stops the card - in this
 * tab and in every other one.
 */

import { useChatStream } from "./use-chat-stream";
import { useSessionScope } from "@/components/session-scope";
import { playCallSound, RING_FOR_MS } from "@/lib/call-sounds";
import { useCallback, useEffect, useRef, useState } from "react";
import { openPeerChannel, type PeerChannel } from "@/lib/shared-stream";
import { ringAfter, ringExpired, type StageRing } from "@/lib/chat/call-stage";
import { CALLS_CHANNEL, callTabMessageSchema, type CallTabMessage } from "@/lib/chat/call-tabs";

export function useRingingHere(
    channelId: string,
    viewerId: string,
    inCall: string | null
): { ring: StageRing | null; decline: () => void } {
    const scope = useSessionScope();
    const [ring, setRing] = useState<StageRing | null>(null);
    const peers = useRef<PeerChannel<CallTabMessage> | null>(null);

    // Another conversation is another set of calls.
    useEffect(() => setRing(null), [channelId]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "call") return;
                setRing((current) => ringAfter(current, frame, viewerId, channelId, Date.now()));
            },
            [channelId, viewerId]
        )
    );

    useEffect(() => {
        const channel = openPeerChannel<CallTabMessage>(CALLS_CHANNEL, scope, (message) => {
            const parsed = callTabMessageSchema.safeParse(message);
            if (!parsed.success || parsed.data.kind !== "settled") return;
            const meetingId = parsed.data.meetingId;
            setRing((current) => (current?.meetingId === meetingId ? null : current));
        });
        peers.current = channel;
        return () => {
            peers.current = null;
            channel.close();
        };
    }, [scope]);

    // Answered here: leaving the call later must not bring the ringing back.
    useEffect(() => {
        if (inCall) setRing((current) => (current?.meetingId === inCall ? null : current));
    }, [inCall]);

    // Stops when a telephone would, like the corner card.
    useEffect(() => {
        if (!ring) return;
        const left = Math.max(0, ring.at + RING_FOR_MS - Date.now());
        const timer = setTimeout(() => {
            setRing((current) =>
                current && ringExpired(current, Date.now(), RING_FOR_MS) ? null : current
            );
        }, left);
        return () => clearTimeout(timer);
    }, [ring]);

    const decline = useCallback(() => {
        if (!ring) return;
        playCallSound("hangUp");
        peers.current?.post({ kind: "settled", meetingId: ring.meetingId });
        setRing(null);
    }, [ring]);

    return { ring, decline };
}

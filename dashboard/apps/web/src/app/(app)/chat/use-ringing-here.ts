"use client";

/**
 * Whether this conversation is ringing at the reader, for the call stage.
 *
 * Read off the same frames the corner card reads, and kept in step with it
 * through the channel the tabs already share: a call the card declined or
 * answered stops ringing here, and one declined here stops the card - in this
 * tab and in every other one.
 *
 * What the card is still ringing about counts too: a conversation opened after
 * the ring arrived - from the desktop notice, which is how most people get
 * there - never saw the frame, and still has to ring.
 */

import { useChatStream } from "./use-chat-stream";
import { useSessionScope } from "@/components/session-scope";
import { playCallSound, RING_FOR_MS } from "@/lib/call-sounds";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openPeerChannel, type PeerChannel } from "@/lib/shared-stream";
import {
    cardRingIn,
    cardRingsKey,
    ringAfter,
    ringExpired,
    subscribeStages,
    type StageRing
} from "@/lib/chat/call-stage";
import { CALLS_CHANNEL, callTabMessageSchema, type CallTabMessage } from "@/lib/chat/call-tabs";

export function useRingingHere(
    channelId: string,
    viewerId: string,
    inCall: string | null
): { ring: StageRing | null; silenced: boolean; decline: () => void; silence: () => void } {
    const scope = useSessionScope();
    const [heard, setRing] = useState<StageRing | null>(null);
    useSyncExternalStore(subscribeStages, cardRingsKey, () => "");
    const card = cardRingIn(channelId);
    // The card's ring first: it is the one that knows about silencing, and the
    // one that was there before this conversation was opened.
    const ring: StageRing | null =
        card && card.meetingId !== inCall
            ? { meetingId: card.meetingId, callerId: card.callerId, name: card.name, at: card.at }
            : heard;
    const silenced = card !== null && card.meetingId === ring?.meetingId && card.silenced;
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
        if (!heard) return;
        const left = Math.max(0, heard.at + RING_FOR_MS - Date.now());
        const timer = setTimeout(() => {
            setRing((current) =>
                current && ringExpired(current, Date.now(), RING_FOR_MS) ? null : current
            );
        }, left);
        return () => clearTimeout(timer);
    }, [heard]);

    const decline = useCallback(() => {
        if (!ring) return;
        playCallSound("hangUp");
        peers.current?.post({ kind: "settled", meetingId: ring.meetingId });
        setRing(null);
    }, [ring]);

    /** Stop the sound, keep the call - the card's middle answer, said to it and
     *  to every other tab the way the card says it. */
    const silence = useCallback(() => {
        if (!ring) return;
        peers.current?.post({ kind: "silenced", meetingId: ring.meetingId });
    }, [ring]);

    return { ring, silenced, decline, silence };
}

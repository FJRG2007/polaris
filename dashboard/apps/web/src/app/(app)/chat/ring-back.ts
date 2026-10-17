/**
 * The tone the caller hears while the other side is rung.
 *
 * A call placed from here rang the other person's telephone and left the caller
 * in silence, so nothing told them the call was going anywhere until somebody
 * picked up. The tone existed (`startRinging("ringBack")`); nothing started it.
 *
 * It plays from the moment a call that rang somebody is placed until somebody
 * else is in it, the call ends, the caller leaves or deafens, or the ring gives
 * up after `RING_FOR_MS` - the same span the other side's telephone rings for.
 * A decline is not told to the caller, by design, so it ends there too.
 *
 * Only the tab that placed the call carries `placedAt`: a second tab, a call
 * joined rather than started, and a call brought back after a reload never
 * ring back. Once anybody has answered, the call never rings back again, so a
 * reconnect that briefly shows the room empty stays silent.
 */

import { useEffect, useRef } from "react";
import type { CallSession } from "./call-hold";
import type { MeetingParticipantView } from "@/lib/chat/meetings";
import { RING_FOR_MS, startRinging, willBeHeard } from "@/lib/call-sounds";

/** What placing the call said, as the session field it becomes. */
export function placed(result: { rang?: boolean }): { placedAt?: number } {
    return result.rang ? { placedAt: Date.now() } : {};
}

export interface RingBackInput {
    /** When the call was placed, or absent when it rang nobody from here. */
    readonly placedAt: number | undefined;
    readonly now: number;
    /** Somebody else has been seen admitted to this call. Latched by the caller. */
    readonly answered: boolean;
    readonly ended: boolean;
    readonly deafened: boolean;
}

/** How much longer the caller should hear the tone, in milliseconds. Zero is silence. */
export function ringBackLeft({ placedAt, now, answered, ended, deafened }: RingBackInput): number {
    if (placedAt === undefined || answered || ended || deafened) return 0;
    return Math.max(0, placedAt + RING_FOR_MS - now);
}

/** Whether anybody but this browser's own seat, and its own account, is in the call. */
export function somebodyElseIn(
    participants: readonly Pick<MeetingParticipantView, "id" | "userId" | "admission">[],
    ownParticipantId: string | null,
    viewerId: string
): boolean {
    return participants.some(
        (person) =>
            person.admission === "admitted" &&
            person.id !== ownParticipantId &&
            person.userId !== viewerId
    );
}

/** The call as the tone reads it. */
export interface RingBackCall {
    readonly participantId: string | null;
    readonly meeting: {
        readonly participants: readonly Pick<
            MeetingParticipantView,
            "id" | "userId" | "admission"
        >[];
    } | null;
    readonly ended: boolean;
    readonly deafened: boolean;
}

/**
 * Play the tone for as long as `ringBackLeft` says.
 *
 * The passes are scheduled on the audio clock for exactly the time left, so the
 * tone stops by itself at the deadline even in a tab the browser is throttling;
 * anything that ends it sooner stops it here. It follows the sound level and the
 * chosen speaker the way every ring does, and says nothing where this tab cannot
 * be heard.
 */
export function useRingBack(call: RingBackCall, session: CallSession | null, viewerId: string): void {
    const meetingId = session?.meetingId ?? null;
    const placedAt = session?.placedAt;
    /** The call somebody answered, which never rings back again. */
    const answeredIn = useRef<string | null>(null);
    if (
        meetingId &&
        answeredIn.current !== meetingId &&
        somebodyElseIn(call.meeting?.participants ?? [], call.participantId, viewerId)
    ) {
        answeredIn.current = meetingId;
    }
    const ringing =
        ringBackLeft({
            placedAt,
            now: Date.now(),
            answered: meetingId !== null && answeredIn.current === meetingId,
            ended: call.ended,
            deafened: call.deafened
        }) > 0;

    useEffect(() => {
        if (!ringing || placedAt === undefined) return;
        let stop: (() => void) | null = null;
        let gone = false;
        void willBeHeard().then((heard) => {
            const left = placedAt + RING_FOR_MS - Date.now();
            if (gone || !heard || left <= 0) return;
            stop = startRinging("ringBack", left);
        });
        return () => {
            gone = true;
            stop?.();
        };
    }, [ringing, meetingId, placedAt]);
}

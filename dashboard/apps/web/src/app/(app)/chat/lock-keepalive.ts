"use client";

/**
 * Keeps an open locked conversation open while the reader is using it.
 *
 * The unlock lasts as long as the reader chose in the lock settings, and that
 * window slides: a key, a click, a scroll or a touch in Polaris while the
 * conversation is open renews the proofs this tab holds, so the code is never
 * asked for in the middle of a conversation. Left alone for the whole duration,
 * the conversation closes behind its gate again. Under "immediately" it stays
 * open while it is on screen and the proof is thrown away when the reader leaves.
 */

import { useEffect, useRef } from "react";
import * as timing from "@/lib/chat/lock-timing";
import { renewUnlocksAction } from "./lock-actions";
import {
    forgetUnlockProof,
    heldUnlockProofs,
    keepUnlockProofs,
    unlockProofFor
} from "./lock-session";

const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

export function useUnlockKeepAlive({
    channelId,
    open,
    minutes,
    onExpired
}: {
    channelId: string;
    /** A locked conversation whose messages are on screen. */
    open: boolean;
    minutes: number;
    /** The proof ran out: put the gate back. */
    onExpired: () => void;
}): void {
    const expired = useRef(onExpired);
    expired.current = onExpired;

    useEffect(() => {
        if (!open) return;
        let lastActivity = Date.now();
        let lastRenew = Date.now();
        let renewing = false;
        const seen = () => {
            lastActivity = Date.now();
        };
        for (const kind of ACTIVITY)
            window.addEventListener(kind, seen, { passive: true, capture: true });

        const tick = async () => {
            const visible = document.visibilityState === "visible";
            if (!renewing && timing.shouldRenew({ minutes, lastActivity, lastRenew, visible })) {
                const held = heldUnlockProofs();
                if (Object.keys(held).length > 0) {
                    renewing = true;
                    try {
                        const result = await renewUnlocksAction({ proofs: held });
                        if (result.proofs) {
                            keepUnlockProofs(result.proofs);
                            lastRenew = Date.now();
                        }
                    } catch {
                        // Offline for a moment: the next tick tries again.
                    } finally {
                        renewing = false;
                    }
                }
            }
            if (!unlockProofFor(channelId)) expired.current();
        };
        const timer = window.setInterval(() => void tick(), timing.renewEveryMs(minutes));

        return () => {
            window.clearInterval(timer);
            for (const kind of ACTIVITY) window.removeEventListener(kind, seen, { capture: true });
            if (timing.unlockMinutesOf(minutes) === timing.UNLOCK_IMMEDIATELY)
                forgetUnlockProof(channelId);
        };
    }, [channelId, open, minutes]);
}

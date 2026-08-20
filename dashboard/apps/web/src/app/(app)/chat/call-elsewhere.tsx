"use client";

/**
 * Your call, on the other device.
 *
 * Signing in on a phone while a call is running on a desk used to say nothing at
 * all. Not nothing useful - nothing: an account holds one seat in a call, so the
 * phone was not a second participant and there was no roster change to notice,
 * and pressing Join there would silently have taken the call over with the other
 * browser never finding out. Two microphones open, one seat, no explanation on
 * either screen.
 *
 * So the phone asks. It is the same question a telephone answers by ringing in
 * one place: where is this call, and do you want it here?
 *
 * Drawn only where there is a call and this browser is not in it. Once it is
 * moved this browser is the one on the line, the other one hangs up, and the
 * card has nothing left to offer.
 */

import { Button } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { useCallHold } from "./call-session";
import { Phone, PhoneOff } from "lucide-react";
import { useChatStream } from "./use-chat-stream";
import { useCallback, useEffect, useState } from "react";
// The shape from the module that defines it: a "use server" file exports only
// the actions themselves.
import type { CallElsewhere as Found } from "@/lib/chat/meetings";
import { callElsewhereAction, joinCallAction } from "./meeting-actions";

/** How long to wait before asking again after being dismissed, so that saying
 *  "not now" is not undone by the next thing that happens in any conversation. */
const ASKED = "polaris.call.elsewhere.dismissed";

export function CallElsewhere() {
    const router = useRouter();
    const { session, enter } = useCallHold();
    const [found, setFound] = useState<Found | null>(null);
    const [hidden, setHidden] = useState<string | null>(null);
    const [moving, setMoving] = useState(false);
    const [failed, setFailed] = useState("");

    const look = useCallback(() => {
        // A browser that is in a call is the device holding it. Asking would
        // only ever find its own seat.
        if (session) {
            setFound(null);
            return;
        }
        void callElsewhereAction()
            .then(setFound)
            .catch(() => setFound(null));
    }, [session]);

    useEffect(() => {
        look();
        if (typeof window !== "undefined") {
            setHidden(window.sessionStorage?.getItem(ASKED) ?? null);
        }
    }, [look]);

    // Anything happening to a call anywhere is a reason to ask again: it may
    // have ended, and a card offering to move a call that is over is worse than
    // no card.
    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "call") look();
            },
            [look]
        )
    );

    if (!found || session || hidden === found.meetingId) return null;

    /**
     * Take it.
     *
     * Joining first, and that is the whole of what was wrong before: this opened
     * the call locally and never asked to be let in. An account's seat is reused
     * rather than made again, so most of the time the join changes nothing - but
     * "most of the time" is not the interesting case. A seat that was given up
     * between the card being drawn and the button being pressed, or a call that
     * ended in that second, left a browser holding a session for a room it was
     * not in: the bar sat there offering to mute and hang up a call that did not
     * exist, and nothing on the screen said so.
     *
     * The room is only entered once the server has agreed.
     */
    const move = async () => {
        setMoving(true);
        setFailed("");
        const result = await joinCallAction(found.meetingId).catch(() => ({
            error: "That call could not be reached."
        }));
        setMoving(false);
        if (result.error) {
            // Over, or given up in the meantime. The card goes with it rather
            // than sitting there offering it again.
            setFailed(result.error);
            setFound(null);
            return;
        }
        enter(
            { meetingId: found.meetingId, channelId: found.channelId, title: found.title },
            // Never the camera. Moving a call is not a decision to be seen, and
            // the switch is in the room.
            false
        );
        // The conversation as well as the call: arriving in the room it moved
        // into, rather than staying on whatever screen it was pressed from.
        router.push(`/chat/c/${found.channelId}`);
    };

    const dismiss = () => {
        setHidden(found.meetingId);
        try {
            window.sessionStorage?.setItem(ASKED, found.meetingId);
        } catch {
            // Storage refused. The card stays gone for this page either way,
            // which is what was asked for.
        }
    };

    return (
        <div className="flex justify-end">
            <div
                role="status"
                className="pointer-events-auto flex w-72 flex-col gap-3 rounded-lg border border-border-strong bg-elevated p-3 shadow-modal"
            >
                <span className="flex items-center gap-2.5">
                    <Phone className="size-4 shrink-0 animate-pulse text-success" />
                    <span className="min-w-0 flex-1 text-sm font-medium">
                        You are in a call on another device
                    </span>
                </span>
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                    Moving it here hangs up there. A call is in one place at a time.
                </p>
                {failed ? <p className="text-[12px] text-danger">{failed}</p> : null}

                <span className="flex items-center gap-2">
                    <Button size="sm" className="flex-1" disabled={moving} onClick={move}>
                        <Phone className="size-4" />
                        {moving ? "Moving" : "Move it here"}
                    </Button>
                    <Button size="sm" variant="secondary" aria-label="Leave it" onClick={dismiss}>
                        <PhoneOff className="size-4" />
                    </Button>
                </span>
            </div>
        </div>
    );
}

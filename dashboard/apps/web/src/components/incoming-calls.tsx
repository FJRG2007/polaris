"use client";

/**
 * Somebody is calling.
 *
 * Mounted by the dashboard shell rather than by Chat, and that is the point: a
 * call you only find out about by already looking at the conversation it is in
 * is not a call, it is a notice. Whoever is reading a log or a task board has to
 * be told, which is what every messenger does and what Polaris did not.
 *
 * It rings, once, for as long as a telephone would. The sound is synthesised
 * rather than fetched - see `call-sounds` - so it needs no asset and no network,
 * and it is refused rather than played on a tab the reader has never touched,
 * which is every browser's rule and not one worth fighting.
 *
 * Answering is a navigation, not a join: the conversation's own screen is where
 * a call is joined, and having two places that can put somebody into a room is
 * how one of them ends up with a camera nobody turned off.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { Phone, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";
import { RING_FOR_MS, playCallSound, startRinging } from "@/lib/call-sounds";

interface Ringing {
    readonly channelId: string;
    readonly meetingId: string;
    /** Who started it. Empty where the server had no name to give, which is
     *  every case except a person pressing the button. */
    readonly name: string;
    readonly at: number;
}

export function IncomingCalls() {
    const pathname = usePathname();
    const [ringing, setRinging] = useState<readonly Ringing[]>([]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "call") return;
                if (frame.state === "ringing") {
                    setRinging((current) =>
                        current.some((entry) => entry.meetingId === frame.meetingId)
                            ? current
                            : [
                                  ...current,
                                  {
                                      channelId: frame.channelId,
                                      meetingId: frame.meetingId,
                                      name: frame.name,
                                      at: Date.now()
                                  }
                              ]
                    );
                    return;
                }
                // Nobody is left in it, or it is over. Either way there is
                // nothing to answer, and a card offering to join an empty room
                // is worse than no card.
                if (frame.state === "ended" || frame.count === 0) {
                    setRinging((current) =>
                        current.filter((entry) => entry.meetingId !== frame.meetingId)
                    );
                }
            },
            []
        )
    );

    // Already standing in the conversation it is in: the call is on that screen,
    // with its own button. Ringing at somebody about a room they are looking at
    // is how a notification becomes noise.
    const showing = ringing.filter((entry) => !pathname.startsWith(`/chat/c/${entry.channelId}`));

    // One ring for however many are waiting, and silence once none are.
    useEffect(() => {
        if (showing.length === 0) return;
        return startRinging("ring");
    }, [showing.length]);

    // A call nobody answered stops asking. The same span the sound gives up
    // after, so the card never sits there silent.
    useEffect(() => {
        if (ringing.length === 0) return;
        const timer = setInterval(() => {
            const cutoff = Date.now() - RING_FOR_MS;
            setRinging((current) => current.filter((entry) => entry.at > cutoff));
        }, 1000);
        return () => clearInterval(timer);
    }, [ringing.length]);

    if (showing.length === 0) return null;

    const dismiss = (meetingId: string) =>
        setRinging((current) => current.filter((entry) => entry.meetingId !== meetingId));

    return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            {showing.map((entry) => (
                <div
                    key={entry.meetingId}
                    role="alert"
                    className="pointer-events-auto flex w-72 flex-col gap-3 rounded-lg border border-border-strong bg-elevated p-3 shadow-modal"
                >
                    <span className="flex items-center gap-2">
                        <Phone className="size-4 animate-pulse text-success" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {entry.name || "Somebody"} is calling
                        </span>
                    </span>
                    <span className="flex items-center gap-2">
                        <Button
                            asChild
                            size="sm"
                            className="flex-1"
                            onClick={() => dismiss(entry.meetingId)}
                        >
                            <Link href={`/chat/c/${entry.channelId}`}>
                                <Phone className="size-4" />
                                Answer
                            </Link>
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            aria-label="Decline"
                            title="Decline"
                            onClick={() => {
                                // Declined here and nowhere else: the caller is
                                // not told, because a missed call and a refused
                                // one look the same from the other end and
                                // Polaris has no business saying which it was.
                                playCallSound("hangUp");
                                dismiss(entry.meetingId);
                            }}
                        >
                            <PhoneOff className="size-4" />
                        </Button>
                    </span>
                </div>
            ))}
        </div>
    );
}

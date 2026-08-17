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
 * Answering navigates and joins: the conversation's own screen is still the one
 * place that puts anybody into a room - it carries the answer in the address and
 * the screen acts on it - because two places that can open a microphone is how
 * one of them ends up with a camera nobody turned on.
 */

import Link from "next/link";
import { Avatar } from "./avatar";
import { Button } from "@polaris/ui";
import { Phone, PhoneOff } from "lucide-react";
import { useHeldCall } from "@/app/(app)/chat/call-session";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";
import { notifyDesktop, tabIsWatched } from "@/lib/desktop-notify";
import { RING_FOR_MS, playCallSound, startRinging } from "@/lib/call-sounds";

interface Ringing {
    readonly channelId: string;
    readonly meetingId: string;
    /** Who started it. Empty where the server had no name to give, which is
     *  every case except a person pressing the button. */
    readonly name: string;
    /** Their account, for the face on the card. A name on its own is read; a
     *  face is recognised, which is the whole of what somebody deciding whether
     *  to answer is doing. */
    readonly userId: string;
    /** Whether this tab is the one holding the live connection. The sound and
     *  the notice the operating system draws belong to the device, so only that
     *  tab makes them - five open tabs are still one ringing telephone. */
    readonly owner: boolean;
    readonly at: number;
}

export function IncomingCalls({ viewerId }: { viewerId: string }) {
    const held = useHeldCall();
    const [ringing, setRinging] = useState<readonly Ringing[]>([]);
    const inCall = held?.session?.meetingId ?? null;

    useChatStream(
        useCallback(
            (frame, context) => {
                if (frame.kind !== "call") return;
                if (frame.state === "ringing") {
                    // Your own call. The frame is addressed to the conversation,
                    // and the person who pressed the button is in it - so without
                    // this, starting a call rang at the person starting it.
                    if (frame.userId === viewerId) return;
                    setRinging((current) =>
                        current.some((entry) => entry.meetingId === frame.meetingId)
                            ? current
                            : [
                                  ...current,
                                  {
                                      channelId: frame.channelId,
                                      meetingId: frame.meetingId,
                                      name: frame.name,
                                      userId: frame.userId,
                                      owner: context.owner,
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
            [viewerId]
        )
    );

    /**
     * Everything still worth being told about, drawn wherever the reader is
     * standing.
     *
     * A call this browser is already sitting in is not an incoming call - it is
     * the call - and that is the only thing left out.
     *
     * It used to also skip the conversation the call is in, on the reasoning
     * that the room is right there with its own way in. That reasoning was
     * wrong, and it was wrong in the case that matters most. What actually
     * changed on that screen when a call came in was a small button in the
     * header growing a number - above the messages somebody was reading, in the
     * corner they were not looking at, with no green button anywhere and no way
     * to answer that did not involve noticing it. A call arriving is exactly the
     * moment a chat is allowed to interrupt, and the answer is the one a
     * telephone gives: put it in front of them.
     */
    const showing = ringing.filter((entry) => entry.meetingId !== inCall);

    /**
     * One ring for however many are waiting, and silence once none are.
     *
     * Only the tab holding the connection: the others are the same browser, and
     * a telephone that rings once per open tab is a telephone people mute.
     */
    const sounding = showing.some((entry) => entry.owner);
    useEffect(() => {
        if (!sounding) return;
        return startRinging("ring");
    }, [sounding]);

    /**
     * Reach past the browser window.
     *
     * The card is drawn in every tab, but a tab is not where somebody is: they
     * are in an editor, or in another window entirely, and a call that only
     * exists inside a page nobody is looking at is a missed call. This is the
     * one thing a browser has that the operating system draws.
     *
     * Only while the tab is unwatched, only from the tab holding the connection,
     * and taken back the moment the call is answered or gives up - a notice
     * offering to join a room that is already over is worse than none.
     */
    const notices = useRef(new Map<string, { close: () => void }>());
    useEffect(() => {
        for (const entry of showing) {
            if (!entry.owner || notices.current.has(entry.meetingId) || tabIsWatched()) continue;
            // Marked before the permission prompt resolves, so a second frame
            // does not raise a second notice for the same call.
            notices.current.set(entry.meetingId, { close: () => undefined });
            void notifyDesktop({
                title: `${entry.name || "Somebody"} is calling`,
                body: "Answer in Polaris",
                tag: `call:${entry.meetingId}`,
                href: `/chat/c/${entry.channelId}`,
                insistent: true
            }).then((notice) => {
                if (notice) notices.current.set(entry.meetingId, notice);
            });
        }

        const live = new Set(showing.map((entry) => entry.meetingId));
        for (const [meetingId, notice] of notices.current) {
            if (live.has(meetingId)) continue;
            notice.close();
            notices.current.delete(meetingId);
        }
    }, [showing]);

    // Nothing outlives the screen: a notice left behind by a page that has gone
    // is one nobody can dismiss from inside Polaris.
    useEffect(() => {
        const open = notices.current;
        return () => {
            for (const notice of open.values()) notice.close();
            open.clear();
        };
    }, []);

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
                    <span className="flex items-center gap-2.5">
                        <Avatar
                            size={36}
                            person={{ id: entry.userId, name: entry.name || "Somebody" }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {entry.name || "Somebody"} is calling
                        </span>
                        <Phone className="size-4 shrink-0 animate-pulse text-success" />
                    </span>
                    <span className="flex items-center gap-2">
                        <Button
                            asChild
                            size="sm"
                            className="flex-1"
                            onClick={() => dismiss(entry.meetingId)}
                        >
                            {/* Answering answers. The conversation is still
                                where the room is drawn, but arriving there and
                                having to press Join is a second decision nobody
                                made - they pressed the green button. The
                                microphone only: a camera is never opened by
                                anything but a press that says so. */}
                            <Link href={`/chat/c/${entry.channelId}?answer=${entry.meetingId}`}>
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

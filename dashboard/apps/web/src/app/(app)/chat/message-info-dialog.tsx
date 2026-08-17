"use client";

/**
 * When a message got where it was going.
 *
 * The ticks under a message say how far it got in one glyph, which is the right
 * amount of detail nine times out of ten. The tenth is somebody asking "did they
 * actually see this, and when" - and the answer to that is three moments, not a
 * shape.
 *
 * Only offered on your own message in a one-to-one conversation, and only where
 * the ticks are already shown: the panel is the same fact spelled out, so it is
 * never a way around the setting that withholds them.
 *
 * A step that happened before Polaris started recording the moment says so
 * rather than showing a time it does not know. That is the whole reason the state
 * is carried beside the three timestamps.
 */

import { useEffect, useState } from "react";
import { messageDeliveryAction } from "./actions";
import { useDisplayFormat } from "@/components/display-format";
import { Check, CheckCheck, Loader2, SendHorizontal } from "lucide-react";
import type { ChatMessageView, MessageDelivery } from "@/lib/chat/messages";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function MessageInfoDialog({
    message,
    onOpenChange
}: {
    /** The message to explain. Null closes it - one prop rather than a boolean
     *  beside it, so the two cannot disagree. */
    message: ChatMessageView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [delivery, setDelivery] = useState<MessageDelivery | null>(null);
    const [error, setError] = useState("");
    // Whether the answer has arrived, kept apart from the answer itself. There is
    // a real answer that carries no moments - the other person turned the ticks
    // off while this was open, or the message has since gone - and reading "no
    // delivery" as "still asking" is a spinner nothing ever takes down.
    const [asked, setAsked] = useState(false);

    // Asked when it opens. A channel of two hundred messages must not carry two
    // hundred of these around on the chance somebody opens one.
    useEffect(() => {
        setDelivery(null);
        setError("");
        setAsked(false);
        if (!message) return;
        let current = true;
        void messageDeliveryAction(message.id).then((result) => {
            if (!current) return;
            if (result.error) setError(result.error);
            else setDelivery(result.delivery ?? null);
            setAsked(true);
        });
        return () => {
            current = false;
        };
    }, [message]);

    return (
        <Dialog open={message !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Message information</DialogTitle>
                    <DialogDescription>How far this message got.</DialogDescription>
                </DialogHeader>

                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : !asked ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Looking
                    </p>
                ) : !delivery ? (
                    // Answered, with nothing in it. The ticks stopped being this
                    // reader's to see between opening the conversation and opening
                    // this, or the message is no longer there.
                    <p className="py-6 text-sm text-muted-foreground">
                        There is nothing to show for this message any more.
                    </p>
                ) : (
                    <ol className="flex flex-col gap-3">
                        <Step
                            label="Sent"
                            icon={<SendHorizontal className="size-4" />}
                            iso={delivery.sentAt}
                            reached
                        />
                        <Step
                            label="Delivered"
                            icon={<Check className="size-4" />}
                            iso={delivery.deliveredAt}
                            reached={delivery.state !== "sent"}
                            waiting="Not on their device yet."
                        />
                        <Step
                            label="Read"
                            icon={<CheckCheck className="size-4" />}
                            iso={delivery.readAt}
                            reached={delivery.state === "read"}
                            waiting="Not opened yet."
                        />
                    </ol>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * One of the three moments.
 *
 * Three states rather than two: it happened at a known time, it happened before
 * Polaris kept the time, or it has not happened. The middle one is only ever
 * true of messages sent before this panel existed, and saying "the time was not
 * recorded" is the honest version of a blank.
 */
function Step({
    label,
    icon,
    iso,
    reached,
    waiting
}: {
    label: string;
    icon: React.ReactNode;
    iso: string | null;
    reached: boolean;
    waiting?: string;
}) {
    const format = useDisplayFormat();

    return (
        <li className="flex items-start gap-3">
            <span
                aria-hidden="true"
                className={reached ? "mt-0.5 text-primary" : "mt-0.5 text-foreground-subtle"}
            >
                {icon}
            </span>
            <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{label}</span>
                {iso ? (
                    <span className="text-xs text-muted-foreground">
                        {format.dateTime(iso)}
                    </span>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        {reached ? "The time was not recorded." : (waiting ?? "Not yet.")}
                    </span>
                )}
            </span>
        </li>
    );
}

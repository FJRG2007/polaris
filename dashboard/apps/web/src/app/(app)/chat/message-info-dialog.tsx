"use client";

/**
 * When a message got where it was going.
 *
 * The ticks under a message say how far it got in one glyph, which is the right
 * amount of detail nine times out of ten. The tenth is somebody asking "did they
 * actually see this, and when" - and the answer to that is three moments, not a
 * shape.
 *
 * Only offered on your own message, and only where the ticks are already shown:
 * the panel is the same fact spelled out, so it is never a way around the
 * setting that withholds them. In a group the answer is a person each - who has
 * read it and who not yet - and somebody whose ticks are withheld is listed as
 * such rather than guessed at.
 *
 * A step that happened before Polaris started recording the moment says so
 * rather than showing a time it does not know. That is the whole reason the state
 * is carried beside the three timestamps.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat } from "@/components/display-format";
import { Check, CheckCheck, EyeOff, Loader2, SendHorizontal } from "lucide-react";
import type { ChatMessageView, MessageDelivery, MessageReader } from "@/lib/chat/messages";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";
import * as polls from "./chat-reads";

export function MessageInfoDialog({
    message,
    onOpenChange
}: {
    /** The message to explain. Null closes it - one prop rather than a boolean
     *  beside it, so the two cannot disagree. */
    message: ChatMessageView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
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
        void polls.messageDelivery(message.id).then((result) => {
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
                    <DialogTitle>{t("messageInfo.messageInformation")}</DialogTitle>
                    <DialogDescription>{t("messageInfo.howFarThisMessageGot")}</DialogDescription>
                </DialogHeader>

                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : !asked ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {t("messageInfo.looking")}
                    </p>
                ) : !delivery ? (
                    // Answered, with nothing in it. The ticks stopped being this
                    // reader's to see between opening the conversation and opening
                    // this, or the message is no longer there.
                    <p className="py-6 text-sm text-muted-foreground">
                        {t("messageInfo.thereIsNothingToShow")}
                    </p>
                ) : delivery.readers ? (
                    <GroupReaders sentAt={delivery.sentAt} readers={delivery.readers} />
                ) : (
                    <ol className="flex flex-col gap-3">
                        <Step
                            label={t("messageInfo.sent")}
                            icon={<SendHorizontal className="size-4" />}
                            iso={delivery.sentAt}
                            reached
                        />
                        <Step
                            label={t("messageInfo.delivered")}
                            icon={<Check className="size-4" />}
                            iso={delivery.deliveredAt}
                            reached={delivery.state !== "sent"}
                            waiting={t("messageInfo.notOnTheirDevice")}
                        />
                        <Step
                            label={t("messageInfo.read")}
                            icon={<CheckCheck className="size-4" />}
                            iso={delivery.readAt}
                            reached={delivery.state === "read"}
                            waiting={t("messageInfo.notOpened")}
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
    const t = useTranslations("chat");
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
                    <span className="text-xs text-muted-foreground">{format.dateTime(iso)}</span>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        {reached
                            ? t("messageInfo.theTimeWasNotRecorded")
                            : (waiting ?? t("messageInfo.notYet"))}
                    </span>
                )}
            </span>
        </li>
    );
}

/**
 * Who in a group has read one message.
 *
 * A row a person, read first. The count over it says the same as the tick does:
 * everybody, or how many of how many - and a member whose ticks are withheld is
 * never one of the ones counted as having read it.
 */
function GroupReaders({ sentAt, readers }: { sentAt: string; readers: readonly MessageReader[] }) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const read = readers.filter((reader) => reader.state === "read").length;

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <p className="flex items-center gap-3 text-sm">
                <SendHorizontal className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="font-medium">{t("messageInfo.sent")}</span>
                <span className="text-xs text-muted-foreground">{format.dateTime(sentAt)}</span>
            </p>
            <p className="text-sm font-medium">
                {read === readers.length
                    ? t("messageInfo.readByEveryone")
                    : t("messageInfo.readBy", { count: read, total: readers.length })}
            </p>
            <ul
                aria-label={t("messageInfo.readers")}
                className="flex max-h-72 flex-col gap-1.5 overflow-y-auto overscroll-contain"
            >
                {readers.map((reader) => (
                    <li key={reader.id} className="flex min-w-0 items-center gap-3 text-sm">
                        <ReaderIcon state={reader.state} />
                        <span className="min-w-0 flex-1 truncate" title={reader.name}>
                            {reader.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {reader.state === "read"
                                ? t("messageInfo.read")
                                : reader.state === "delivered"
                                  ? t("messageInfo.delivered")
                                  : reader.state === "unknown"
                                    ? t("messageInfo.unknown")
                                    : t("messageInfo.waiting")}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The same glyphs the ticks use, one person at a time. */
function ReaderIcon({ state }: { state: MessageReader["state"] }) {
    if (state === "unknown")
        return <EyeOff className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />;
    if (state === "sent")
        return <Check className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />;
    return (
        <CheckCheck
            className={
                state === "read"
                    ? "size-4 shrink-0 text-primary"
                    : "size-4 shrink-0 text-foreground-subtle"
            }
            aria-hidden="true"
        />
    );
}

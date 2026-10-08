"use client";

/**
 * The room's pins, on screen.
 *
 * Three pieces, from the two apps this copies:
 *
 * - **The bar** above the conversation (WhatsApp): the newest pin, one line of
 *   it. With more than one, a column of ticks on the left says how many and
 *   which one is showing; pressing the bar walks to that message and moves the
 *   bar on to the next one, so pressing it again and again visits every pin.
 * - **The list** (Discord's pins panel): every pin, newest first, each with who
 *   pinned it, how long it stays, a way to jump to it and - for whoever may - a
 *   way to unpin it.
 * - **The length** (WhatsApp): pinning asks how long it should stay - a day, a
 *   week, a month - plus Discord's "until somebody unpins it".
 *
 * The pins are read on their own, not off the messages on screen: the window of
 * messages is two hundred lines at most, and a pin from last month is exactly
 * the kind that is not in it.
 */

import * as actions from "./actions";
import { runAction } from "@/lib/run-action";
import type { ChatFrame } from "./use-chat-stream";
import { Loader2, Pin, PinOff } from "lucide-react";
import { PersonName } from "@/components/person-name";
import { MessageTime } from "@/components/message-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChatPinView } from "@/lib/chat/pins";
import { PIN_DURATIONS, type PinDuration } from "@/lib/chat/pin-rules";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Skeleton
} from "@polaris/ui";

/** The pins of one conversation, kept current: read when it opens and again
 *  whenever a frame says somebody pinned or unpinned something in it. The
 *  screen hands its frames to `onFrame` from the one stream subscription it
 *  already has, rather than this opening a second. */
export function usePins(channelId: string | null) {
    const [pins, setPins] = useState<readonly ChatPinView[] | null>(null);
    /** How many are pinned, read by the frame handler without re-subscribing. */
    const held = useRef(0);
    held.current = pins?.length ?? 0;

    const reload = useCallback(async () => {
        if (!channelId) return;
        // A bar that could not be read is a bar not drawn, never an error over
        // the conversation: the messages are what the reader came for.
        try {
            const result = await actions.pinsAction(channelId);
            if (result?.pins) setPins(result.pins);
        } catch {
            setPins((current) => current ?? []);
        }
    }, [channelId]);

    useEffect(() => {
        setPins(null);
        void reload();
    }, [reload]);

    const onFrame = useCallback(
        (frame: ChatFrame) => {
            if (frame.kind === "pins" && frame.channelId === channelId) void reload();
            // A message deleted under a pin takes the pin with it, and that
            // arrives as an ordinary "something moved here".
            if (
                frame.kind === "posted" &&
                channelId &&
                held.current > 0 &&
                frame.channels.includes(channelId)
            ) {
                void reload();
            }
        },
        [channelId, reload]
    );

    const ids = useMemo(() => new Set((pins ?? []).map((entry) => entry.message.id)), [pins]);
    return { pins, ids, reload, setPins, onFrame };
}

/** One line of a message, for the bar and the list. */
function excerptOf(message: ChatMessageView, attachment: string, deleted: string): string {
    if (message.deleted) return deleted;
    const text = plainExcerpt(message.body, 160);
    if (text) return text;
    return message.attachments[0]?.name ?? attachment;
}

/**
 * The bar above the conversation. Nothing at all when nothing is pinned - a bar
 * that says "no pins" is a strip of screen spent on nothing.
 */
export function PinnedBar({
    pins,
    onJump,
    onShowAll
}: {
    pins: readonly ChatPinView[] | null;
    onJump: (messageId: string) => void;
    onShowAll: () => void;
}) {
    const t = useTranslations("chat");
    const [at, setAt] = useState(0);
    const count = pins?.length ?? 0;

    // A pin taken off while the bar pointed past the end starts it over.
    useEffect(() => {
        if (at >= count) setAt(0);
    }, [at, count]);

    if (!pins || count === 0) return null;
    const shown = pins[Math.min(at, count - 1)]!;
    const label =
        count > 1
            ? t("pins.pinnedCount", { at: Math.min(at, count - 1) + 1, count })
            : t("pins.pinned");

    return (
        <div className="flex shrink-0 items-stretch gap-2 border-b border-border bg-surface px-3 py-1.5">
            {/* The ticks: one per pin, the lit one is what the bar shows. Capped
                at four drawn, like WhatsApp's, so fifty pins is not fifty lines. */}
            {count > 1 && (
                <span aria-hidden className="flex w-0.5 shrink-0 flex-col gap-0.5 py-0.5">
                    {Array.from({ length: Math.min(count, 4) }, (_, index) => (
                        <span
                            key={index}
                            className={cn(
                                "min-h-0 flex-1 rounded-full",
                                index === Math.min(at, 3) ? "bg-primary" : "bg-border-strong"
                            )}
                        />
                    ))}
                </span>
            )}
            <button
                type="button"
                onClick={() => {
                    onJump(shown.message.id);
                    setAt((current) => (current + 1) % count);
                }}
                title={t("pins.jumpTo")}
                className="flex min-w-0 flex-1 items-center gap-2 rounded text-left"
            >
                <Pin className="size-3.5 shrink-0 text-primary" />
                <span className="flex min-w-0 flex-col">
                    <span
                        className="truncate text-[0.6875rem] font-medium text-primary"
                        title={label}
                    >
                        {label}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                        {excerptOf(shown.message, t("pins.attachment"), t("pins.deleted"))}
                    </span>
                </span>
            </button>
            <button
                type="button"
                onClick={onShowAll}
                aria-label={t("pins.showAll")}
                title={t("pins.showAll")}
                className="shrink-0 self-center rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                {count > 1 ? count : <Pin className="size-3.5" />}
            </button>
        </div>
    );
}

/** How long a new pin stays. WhatsApp's dialog, with its default of a week. */
export function PinLengthDialog({
    message,
    onOpenChange,
    onPinned
}: {
    /** The message being pinned. Null closes it. */
    message: ChatMessageView | null;
    onOpenChange: (open: boolean) => void;
    onPinned: () => void;
}) {
    const t = useTranslations("chat");
    const group = useId();
    const [duration, setDuration] = useState<PinDuration>("week");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!message) return;
        setDuration("week");
        setError("");
    }, [message]);

    const pin = async () => {
        if (!message) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => actions.pinAction({ messageId: message.id, duration }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onPinned();
    };

    return (
        <Dialog open={message !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("pins.pinFor")}</DialogTitle>
                    <DialogDescription>{t("pins.pinForBody")}</DialogDescription>
                </DialogHeader>
                <div
                    role="radiogroup"
                    aria-label={t("pins.pinFor")}
                    className="flex flex-col gap-1.5"
                >
                    {PIN_DURATIONS.map((choice) => (
                        <label
                            key={choice}
                            className={cn(
                                "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                                duration === choice
                                    ? "border-primary bg-primary/5 text-foreground"
                                    : "border-border text-muted-foreground hover:bg-muted"
                            )}
                        >
                            <input
                                type="radio"
                                name={group}
                                value={choice}
                                checked={duration === choice}
                                onChange={() => setDuration(choice)}
                                className="shrink-0 accent-primary"
                            />
                            {t(`pins.${choice}`)}
                        </label>
                    ))}
                </div>
                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("pins.cancel")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void pin()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("pins.pin")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Every pin in the conversation: Discord's pins panel. */
export function PinsDialog({
    open,
    onOpenChange,
    pins,
    mayPin,
    onJump,
    onUnpinned
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pins: readonly ChatPinView[] | null;
    mayPin: boolean;
    onJump: (messageId: string) => void;
    onUnpinned: (messageId: string) => void;
}) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const [error, setError] = useState("");
    const [working, setWorking] = useState<string | null>(null);

    useEffect(() => {
        if (open) setError("");
    }, [open]);

    const unpin = async (messageId: string) => {
        setWorking(messageId);
        setError("");
        const result = await runAction(() => actions.unpinAction(messageId), setError);
        setWorking(null);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        onUnpinned(messageId);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[80dvh] max-w-lg flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Pin className="size-4 text-primary" />
                        {t("pins.title")}
                    </DialogTitle>
                </DialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
                <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
                    {pins === null ? (
                        <div className="flex flex-col gap-2" aria-hidden="true">
                            {[0, 1].map((row) => (
                                <Skeleton key={row} className="h-16 w-full" />
                            ))}
                        </div>
                    ) : pins.length === 0 ? (
                        <EmptyState
                            icon={<Pin />}
                            title={t("pins.none")}
                            description={t("pins.noneBody")}
                        />
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {pins.map((entry) => (
                                <li
                                    key={entry.message.id}
                                    className="rounded-lg border border-border bg-card p-3"
                                >
                                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                        <span className="min-w-0 truncate font-medium text-foreground">
                                            <PersonName
                                                id={entry.message.authorId}
                                                name={
                                                    entry.message.authorName ??
                                                    "Somebody who has left"
                                                }
                                            />
                                        </span>
                                        <MessageTime
                                            iso={entry.message.createdAt}
                                            className="shrink-0 whitespace-nowrap"
                                        />
                                        <span className="ml-auto flex shrink-0 items-center gap-1">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => {
                                                    onOpenChange(false);
                                                    onJump(entry.message.id);
                                                }}
                                            >
                                                {t("pins.jump")}
                                            </Button>
                                            {mayPin && (
                                                <button
                                                    type="button"
                                                    aria-label={t("pins.unpin")}
                                                    title={t("pins.unpin")}
                                                    disabled={working === entry.message.id}
                                                    onClick={() => void unpin(entry.message.id)}
                                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                                >
                                                    <PinOff className="size-3.5" />
                                                </button>
                                            )}
                                        </span>
                                    </div>
                                    <p className="mt-1 line-clamp-3 break-words text-sm">
                                        {excerptOf(
                                            entry.message,
                                            t("pins.attachment"),
                                            t("pins.deleted")
                                        )}
                                    </p>
                                    <p className="mt-1 truncate text-[0.6875rem] text-foreground-subtle">
                                        {[
                                            entry.pinnedBy
                                                ? t("pins.byOn", { name: entry.pinnedBy })
                                                : null,
                                            entry.expiresAt
                                                ? t("pins.until", {
                                                      date: format.dateTime(entry.expiresAt)
                                                  })
                                                : t("pins.forever")
                                        ]
                                            .filter(Boolean)
                                            .join(" - ")}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

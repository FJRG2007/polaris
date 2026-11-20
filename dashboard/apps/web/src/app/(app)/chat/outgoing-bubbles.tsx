"use client";

/**
 * What a message with files shows on itself while they go - the way WhatsApp,
 * Telegram and Discord do it.
 *
 * The message is a row of the conversation from the moment Send is pressed (see
 * `outgoing-message`), drawn through the same attachment components it lands
 * with. Each picture or video is dimmed and blurred while it goes, with a ring
 * in the middle carrying the real fraction of its bytes; tapping the ring stops
 * that file alone, and one that failed carries a retry arrow on itself. The
 * corner transfer list stays out of it: the ring is where this progress is (see
 * `sendFile`'s `listed`).
 *
 * What is drawn comes from the outgoing store (`outgoing.tsx`), which outlives
 * the box that sent it, so walking away and back finds it still here.
 */

import { RotateCcw, X } from "lucide-react";
import { ProgressRing } from "@/components/progress-ring";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { cancelOutgoingFile, removeOutgoing, retryOutgoing, type Outgoing } from "./outgoing";

/** Whether one file of a message on its way is still going. */
export function isGoing(one: Outgoing, index: number): boolean {
    const phase = one.items?.[index]?.phase ?? "waiting";
    return phase !== "sent" && phase !== "cancelled";
}

/** The ring, or the retry arrow, over one file. Nothing once it is up. */
export function OutgoingFileState({
    one,
    index,
    name,
    small = false
}: {
    one: Outgoing;
    index: number;
    name: string;
    small?: boolean;
}) {
    const t = useTranslations("chat");
    const item = one.items?.[index];
    const phase = item?.phase ?? "waiting";
    const size = small ? 32 : 48;
    const icon = small ? "size-3.5" : "size-5";
    if (phase === "sent" || phase === "cancelled") return null;
    if (phase === "failed" || one.phase === "failed") {
        return (
            <button
                type="button"
                onClick={() => retryOutgoing(one.id)}
                aria-label={t("composer.outgoing.failedNamed", { name })}
                title={t("composer.outgoing.retry")}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <ProgressRing fraction={0} size={size} className="bg-danger/80">
                    <RotateCcw className={icon} aria-hidden />
                </ProgressRing>
            </button>
        );
    }
    const fraction = phase === "sending" ? (item?.fraction ?? 0) : null;
    return (
        <button
            type="button"
            onClick={() => cancelOutgoingFile(one.id, index)}
            aria-label={t("composer.outgoing.cancelNamed", { name })}
            title={t("composer.outgoing.cancelNamed", { name })}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <span
                role="progressbar"
                aria-label={t("composer.outgoing.sendingNamed", { name })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
            >
                <ProgressRing fraction={fraction} size={size}>
                    <X className={icon} aria-hidden />
                </ProgressRing>
            </span>
        </button>
    );
}

/** Why a message with files did not go, and the two things to do about it. */
export function OutgoingFailure({ one }: { one: Outgoing }) {
    const t = useTranslations("chat");
    if (one.phase !== "failed") return null;
    const label = [...one.files.map((file) => file.name), ...one.kept.map((kept) => kept.name)].join(", ");
    return (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs">
            <p role="alert" className="min-w-0 flex-1 text-danger">
                {one.error || t("composer.outgoing.notSent")}
            </p>
            <button
                type="button"
                onClick={() => retryOutgoing(one.id)}
                aria-label={t("composer.outgoing.retryNamed", { name: label })}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
            >
                <RotateCcw className="size-3" aria-hidden />
                {t("composer.outgoing.retry")}
            </button>
            <button
                type="button"
                onClick={() => removeOutgoing(one.id)}
                aria-label={t("composer.outgoing.removeNamed", { name: label })}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <X className="size-3" aria-hidden />
                {t("composer.outgoing.remove")}
            </button>
        </div>
    );
}

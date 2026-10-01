"use client";

/**
 * What is moving, on screen.
 *
 * One card in the corner for the whole instance rather than a bar inside each
 * screen, because a transfer outlives the screen it was started from: somebody who
 * drops a two-gigabyte recording into a conversation and then goes to read their
 * mail has not cancelled anything, and a bar that lived in the composer would have
 * vanished with it.
 *
 * It is only there while something is happening. A finished transfer stays for a
 * few seconds - long enough to read as "that worked" - and a failed one stays until
 * it is dismissed, because it is the only place the reason is written.
 *
 * Bytes and a percentage, not a spinner. A spinner is indistinguishable from a
 * hang, which is what makes people press send again; a number that is going up is
 * the one thing that says "this is working, wait".
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import {
    clearSettledTransfers,
    clearTransfer,
    transferFraction,
    isUnderWay,
    transferSecondsLeft,
    useTransfers,
    type Transfer
} from "./transfer-store";

export function TransfersView() {
    const t = useTranslations("components");
    const transfers = useTransfers();
    // A clock, so "40 seconds left" counts down rather than sitting at whatever it
    // said when the last chunk landed. Only while something is moving.
    const moving = transfers.some(isUnderWay);
    const [, tick] = useState(0);
    useEffect(() => {
        if (!moving) return;
        const timer = window.setInterval(() => tick((count) => count + 1), 1000);
        return () => window.clearInterval(timer);
    }, [moving]);

    if (transfers.length === 0) return null;

    const settled = transfers.filter((transfer) => !isUnderWay(transfer));

    return (
        <div
            aria-label={t("transfers.label")}
            /**
             * Above whatever is docked in this corner, not on top of it.
             *
             * The mail composer is fixed to the same corner with the same
             * stacking order, so attaching a file put this card over the
             * attachments it was reporting on and over the Send button - two
             * panels drawn into each other, with only the document order
             * deciding which. A docked panel publishes the height it occupies
             * and this sits above it; when there is none the variable is absent
             * and the corner is this card's own. The layer above it too, so a
             * composer taking the whole screen does not bury the progress of the
             * file it is uploading.
             */
            className="pointer-events-auto fixed bottom-[calc(1rem_+_var(--docked-panel-height,0px))] right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-border bg-elevated p-3 shadow-popover"
        >
            <div className="flex items-center gap-2">
                <p className="flex-1 text-xs font-medium text-muted-foreground">
                    {moving ? countSaid(transfers, t) : t("transfers.finished")}
                </p>
                {settled.length > 0 && (
                    <button
                        type="button"
                        onClick={clearSettledTransfers}
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={t("transfers.clearFinished")}
                        title={t("transfers.clearFinishedShort")}
                    >
                        <X className="size-3.5" />
                    </button>
                )}
            </div>
            <ul className="flex flex-col gap-2">
                {transfers.map((transfer) => (
                    <TransferRow key={transfer.id} transfer={transfer} />
                ))}
            </ul>
        </div>
    );
}

function TransferRow({ transfer }: { transfer: Transfer }) {
    const t = useTranslations("components");
    const fraction = transferFraction(transfer);
    const left = transferSecondsLeft(transfer);
    const failed = transfer.state === "failed";

    return (
        <li className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
                {transfer.state === "done" ? (
                    <Check className="size-3.5 shrink-0 text-success" aria-hidden />
                ) : transfer.way === "up" ? (
                    <ArrowUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                    <ArrowDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-xs" title={transfer.name}>
                    {transfer.name}
                </span>
                {transfer.stop ? (
                    <button
                        type="button"
                        onClick={transfer.stop}
                        aria-label={t("transfers.stopNamed", { name: transfer.name })}
                        title={t("transfers.stop")}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <X className="size-3" />
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => clearTransfer(transfer.id)}
                        aria-label={t("transfers.clearNamed", { name: transfer.name })}
                        title={t("transfers.clear")}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <X className="size-3" />
                    </button>
                )}
            </div>

            {/* A bar with a number beside it, and a stripe where there is no number
                to give: a bar that fills at a rate nobody chose says "this much is
                left" and is guessing. */}
            {!failed && transfer.state !== "stopped" && (
                <div
                    role="progressbar"
                    aria-label={transfer.name}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(fraction === null ? {} : { "aria-valuenow": Math.round(fraction * 100) })}
                    className="h-1 w-full overflow-hidden rounded-full bg-muted"
                >
                    <div
                        className={cn(
                            "h-full rounded-full bg-primary",
                            fraction === null
                                ? "w-1/3 animate-pulse"
                                : "transition-[width] duration-200"
                        )}
                        style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
                    />
                </div>
            )}

            <p className={cn("text-[0.6875rem]", failed ? "text-danger" : "text-muted-foreground")}>
                {failed ? failure(transfer, t) : said(transfer, left, t)}
            </p>
        </li>
    );
}

/** What the row says under the bar. */
function said(transfer: Transfer, secondsLeft: number | null, t: Words): string {
    if (transfer.state === "stopped") return t("transfers.stopped");
    if (transfer.state === "done")
        return transfer.way === "up" ? t("transfers.sent") : t("transfers.saved");
    if (transfer.state === "waiting") {
        return transfer.way === "up" ? t("transfers.starting") : t("transfers.waiting");
    }
    if (transfer.state === "processing") return t("transfers.processing");
    const size = transfer.total
        ? t("transfers.ofTotal", {
              moved: readable(transfer.moved),
              total: readable(transfer.total)
          })
        : readable(transfer.moved);
    return secondsLeft === null ? size : t("transfers.left", { size, left: clock(secondsLeft) });
}

/** Why it failed: the server's sentence when it wrote one, ours when it did not. */
function failure(transfer: Transfer, t: Words): string {
    if (transfer.error) return transfer.error;
    if (transfer.problem === "dropped") return t("transfers.dropped", { name: transfer.name });
    if (transfer.problem === "noAnswer") return t("transfers.noAnswer", { name: transfer.name });
    return t("transfers.refused", { name: transfer.name });
}

function countSaid(transfers: readonly Transfer[], t: Words): string {
    const moving = transfers.filter(isUnderWay);
    const up = moving.filter((transfer) => transfer.way === "up").length;
    const down = moving.length - up;
    if (up > 0 && down > 0) return t("transfers.both", { up, down });
    if (up > 0) return t("transfers.sending", { count: up });
    return t("transfers.getting", { count: down });
}

type Words = NamespaceTranslator<"components">;

/** A size somebody can read at a glance. */
function readable(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** How long is left, in the coarsest unit that still means something: nobody needs
 *  "7 minutes and 12 seconds". */
function clock(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} h`;
}

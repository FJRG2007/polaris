"use client";

/**
 * Messages with files in them, drawn in the conversation from the moment Send is
 * pressed - the way WhatsApp, Telegram and Discord do it.
 *
 * Each picture or video is shown from the sender's own copy (an object URL, so
 * nothing is fetched), dimmed while it goes, with a ring in the middle carrying
 * the real fraction of its bytes. Tapping the ring stops that file alone; one
 * that failed carries a retry arrow on itself. Several of them are laid out as
 * an album. The corner transfer list stays out of it: the ring is where this
 * progress is (see `sendFile`'s `listed`).
 *
 * What is drawn comes from the outgoing store (`outgoing.tsx`), which outlives
 * the box that sent it, so walking away and back finds it still here.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { FileText, RotateCcw, X } from "lucide-react";
import { ProgressRing } from "@/components/progress-ring";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    cancelOutgoingFile,
    removeOutgoing,
    retryOutgoing,
    type Outgoing,
    type OutgoingItem
} from "./outgoing";

/** The sender's own copy of a file as an address, for as long as it is drawn. */
function useObjectUrl(file: File): string | null {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        const made = URL.createObjectURL(file);
        setUrl(made);
        return () => URL.revokeObjectURL(made);
    }, [file]);
    return url;
}

function isVisual(file: File): boolean {
    return file.type.startsWith("image/") || file.type.startsWith("video/");
}

/** The ring, or the retry arrow, over one file. Nothing once it is up. */
function FileState({
    one,
    index,
    name,
    item,
    small = false
}: {
    one: Outgoing;
    index: number;
    name: string;
    item: OutgoingItem | undefined;
    small?: boolean;
}) {
    const t = useTranslations("chat");
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
    const fraction = phase === "sending" ? item?.fraction ?? 0 : null;
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

/** One picture or video of a message on its way. */
function MediaTile({
    one,
    index,
    file,
    item,
    single,
    more
}: {
    one: Outgoing;
    index: number;
    file: File;
    item: OutgoingItem | undefined;
    single: boolean;
    /** How many more files the album has past this tile, drawn over it. */
    more: number;
}) {
    const t = useTranslations("chat");
    const url = useObjectUrl(file);
    const going = item?.phase !== "sent";
    const media = url ? (
        file.type.startsWith("video/") ? (
            // The first frame, from the sender's own copy - nothing plays.
            <video
                src={url}
                muted
                playsInline
                preload="metadata"
                aria-hidden
                className={cn("block", single ? "max-h-72 max-w-full" : "size-full object-cover")}
            />
        ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a local object URL, nothing to optimise
            <img
                src={url}
                alt={file.name}
                className={cn("block", single ? "max-h-72 max-w-full" : "size-full object-cover")}
            />
        )
    ) : (
        <span className={cn("block bg-muted", single ? "h-40 w-56" : "size-full")} />
    );
    return (
        <div
            className={cn(
                "relative overflow-hidden bg-muted",
                single ? "inline-block max-w-full rounded-md" : "aspect-square min-w-0"
            )}
        >
            <div
                className={cn(
                    "transition-[filter] duration-300 motion-reduce:transition-none",
                    single ? "" : "size-full",
                    going && "brightness-75 blur-[2px]"
                )}
            >
                {media}
            </div>
            {more > 0 && (
                <span className="absolute inset-0 grid place-items-center bg-black/50 text-lg font-semibold text-white">
                    {t("composer.outgoing.more", { count: more })}
                </span>
            )}
            <span className="absolute inset-0 grid place-items-center">
                <FileState one={one} index={index} name={file.name} item={item} />
            </span>
        </div>
    );
}

/** How an album is laid out: at most four tiles, the last carrying the rest. */
function albumClass(count: number): string {
    if (count === 2) return "grid-cols-2";
    if (count === 3) return "grid-cols-2 [&>*:first-child]:col-span-2 [&>*:first-child]:aspect-[2/1]";
    return "grid-cols-2";
}

function OutgoingBubble({ one }: { one: Outgoing }) {
    const t = useTranslations("chat");
    // A file the sender stopped is out of the message: it leaves the bubble.
    const indexed = one.files
        .map((file, index) => ({ file, index }))
        .filter(({ index }) => one.items?.[index]?.phase !== "cancelled");
    const visual = indexed.filter(({ file }) => isVisual(file));
    const other = indexed.filter(({ file }) => !isVisual(file));
    const tiles = visual.slice(0, 4);
    const failed = one.phase === "failed";
    const label = [...one.files.map((file) => file.name), ...one.kept.map((kept) => kept.name)].join(", ");

    return (
        <li className="flex justify-end px-4 py-1">
            <div
                className={cn(
                    "flex w-fit min-w-0 max-w-[min(22rem,85%)] flex-col gap-1.5 rounded-lg border p-1.5",
                    failed ? "border-danger/40 bg-danger-soft" : "border-border bg-muted/50"
                )}
            >
                {tiles.length === 1 && (
                    <MediaTile
                        one={one}
                        index={tiles[0]!.index}
                        file={tiles[0]!.file}
                        item={one.items?.[tiles[0]!.index]}
                        single
                        more={0}
                    />
                )}
                {tiles.length > 1 && (
                    <div className={cn("grid w-full min-w-[min(20rem,70vw)] gap-0.5 overflow-hidden rounded-md", albumClass(tiles.length))}>
                        {tiles.map(({ file, index }, at) => (
                            <MediaTile
                                key={index}
                                one={one}
                                index={index}
                                file={file}
                                item={one.items?.[index]}
                                single={false}
                                more={at === 3 ? visual.length - 4 : 0}
                            />
                        ))}
                    </div>
                )}
                {other.map(({ file, index }) => (
                    <div key={index} className="flex min-w-0 items-center gap-2 rounded-md bg-background/60 px-2 py-1.5">
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                            {file.name}
                        </span>
                        <FileState one={one} index={index} name={file.name} item={one.items?.[index]} small />
                    </div>
                ))}
                {one.kept.map((kept) => (
                    <div key={kept.path} className="flex min-w-0 items-center gap-2 rounded-md bg-background/60 px-2 py-1.5">
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm" title={kept.name}>
                            {kept.name}
                        </span>
                    </div>
                ))}
                {one.body && (
                    <p className="min-w-0 whitespace-pre-wrap break-words px-1 text-sm">{one.body}</p>
                )}
                {failed && (
                    <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 text-xs">
                        <p role="alert" className="min-w-0 flex-1 text-danger">
                            {one.error || t("composer.outgoing.notSent")}
                        </p>
                        <button
                            type="button"
                            onClick={() => retryOutgoing(one.id)}
                            aria-label={t("composer.outgoing.retryNamed", { name: label })}
                            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-background"
                        >
                            <RotateCcw className="size-3" aria-hidden />
                            {t("composer.outgoing.retry")}
                        </button>
                        <button
                            type="button"
                            onClick={() => removeOutgoing(one.id)}
                            aria-label={t("composer.outgoing.removeNamed", { name: label })}
                            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        >
                            <X className="size-3" aria-hidden />
                            {t("composer.outgoing.remove")}
                        </button>
                    </div>
                )}
            </div>
        </li>
    );
}

export function OutgoingBubbles({ outgoing }: { outgoing: readonly Outgoing[] }) {
    if (outgoing.length === 0) return null;
    return (
        <ul className="flex flex-col pb-2" aria-live="polite">
            {outgoing.map((one) => (
                <OutgoingBubble key={one.id} one={one} />
            ))}
        </ul>
    );
}

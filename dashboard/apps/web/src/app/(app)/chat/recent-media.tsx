"use client";

/**
 * The phone's recent photos and videos at the top of the composer's "+" sheet,
 * the way Discord and Signal show them: a grid to tap, several at once, with the
 * camera as its first square. A tap puts the photo straight on the message being
 * written, shown in the composer's own strip and sent with its Send; a second tap
 * takes it off. Nothing here moves when it does: the mark is drawn over the
 * square, and there is no button of its own under the grid. Only inside the Polaris phone app, which reads the
 * gallery for the page (`lib/mobile-media.ts`); a browser keeps the system
 * chooser behind the Photos tile.
 *
 * Access is asked for the first time the grid has nothing to show, and every
 * refusal leaves a way on: "Allow access", "Manage" for a chosen selection, and
 * "Open Settings" when only the settings can undo it. The Photos tile below the
 * grid opens the system chooser in every case, which needs no permission.
 */

import { Camera, Play } from "lucide-react";
import { Button, Skeleton, cn } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { clipLength, type DeviceMediaItem, type MediaAccess, type PhoneMedia } from "@/lib/mobile-media";

/** A page the grid asks for at a time: a screen and a half of squares. */
const PAGE = 48;
/** Previews kept across openings of the sheet, newest kept. */
const THUMBS_KEPT = 400;

const thumbs = new Map<string, string>();

function keepThumb(id: string, src: string) {
    thumbs.set(id, src);
    if (thumbs.size <= THUMBS_KEPT) return;
    const oldest = thumbs.keys().next().value;
    if (oldest !== undefined) thumbs.delete(oldest);
}

type Load = "loading" | "ready" | "failed";

export function RecentMedia({
    media,
    maxBytes,
    attached,
    onCamera,
    onAttach,
    onDetach
}: {
    media: PhoneMedia;
    /** Larger than this cannot be sent here, so it cannot be chosen. */
    maxBytes: number;
    /** What the message carries now; a square whose photo is among it is marked. */
    attached: readonly File[];
    onCamera: () => void;
    onAttach: (files: File[]) => void;
    onDetach: (file: File) => void;
}) {
    const t = useTranslations("chat");
    const [access, setAccess] = useState<MediaAccess | null>(null);
    const [items, setItems] = useState<DeviceMediaItem[]>([]);
    const [more, setMore] = useState(false);
    const [load, setLoad] = useState<Load>("loading");
    // The file each square became, so the strip's copy can be found again.
    const [read, setRead] = useState<ReadonlyMap<string, File>>(() => new Map());
    const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set());
    const [readFailed, setReadFailed] = useState(false);
    const busy = useRef(false);
    const end = useRef<HTMLDivElement>(null);

    const page = useCallback(
        async (offset: number) => {
            if (busy.current) return;
            busy.current = true;
            if (offset === 0) setLoad("loading");
            try {
                const next = await media.list(offset, PAGE);
                setItems((current) => (offset === 0 ? next.items : [...current, ...next.items]));
                setMore(next.more && next.items.length > 0);
                setLoad("ready");
            } catch {
                setLoad("failed");
            } finally {
                busy.current = false;
            }
        },
        [media]
    );

    const settle = useCallback(
        (granted: MediaAccess) => {
            setAccess(granted);
            if (granted === "full" || granted === "limited") void page(0);
            else setLoad("ready");
        },
        [page]
    );

    const check = useCallback(() => {
        media.access().then(settle, () => setLoad("failed"));
    }, [media, settle]);

    useEffect(() => {
        check();
        // Back from the phone's settings, or from choosing which photos: what
        // Polaris may see has changed, and the grid follows it.
        const back = () => {
            if (document.visibilityState === "visible") check();
        };
        document.addEventListener("visibilitychange", back);
        return () => document.removeEventListener("visibilitychange", back);
    }, [check]);

    useEffect(() => {
        const sentinel = end.current;
        if (!sentinel || !more) return;
        const watch = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) void page(items.length);
        });
        watch.observe(sentinel);
        return () => watch.disconnect();
    }, [more, items.length, page]);

    const toggle = async (item: DeviceMediaItem) => {
        setReadFailed(false);
        const known = read.get(item.id);
        if (known && attached.includes(known)) {
            onDetach(known);
            return;
        }
        if (reading.has(item.id)) return;
        setReading((current) => new Set(current).add(item.id));
        try {
            const file = known ?? (await media.file(item));
            setRead((current) => new Map(current).set(item.id, file));
            onAttach([file]);
        } catch {
            setReadFailed(true);
        } finally {
            setReading((current) => {
                const next = new Set(current);
                next.delete(item.id);
                return next;
            });
        }
    };

    const granted = access === "full" || access === "limited";
    const camera = (
        <button
            type="button"
            onClick={onCamera}
            aria-label={t("attachSheet.camera")}
            className="flex aspect-square min-w-0 flex-col items-center justify-center gap-1.5 rounded-md bg-surface text-foreground active:bg-muted [-webkit-tap-highlight-color:transparent]"
        >
            <Camera className="size-7 shrink-0" />
            <span className="w-full truncate px-1 text-center text-xs" title={t("attachSheet.camera")}>
                {t("attachSheet.camera")}
            </span>
        </button>
    );

    return (
        <section aria-label={t("attachSheet.recent")} className="relative flex min-h-0 flex-1 flex-col gap-2">
            {access === "limited" ? (
                <Notice text={t("attachSheet.limitedText")}>
                    <Button size="sm" variant="secondary" onClick={() => media.manage().then(settle, check)}>
                        {t("attachSheet.manage")}
                    </Button>
                </Notice>
            ) : null}
            <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-1 overflow-y-auto overscroll-contain rounded-md">
                {camera}
                {load === "loading" ? (
                    Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="aspect-square rounded-md" />)
                ) : load === "failed" ? (
                    <Notice wide text={t("attachSheet.loadFailed")}>
                        <Button size="sm" variant="secondary" onClick={check}>
                            {t("attachSheet.retry")}
                        </Button>
                    </Notice>
                ) : access === "prompt" ? (
                    <Notice wide text={t("attachSheet.allowText")}>
                        <Button size="sm" onClick={() => media.request().then(settle, check)}>
                            {t("attachSheet.allow")}
                        </Button>
                    </Notice>
                ) : access === "denied" ? (
                    <Notice wide text={t("attachSheet.deniedText")}>
                        <Button size="sm" variant="secondary" onClick={() => void media.settings().catch(() => undefined)}>
                            {t("attachSheet.openSettings")}
                        </Button>
                    </Notice>
                ) : granted && items.length === 0 ? (
                    <Notice wide text={t("attachSheet.empty")} />
                ) : (
                    items.map((item) => (
                        <Thumb
                            key={item.id}
                            item={item}
                            media={media}
                            order={attachedOrder(read.get(item.id), attached)}
                            busy={reading.has(item.id)}
                            tooLarge={maxBytes > 0 && item.size > maxBytes}
                            onToggle={() => void toggle(item)}
                        />
                    ))
                )}
                {more ? <div ref={end} className="col-span-3 h-px" aria-hidden /> : null}
            </div>
            {/* Over the grid, not under it: a line appearing would move every square. */}
            {readFailed ? (
                <p
                    role="alert"
                    className="absolute inset-x-2 bottom-2 truncate rounded-md bg-danger px-3 py-2 text-center text-xs text-white shadow-sm"
                    title={t("attachSheet.readFailed")}
                >
                    {t("attachSheet.readFailed")}
                </p>
            ) : null}
        </section>
    );
}

/** Its place among what the message carries, 0 when it is not on it. */
function attachedOrder(file: File | undefined, attached: readonly File[]): number {
    return file ? attached.indexOf(file) + 1 : 0;
}

function Notice({ text, wide, children }: { text: string; wide?: boolean; children?: ReactNode }) {
    return (
        <div
            className={cn(
                "flex min-w-0 items-center gap-3 rounded-md bg-surface p-3",
                wide && "col-span-2 flex-col items-start justify-center"
            )}
        >
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">{text}</p>
            {children}
        </div>
    );
}

function Thumb({
    item,
    media,
    order,
    busy,
    tooLarge,
    onToggle
}: {
    item: DeviceMediaItem;
    media: PhoneMedia;
    /** Its place in the selection, 0 when it is not chosen. */
    order: number;
    /** Being read off the phone for the message. */
    busy: boolean;
    tooLarge: boolean;
    onToggle: () => void;
}) {
    const t = useTranslations("chat");
    const [src, setSrc] = useState(() => thumbs.get(item.id) ?? "");
    const box = useRef<HTMLButtonElement>(null);

    // Asked for only once the square scrolls near the screen: a library of
    // thousands costs the previews somebody actually looks at.
    useEffect(() => {
        const node = box.current;
        if (src || !node) return;
        let live = true;
        const watch = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                watch.disconnect();
                media.thumb(item.id).then(
                    (found) => {
                        keepThumb(item.id, found);
                        if (live) setSrc(found);
                    },
                    () => undefined
                );
            },
            { rootMargin: "200px" }
        );
        watch.observe(node);
        return () => {
            live = false;
            watch.disconnect();
        };
    }, [item.id, media, src]);

    const label = item.video ? t("attachSheet.video", { length: clipLength(item.duration) }) : t("attachSheet.photo");
    return (
        <button
            ref={box}
            type="button"
            onClick={tooLarge ? undefined : onToggle}
            aria-pressed={order > 0}
            aria-disabled={tooLarge || undefined}
            aria-busy={busy || undefined}
            aria-label={tooLarge ? `${label}, ${t("attachSheet.tooLarge")}` : label}
            className="relative aspect-square min-w-0 overflow-hidden rounded-md bg-muted [-webkit-tap-highlight-color:transparent]"
        >
            {src ? (
                <img
                    src={src}
                    alt=""
                    draggable={false}
                    className={cn("size-full object-cover", (tooLarge || busy) && "opacity-40")}
                />
            ) : null}
            {order > 0 ? <span aria-hidden className="absolute inset-0 rounded-md ring-2 ring-inset ring-primary" /> : null}
            <span
                aria-hidden
                className={cn(
                    "absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-full text-xs font-medium",
                    order > 0 ? "bg-primary text-primary-foreground" : "border-2 border-white/90 bg-black/20"
                )}
            >
                {order > 0 ? order : null}
            </span>
            {item.video ? (
                <span
                    aria-hidden
                    className="absolute bottom-1 start-1 flex max-w-[calc(100%-0.5rem)] items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[0.6875rem] font-medium text-white"
                >
                    <Play className="size-3 shrink-0 fill-current" />
                    <span className="truncate tabular-nums">{clipLength(item.duration)}</span>
                </span>
            ) : null}
            {tooLarge ? (
                <span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/60 px-1 py-0.5 text-center text-[0.6875rem] text-white">
                    {t("attachSheet.tooLarge")}
                </span>
            ) : null}
        </button>
    );
}

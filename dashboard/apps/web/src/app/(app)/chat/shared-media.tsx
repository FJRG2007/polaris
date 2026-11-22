"use client";

/**
 * What was sent here as pictures and videos, drawn the way WhatsApp's chat info
 * draws it: square tiles cropped to fill, three abreast, a hairline apart.
 *
 * The info page shows the newest row or two and a way into the whole of it; the
 * whole of it is the same grid under a heading per month, fetched a page at a
 * time as it is scrolled. A tile opens in the chat's own viewer, stepping
 * through every picture and video loaded so far; a video plays right there.
 */

import { Play } from "lucide-react";
import { cn, Skeleton } from "@polaris/ui";
import { formatElapsed } from "@polaris/core";
import { unlockProofFor } from "./lock-session";
import { attachmentImageUrl } from "./message-gallery";
import { placeholderUrl } from "@/lib/chat/media-shape";
import { listSharedMediaAction, type SharedMediaItem } from "./actions";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { ImageViewer, thumbnailOf, type ViewedImage } from "@/components/image-viewer";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** How many tiles the info page shows before "see all": two rows of three. */
const PREVIEW_TILES = 6;

interface SharedMedia {
    readonly items: readonly SharedMediaItem[];
    /** Whether the first page has come back, or failed to. */
    readonly loaded: boolean;
    readonly failed: boolean;
    readonly more: boolean;
    readonly loading: boolean;
    readonly loadMore: () => void;
}

/** The conversation's pictures and videos, newest first, a page at a time. */
export function useSharedMedia(channelId: string): SharedMedia {
    const [items, setItems] = useState<readonly SharedMediaItem[]>([]);
    const [next, setNext] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    // The conversation the answers belong to: one that lands after a switch is
    // for a conversation no longer on screen.
    const current = useRef(channelId);
    const busy = useRef(false);

    const fetchPage = useCallback(
        async (before: string | null) => {
            if (busy.current) return;
            busy.current = true;
            setLoading(true);
            const asked = channelId;
            try {
                const page = await listSharedMediaAction({ channelId, before }, unlockProofFor(channelId));
                if (current.current !== asked) return;
                setItems((known) => (before ? [...known, ...page.items] : page.items));
                setNext(page.next);
                setFailed(false);
            } catch {
                if (current.current === asked) setFailed(true);
            } finally {
                busy.current = false;
                if (current.current === asked) {
                    setLoaded(true);
                    setLoading(false);
                }
            }
        },
        [channelId]
    );

    useEffect(() => {
        current.current = channelId;
        busy.current = false;
        setItems([]);
        setNext(null);
        setLoaded(false);
        void fetchPage(null);
    }, [channelId, fetchPage]);

    const loadMore = useCallback(() => {
        if (next) void fetchPage(next);
        else if (failed) void fetchPage(null);
    }, [failed, fetchPage, next]);

    return { items, loaded, failed, more: next !== null, loading, loadMore };
}

/** The address a tile draws: the picture, or a video's still. */
function tileUrl(item: SharedMediaItem): string | null {
    if (!item.video) return attachmentImageUrl(item.id);
    return item.hasPoster ? `${attachmentImageUrl(item.id)}?poster=1` : null;
}

function viewed(item: SharedMediaItem): ViewedImage {
    return {
        url: attachmentImageUrl(item.id),
        name: item.name,
        messageId: item.messageId,
        forwardable: item.forwardable,
        placeholder: placeholderUrl(item.thumbhash),
        ...(item.video
            ? { video: true, poster: item.hasPoster ? `${attachmentImageUrl(item.id)}?poster=1` : undefined }
            : {})
    };
}

function MediaTile({ item, onOpen }: { item: SharedMediaItem; onOpen: (item: SharedMediaItem) => void }) {
    const t = useTranslations("chat");
    const src = tileUrl(item);
    const placeholder = placeholderUrl(item.thumbhash);
    const face = (
        <>
            {src ? (
                // eslint-disable-next-line @next/next/no-img-element -- a served attachment, not a static asset
                <img
                    src={src}
                    alt={item.name}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="size-full object-cover"
                />
            ) : null}
            {item.video ? (
                <span className="absolute bottom-1 start-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-px text-[0.625rem] font-medium leading-4 text-white">
                    <Play aria-hidden className="size-2.5 shrink-0 fill-current" />
                    {item.durationMs ? formatElapsed(item.durationMs) : <span className="sr-only">{t("info.video")}</span>}
                </span>
            ) : null}
        </>
    );
    const className =
        "relative block aspect-square min-w-0 overflow-hidden bg-muted bg-cover bg-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
    const style = placeholder ? { backgroundImage: `url(${placeholder})` } : undefined;
    return (
        <button type="button" title={item.name} onClick={() => onOpen(item)} className={className} style={style}>
            {face}
        </button>
    );
}

function TileGrid({ wide, children }: { wide: boolean; children: ReactNode }) {
    return (
        <div className={cn("grid grid-cols-3 gap-0.5", wide && "sm:grid-cols-4 md:grid-cols-5")}>{children}</div>
    );
}

/** The chat's viewer over the pictures and videos loaded so far, opened on one. */
function useViewer(items: readonly SharedMediaItem[]) {
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    const gallery = useMemo(() => items.map(viewed), [items]);
    const viewer = (
        <ImageViewer
            image={viewing}
            gallery={gallery}
            onNavigate={setViewing}
            onClose={() => setViewing(null)}
            origin={thumbnailOf}
        />
    );
    return { open: (item: SharedMediaItem) => setViewing(viewed(item)), viewer };
}

/** The info page's part: the newest tiles and the way into all of them. */
export function SharedMediaPreview({ media, onSeeAll }: { media: SharedMedia; onSeeAll: () => void }) {
    const t = useTranslations("chat");
    const { open, viewer } = useViewer(media.items);
    if (media.loaded && media.items.length === 0 && !media.failed) return null;
    const shown = media.items.slice(0, PREVIEW_TILES);
    return (
        <section className="flex flex-col border-t border-border pb-2">
            <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1">
                <h3 className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("info.media")}
                </h3>
                {media.loaded ? (
                    <button
                        type="button"
                        onClick={onSeeAll}
                        className="shrink-0 rounded px-1 text-xs text-primary hover:underline"
                    >
                        {t("info.mediaSeeAll")}
                    </button>
                ) : null}
            </div>
            <div className="px-3">
                <TileGrid wide={false}>
                    {media.loaded
                        ? shown.map((item) => <MediaTile key={item.id} item={item} onOpen={open} />)
                        : Array.from({ length: 3 }, (_, index) => (
                              <Skeleton key={index} className="aspect-square rounded-none" />
                          ))}
                </TileGrid>
            </div>
            {media.failed ? (
                <p role="alert" className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs text-danger">
                    {t("info.mediaFailed")}
                    <button type="button" onClick={media.loadMore} className="text-primary hover:underline">
                        {t("info.mediaRetry")}
                    </button>
                </p>
            ) : null}
            {viewer}
        </section>
    );
}

/** Everything, a heading per month, the next page fetched near the bottom. */
export function SharedMediaAll({ media, wide }: { media: SharedMedia; wide: boolean }) {
    const t = useTranslations("chat");
    const locale = useLocale();
    const { open, viewer } = useViewer(media.items);
    const sentinel = useRef<HTMLDivElement>(null);
    const { more, loading, loadMore } = media;

    useEffect(() => {
        const node = sentinel.current;
        if (!node || !more || loading) return;
        const watcher = new IntersectionObserver(
            (seen) => {
                if (seen.some((entry) => entry.isIntersecting)) loadMore();
            },
            { rootMargin: "400px 0px" }
        );
        watcher.observe(node);
        return () => watcher.disconnect();
    }, [loadMore, loading, more]);

    const months = useMemo(() => {
        const name = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });
        const runs: { key: string; label: string; items: SharedMediaItem[] }[] = [];
        for (const item of media.items) {
            const sent = new Date(item.sentAt);
            const key = `${sent.getFullYear()}-${sent.getMonth()}`;
            const last = runs.at(-1);
            if (last?.key === key) last.items.push(item);
            else runs.push({ key, label: name.format(sent), items: [item] });
        }
        return runs;
    }, [locale, media.items]);

    return (
        <div className="flex flex-col pb-3">
            {months.map((month) => (
                <section key={month.key} className="flex flex-col">
                    <h3 className="px-3 pt-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                        {month.label}
                    </h3>
                    <TileGrid wide={wide}>
                        {month.items.map((item) => (
                            <MediaTile key={item.id} item={item} onOpen={open} />
                        ))}
                    </TileGrid>
                </section>
            ))}
            {!media.loaded || loading ? (
                <div className="pt-0.5">
                    <TileGrid wide={wide}>
                        {Array.from({ length: 6 }, (_, index) => (
                            <Skeleton key={index} className="aspect-square rounded-none" />
                        ))}
                    </TileGrid>
                </div>
            ) : null}
            {media.failed ? (
                <p role="alert" className="flex flex-wrap items-center gap-2 px-3 pt-3 text-xs text-danger">
                    {t("info.mediaFailed")}
                    <button type="button" onClick={loadMore} className="text-primary hover:underline">
                        {t("info.mediaRetry")}
                    </button>
                </p>
            ) : null}
            <div ref={sentinel} aria-hidden className="h-px" />
            {viewer}
        </div>
    );
}

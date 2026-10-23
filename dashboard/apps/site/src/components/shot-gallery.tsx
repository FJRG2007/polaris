"use client";

/**
 * Screenshots that open in Polaris's own picture viewer: the same component
 * the dashboard uses, with its zoom, arrows, keys and close, so a picture on
 * the site behaves the way it does in the product.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button, cn } from "@polaris/ui";
import { ImageViewer, type ViewedImage } from "@polaris/ui/image-viewer";

export interface Shot {
    readonly name: string;
    readonly caption: string;
    readonly alt: string;
    /** Addresses, already under the site's base path. */
    readonly dark: string;
    readonly light: string | null;
    /** The phone captures, drawn under 640 px like the dashboard's gallery. */
    readonly darkMobile?: string | null;
    readonly lightMobile?: string | null;
}

/** Up to this width a phone capture replaces the desktop one, as in the dashboard. */
const PHONE = "(max-width: 640px)";

export interface ViewerWords {
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly more: string;
    readonly close: string;
    readonly previous: string;
    readonly next: string;
    /** "{index} of {count}". */
    readonly position: string;
    readonly open: string;
}

/** The picture that matches the theme the page is drawn in. */
function shown(shot: Shot): string {
    const light =
        typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches;
    return light && shot.light ? shot.light : shot.dark;
}

export function ShotPicture({ shot, className }: { shot: Shot; className?: string }) {
    return (
        <picture>
            {shot.lightMobile ? (
                <source
                    media={`${PHONE} and (prefers-color-scheme: light)`}
                    srcSet={shot.lightMobile}
                />
            ) : null}
            {shot.darkMobile ? (
                <source
                    media={
                        shot.light && !shot.lightMobile
                            ? `${PHONE} and (prefers-color-scheme: dark)`
                            : PHONE
                    }
                    srcSet={shot.darkMobile}
                />
            ) : null}
            {shot.light ? (
                <source media="(prefers-color-scheme: light)" srcSet={shot.light} />
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element -- static export, webp */}
            <img
                src={shot.dark}
                alt={shot.alt}
                loading="lazy"
                className={cn("w-full", className)}
            />
        </picture>
    );
}

/** Opens any of `shots` in the viewer; `children` draws the thumbnails. */
export function useShotViewer(shots: readonly Shot[], words: ViewerWords) {
    const [open, setOpen] = useState<ViewedImage | null>(null);
    const gallery = (): ViewedImage[] =>
        shots.map((shot) => ({ url: shown(shot), name: shot.name }));
    const viewer = (
        <ImageViewer
            image={open}
            onClose={() => setOpen(null)}
            gallery={open ? gallery() : undefined}
            onNavigate={setOpen}
            labels={{
                ...words,
                position: (index, count) =>
                    words.position
                        .replace("{index}", String(index))
                        .replace("{count}", String(count))
            }}
        />
    );
    return { viewer, open: (shot: Shot) => setOpen({ url: shown(shot), name: shot.name }) };
}

export function ShotGallery({
    shots,
    words,
    hero = false
}: {
    shots: readonly Shot[];
    words: ViewerWords;
    /** The first one large, as the page's lead picture. */
    hero?: boolean;
}) {
    const { viewer, open } = useShotViewer(shots, words);
    return (
        <>
            <div className={cn("grid grid-cols-1 gap-4", !hero && "sm:grid-cols-2 xl:grid-cols-3")}>
                {shots.map((shot) => (
                    <figure key={shot.dark} className="flex min-w-0 flex-col gap-2">
                        <button
                            type="button"
                            onClick={() => open(shot)}
                            aria-label={`${words.open}: ${shot.name}`}
                            className="group block overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                            <ShotPicture
                                shot={shot}
                                className="transition-transform duration-300 group-hover:scale-[1.015]"
                            />
                        </button>
                        {hero ? null : (
                            <figcaption className="min-w-0 text-sm">
                                <b className="font-semibold">{shot.name}</b>
                                {shot.caption ? (
                                    <span className="text-muted-foreground"> - {shot.caption}</span>
                                ) : null}
                            </figcaption>
                        )}
                    </figure>
                ))}
            </div>
            {viewer}
        </>
    );
}

/**
 * An app page's screenshots the way the dashboard's app page shows them: one
 * row of large pictures that snaps, with where you are and the arrows beside
 * the heading, each picture opening in the viewer.
 */
export function ShotCarousel({
    title,
    shots,
    words
}: {
    title: string;
    shots: readonly Shot[];
    words: ViewerWords;
}) {
    const { viewer, open } = useShotViewer(shots, words);
    const strip = useRef<HTMLDivElement>(null);
    const [current, setCurrent] = useState(0);

    const go = (index: number) => {
        const next = Math.max(0, Math.min(shots.length - 1, index));
        setCurrent(next);
        const item = strip.current?.children[next] as HTMLElement | undefined;
        item?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "start" });
    };

    const onScroll = () => {
        const box = strip.current;
        if (!box || box.children.length === 0) return;
        if (box.scrollLeft + box.clientWidth >= box.scrollWidth - 1) {
            setCurrent(box.children.length - 1);
            return;
        }
        const left = box.getBoundingClientRect().left;
        let nearest = 0;
        let distance = Number.POSITIVE_INFINITY;
        Array.from(box.children).forEach((child, index) => {
            const gap = Math.abs(child.getBoundingClientRect().left - left);
            if (gap < distance) {
                distance = gap;
                nearest = index;
            }
        });
        setCurrent(nearest);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowRight") go(current + 1);
        else if (event.key === "ArrowLeft") go(current - 1);
        else return;
        event.preventDefault();
    };

    return (
        <>
            <div className="flex min-w-0 items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{title}</h2>
                {shots.length > 1 ? (
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground" aria-live="polite">
                            {words.position
                                .replace("{index}", String(current + 1))
                                .replace("{count}", String(shots.length))}
                        </span>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={words.previous}
                            title={words.previous}
                            disabled={current === 0}
                            onClick={() => go(current - 1)}
                        >
                            <ChevronLeft className="size-4" />
                        </Button>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={words.next}
                            title={words.next}
                            disabled={current === shots.length - 1}
                            onClick={() => go(current + 1)}
                        >
                            <ChevronRight className="size-4" />
                        </Button>
                    </div>
                ) : null}
            </div>
            <div
                ref={strip}
                role="group"
                aria-roledescription="carousel"
                aria-label={title}
                tabIndex={0}
                onKeyDown={onKeyDown}
                onScroll={onScroll}
                className="flex snap-x snap-mandatory gap-3 overflow-x-auto rounded-md pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                {shots.map((shot, index) => (
                    <figure
                        key={shot.dark}
                        aria-current={index === current ? "true" : undefined}
                        className="flex w-[85%] max-w-2xl shrink-0 snap-start flex-col gap-2 sm:w-[70%]"
                    >
                        <button
                            type="button"
                            aria-label={`${words.open}: ${shot.name}`}
                            onClick={() => open(shot)}
                            onFocus={() => setCurrent(index)}
                            className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <ShotPicture shot={shot} className="rounded-md border border-border" />
                        </button>
                        {shot.caption ? (
                            <figcaption className="min-w-0 text-xs text-muted-foreground">
                                <b className="font-medium text-foreground">{shot.name}</b> -{" "}
                                {shot.caption}
                            </figcaption>
                        ) : null}
                    </figure>
                ))}
            </div>
            {viewer}
        </>
    );
}

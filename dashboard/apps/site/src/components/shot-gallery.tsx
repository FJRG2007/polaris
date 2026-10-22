"use client";

/**
 * Screenshots that open in Polaris's own picture viewer: the same component
 * the dashboard uses, with its zoom, arrows, keys and close, so a picture on
 * the site behaves the way it does in the product.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { ImageViewer, type ViewedImage } from "@polaris/ui/image-viewer";

export interface Shot {
    readonly name: string;
    readonly caption: string;
    readonly alt: string;
    /** Addresses, already under the site's base path. */
    readonly dark: string;
    readonly light: string | null;
}

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

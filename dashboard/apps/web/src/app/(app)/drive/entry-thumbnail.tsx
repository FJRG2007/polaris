"use client";

/**
 * The picture on a tile, and the icon it falls back to.
 *
 * The rule the whole thumbnail path is built on is that an original is read at
 * most once, ever - and this is the half of it that decides when "once"
 * happens. Nothing is requested while a folder is listed. A tile watches for
 * itself coming near the screen and asks then, so scrolling straight through a
 * folder of four hundred photographs opens none of them.
 *
 * Everything else here is about not making it worse than the icon it replaces:
 *
 *   - A name that can never have a picture never renders an image at all, so it
 *     costs no request to find that out.
 *   - The icon is what is drawn until a picture arrives, and what it goes back
 *     to if none does. There is no spinner and no empty box: a tile that is
 *     thinking looks exactly like a tile that has finished, because the answer
 *     is usually "keep the icon" and a flicker between the two is worse than
 *     either.
 *   - The version is in the URL, so the browser can hold the answer for a year
 *     and an edited file is a different address rather than a stale picture.
 */

import { cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";

/** How far ahead of the viewport a tile starts asking. Roughly one screen, so
 *  the picture is usually there by the time somebody scrolls to it, and a fast
 *  scroll past still opens nothing. */
const LOOKAHEAD = "300px";

export function EntryThumbnail({
    connectionId,
    path,
    version,
    className,
    children
}: {
    readonly connectionId: string;
    readonly path: string;
    /** What makes this file this version of itself - when it changed and how big
     *  it is. In the URL so the answer can be cached forever and still never be
     *  wrong. */
    readonly version: string;
    readonly className?: string;
    /** The icon, drawn until a picture arrives and kept if none does. */
    readonly children: React.ReactNode;
}) {
    const holder = useRef<HTMLSpanElement>(null);
    const [asked, setAsked] = useState(false);
    const [drawn, setDrawn] = useState(false);

    useEffect(() => {
        // A new file in the same tile is a new question.
        setAsked(false);
        setDrawn(false);
    }, [connectionId, path, version]);

    useEffect(() => {
        if (asked) return;
        const node = holder.current;
        if (!node) return;
        // Without the observer - an old browser, a test - the tile simply asks,
        // which is the behaviour a grid had before any of this and not a
        // failure.
        if (typeof IntersectionObserver !== "function") {
            setAsked(true);
            return;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setAsked(true);
                    watch.disconnect();
                }
            },
            { rootMargin: LOOKAHEAD }
        );
        watch.observe(node);
        return () => watch.disconnect();
    }, [asked, connectionId, path, version]);

    const source = `/api/drive/thumbnail?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`;

    return (
        <span ref={holder} className={cn("relative flex items-center justify-center", className)}>
            {drawn ? null : children}
            {asked ? (
                <img
                    src={source}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onLoad={() => setDrawn(true)}
                    // A file that cannot be drawn answers 404, which is not an
                    // error: it is how a tile is told to keep its icon.
                    onError={() => setDrawn(false)}
                    className={cn(
                        "max-h-full max-w-full rounded-sm object-contain",
                        drawn ? "" : "hidden"
                    )}
                />
            ) : null}
        </span>
    );
}

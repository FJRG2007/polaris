"use client";

/**
 * The satellite imagery the server is using, for the map to draw it at the right
 * depth and credit it. Stale-while-revalidate: the last answer (kept per
 * browser) draws at once, the server is asked in the background at most once a
 * minute per page, and the map follows only if the answer changed. Until there
 * is any answer the free default is assumed, which is also what a failed ask
 * leaves in place.
 */

import { z } from "zod";
import { useEffect, useState } from "react";
import { DEFAULT_IMAGERY_VIEW, type ImageryView } from "@/lib/map-layers";

const STORED = "polaris.map.imagery";
const FRESH_MS = 60 * 1000;

const viewSchema = z.object({
    provider: z.enum(["default", "maptiler", "esri", "custom"]),
    nativeMaxZoom: z.number().int().min(0).max(24),
    credits: z.array(z.object({ text: z.string().max(300), href: z.string().url().max(500) })).max(5),
    version: z.string().max(80)
});

let known: ImageryView | null = null;
let askedAt = 0;
let asking: Promise<ImageryView | null> | null = null;
const listeners = new Set<(view: ImageryView) => void>();

function stored(): ImageryView | null {
    try {
        const raw = window.localStorage.getItem(STORED);
        const parsed = raw ? viewSchema.safeParse(JSON.parse(raw)) : null;
        return parsed?.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function ask(): void {
    if (asking || Date.now() - askedAt < FRESH_MS) return;
    askedAt = Date.now();
    asking = fetch("/api/chat/location/imagery", { credentials: "same-origin" })
        .then(async (response) => {
            if (!response.ok) return null;
            const parsed = viewSchema.safeParse(await response.json());
            return parsed.success ? parsed.data : null;
        })
        .catch(() => null)
        .then((view) => {
            asking = null;
            if (!view) return null;
            if (JSON.stringify(view) !== JSON.stringify(known)) {
                known = view;
                try {
                    window.localStorage.setItem(STORED, JSON.stringify(view));
                } catch {
                    // A browser that keeps nothing still draws; it asks again next time.
                }
                for (const listener of listeners) listener(view);
            }
            return view;
        });
}

/** The imagery in use; `enabled` false (a streets-only map) asks nothing. */
export function useImagery(enabled: boolean): ImageryView {
    const [view, setView] = useState<ImageryView>(() => known ?? DEFAULT_IMAGERY_VIEW);
    useEffect(() => {
        if (!enabled) return;
        known ??= stored();
        if (known) setView(known);
        listeners.add(setView);
        ask();
        return () => {
            listeners.delete(setView);
        };
    }, [enabled]);
    return view;
}

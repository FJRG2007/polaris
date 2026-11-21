"use client";

/**
 * A country or region's flag, drawn from the vendored SVGs rather than an
 * emoji: Windows has no flag emoji and shows two letters instead.
 *
 * Each flag is its own module, fetched the first time it is drawn and kept for
 * the rest of the visit. A flag in a long list waits until its row is scrolled
 * near the view, so opening a list of every country fetches the dozen flags on
 * screen, not two hundred. A code with no vendored flag, or none at all, gets a
 * neutral blank of the same size, so its row still lines up with the others.
 */

import { cn } from "../lib/cn";
import { FLAG_LOADERS } from "../flags";
import { useEffect, useRef, useState } from "react";

/** Flags already fetched, so a row drawn again shows its flag at once. */
const loaded = new Map<string, string>();

function dataUrl(svg: string): string {
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

/** The vendored flag's key for a code (`ES`, `es`, `es-ct`), or null when there is none. */
export function flagKey(code: string | null | undefined): string | null {
    const key = code?.toLowerCase();
    return key && key in FLAG_LOADERS ? key : null;
}

export function CountryFlag({
    code,
    className
}: {
    /** An ISO 3166-1 code in either case, or a vendored region key (`es-ct`). */
    code: string | null | undefined;
    className?: string;
}) {
    const key = flagKey(code);
    const box = useRef<HTMLSpanElement>(null);
    const [svg, setSvg] = useState(() => (key ? (loaded.get(key) ?? null) : null));

    useEffect(() => {
        if (!key) return setSvg(null);
        const known = loaded.get(key);
        if (known) return setSvg(known);
        setSvg(null);
        let alive = true;
        const fetchFlag = () => {
            FLAG_LOADERS[key]!()
                .then((module) => {
                    loaded.set(key, module.default);
                    if (alive) setSvg(module.default);
                })
                // A flag that cannot be fetched leaves its slot empty; the name is the answer.
                .catch(() => undefined);
        };
        const element = box.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            fetchFlag();
            return () => {
                alive = false;
            };
        }
        const watcher = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                watcher.disconnect();
                fetchFlag();
            },
            { rootMargin: "200px" }
        );
        watcher.observe(element);
        return () => {
            alive = false;
            watcher.disconnect();
        };
    }, [key]);

    return (
        <span
            ref={box}
            aria-hidden
            data-flag={key ?? "none"}
            data-icon-placeholder={key ? undefined : ""}
            className={cn(
                "inline-block h-3 w-4 shrink-0 rounded-[2px] bg-muted bg-cover bg-center shadow-[0_0_0_1px_rgb(0_0_0/0.08)]",
                className
            )}
            style={svg ? { backgroundImage: dataUrl(svg) } : undefined}
        />
    );
}

"use client";

/**
 * The landing's tour: a row of tabs, the main features first and the rest
 * behind More, and under it the picked feature playing in its capture.
 *
 * A WAI-ARIA tablist with a roving tabindex: Tab reaches the picked tab, the
 * arrow keys, Home and End move between tabs and pick them. Only the picked
 * feature's capture is in the page, loaded when the tour scrolls near. A reader
 * who asked for less motion sees the capture's first frame, held still.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface Feature {
    readonly id: string;
    readonly label: string;
    readonly caption: string;
    readonly alt: string;
    readonly dark: string;
    readonly light: string | null;
    /** The phone captures, played under 640 px like the site's other pictures. */
    readonly darkMobile: string | null;
    readonly lightMobile: string | null;
    /** The feature's page in the marketplace. */
    readonly href: string;
}

/** Whether a media query matches, kept current as the window changes. */
function useMedia(media: string): boolean {
    const [matches, setMatches] = useState(false);
    useEffect(() => {
        const query = window.matchMedia(media);
        const update = () => setMatches(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, [media]);
    return matches;
}

/** The capture that matches the theme and the width, picked as `ShotPicture` picks. */
function captureFor(feature: Feature, light: boolean, phone: boolean): string {
    if (phone && light && feature.lightMobile) return feature.lightMobile;
    if (light && feature.light) return feature.light;
    return phone && feature.darkMobile ? feature.darkMobile : feature.dark;
}

/**
 * The capture, playing; or, for less motion, its first frame drawn once onto a
 * canvas, which never animates.
 */
function Capture({ feature, still }: { feature: Feature; still: boolean }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const light = useMedia("(prefers-color-scheme: light)");
    const phone = useMedia("(max-width: 640px)");
    const src = captureFor(feature, light, phone);
    useEffect(() => {
        if (!still) return;
        const image = new Image();
        image.onload = () => {
            const target = canvas.current;
            if (!target) return;
            target.width = image.naturalWidth;
            target.height = image.naturalHeight;
            target.getContext("2d")?.drawImage(image, 0, 0);
        };
        image.src = src;
    }, [still, src]);
    return still ? (
        <canvas ref={canvas} role="img" aria-label={feature.alt} className="block h-auto w-full" />
    ) : (
        // eslint-disable-next-line @next/next/no-img-element -- static export, animated webp
        <img key={src} src={src} alt={feature.alt} loading="lazy" className="block h-auto w-full" />
    );
}

export function FeatureTabs({
    main,
    more,
    words
}: {
    main: readonly Feature[];
    more: readonly Feature[];
    words: { readonly label: string; readonly more: string; readonly open: string };
}) {
    const [picked, setPicked] = useState(main[0]?.id ?? "");
    const [expanded, setExpanded] = useState(false);
    const still = useMedia("(prefers-reduced-motion: reduce)");
    const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
    // A tab More reveals exists only after the render it causes, so it takes
    // focus from an effect rather than from the press.
    const [reveal, setReveal] = useState<string | null>(null);
    useEffect(() => {
        if (!reveal) return;
        tabs.current[reveal]?.focus();
        tabs.current[reveal]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        setReveal(null);
    }, [reveal]);
    const shown = expanded ? [...main, ...more] : main;
    const feature = [...main, ...more].find((entry) => entry.id === picked) ?? main[0];
    if (!feature) return null;

    const pick = (id: string) => {
        setPicked(id);
        tabs.current[id]?.focus();
        tabs.current[id]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const at = shown.findIndex((entry) => entry.id === picked);
        const to =
            event.key === "ArrowRight"
                ? (at + 1) % shown.length
                : event.key === "ArrowLeft"
                  ? (at - 1 + shown.length) % shown.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? shown.length - 1
                      : -1;
        if (to < 0) return;
        event.preventDefault();
        pick(shown[to]!.id);
    };

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 items-center gap-2">
                <div
                    role="tablist"
                    aria-label={words.label}
                    onKeyDown={onKeyDown}
                    className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible"
                >
                    {shown.map((entry) => {
                        const selected = entry.id === feature.id;
                        return (
                            <button
                                key={entry.id}
                                ref={(node) => {
                                    tabs.current[entry.id] = node;
                                }}
                                type="button"
                                role="tab"
                                id={`tour-tab-${entry.id}`}
                                aria-selected={selected}
                                aria-controls="tour-panel"
                                tabIndex={selected ? 0 : -1}
                                onClick={() => setPicked(entry.id)}
                                className={cn(
                                    "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                                    selected
                                        ? "border-foreground bg-foreground text-background"
                                        : "border-border text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {entry.label}
                            </button>
                        );
                    })}
                </div>
                {more.length > 0 && !expanded ? (
                    <button
                        type="button"
                        aria-expanded={false}
                        onClick={() => {
                            setExpanded(true);
                            setPicked(more[0]!.id);
                            setReveal(more[0]!.id);
                        }}
                        className="shrink-0 rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        {words.more}
                    </button>
                ) : null}
            </div>
            <div
                id="tour-panel"
                role="tabpanel"
                aria-labelledby={`tour-tab-${feature.id}`}
                className="flex min-w-0 flex-col gap-3"
            >
                <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                    <Capture feature={feature} still={still} />
                </div>
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="min-w-0 text-sm text-muted-foreground">{feature.caption}</p>
                    <Link
                        href={feature.href}
                        className="inline-flex shrink-0 items-center gap-1 text-sm font-medium hover:underline"
                    >
                        {words.open}
                        <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                </div>
            </div>
        </div>
    );
}

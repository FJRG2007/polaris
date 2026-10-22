/**
 * A marketplace listing: the 16:10 preview at the top, then the app's mark,
 * name and byline, its summary, its badges, and a footer for whatever the screen
 * lets the reader do with it.
 *
 * Drawn the same by the dashboard's marketplace and the public site. Everything
 * that depends on where it is drawn - links, translated words, the mark, the
 * actions - comes in as props, so this holds the look and nothing else.
 *
 * The preview is the app's first real capture. An app nobody has captured yet
 * gets a placeholder drawn from what it already is - its mark, name and summary
 * on its own colour - and never a mocked-up screen.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";
import { Badge } from "../components/badge";

/**
 * The preview's height: 16:10 of its width, rounded down to a whole pixel.
 *
 * A plain `aspect-[16/10]` gives a fractional height for almost every column
 * width (a 415px card is 259.375px tall), and every card body and every row
 * below it then starts between two pixels. A browser that scrolls in
 * fractions of a pixel snaps each line of text to the pixel grid on its own,
 * so while the page moves the text steps up and down against the borders
 * around it. `round()` against the container's width keeps the height whole;
 * a browser without `round()` drops the declaration and keeps the ratio.
 */
export const PREVIEW_HEIGHT = "aspect-[16/10] h-[round(down,calc(100cqw*10/16),1px)]";

/** An app's capture, per theme, for a desktop and a phone. */
export interface StoreShot {
    readonly dark: { readonly desktop: string; readonly mobile: string };
    readonly light: { readonly desktop: string; readonly mobile: string };
}

/**
 * Which theme's capture is shown, picked by CSS so the first paint is already
 * right: dark by default, the light one under `.light`, and under `.system` on
 * a light machine.
 */
const THEME_CLASS = {
    dark: "block [:root.light_&]:hidden [@media(prefers-color-scheme:light)]:[:root.system_&]:hidden",
    light: "hidden [:root.light_&]:block [@media(prefers-color-scheme:light)]:[:root.system_&]:block"
} as const;

/** A 16:10 preview: the capture in the reader's theme, or the designed placeholder. */
export function StorePreview({
    name,
    summary,
    mark,
    tint,
    ink,
    shot,
    alt,
    className,
    eager = false
}: {
    name: string;
    summary: string;
    /** The app's mark at 44px, for the placeholder. */
    mark: ReactNode;
    /** The placeholder's colour and the text colour that reads on it. */
    tint: string;
    ink: string;
    shot: StoreShot | null;
    /** What the picture shows, already translated. */
    alt: string;
    className?: string;
    eager?: boolean;
}) {
    const box = cn("overflow-hidden [container-type:inline-size]", className);
    const frame = cn("relative w-full overflow-hidden bg-surface", PREVIEW_HEIGHT);
    if (shot) {
        return (
            <div className={box}>
                <div className={frame}>
                    {(["dark", "light"] as const).map((theme) => (
                        <picture key={theme} className={THEME_CLASS[theme]} data-theme-shot={theme}>
                            <source media="(max-width: 640px)" srcSet={shot[theme].mobile} />
                            {/* eslint-disable-next-line @next/next/no-img-element -- static webp, no optimizer needed */}
                            <img
                                src={shot[theme].desktop}
                                alt={alt}
                                loading={eager ? "eager" : "lazy"}
                                className="size-full object-cover object-top"
                            />
                        </picture>
                    ))}
                </div>
            </div>
        );
    }
    return (
        <div className={box}>
            <div
                className={cn(
                    frame,
                    "flex flex-col items-center justify-center gap-2 p-4 text-center"
                )}
                style={{ backgroundColor: tint, color: ink }}
                data-preview="placeholder"
                role="img"
                aria-label={alt}
            >
                <span className="rounded-xl bg-background/90 p-2 shadow-sm">{mark}</span>
                <span className="max-w-full truncate text-sm font-semibold" title={name}>
                    {name}
                </span>
                <span className="line-clamp-2 max-w-[28ch] text-xs opacity-80">{summary}</span>
            </div>
        </div>
    );
}

/** Running, stopped, failed or installing, in the colour the rest of Polaris uses. */
export function StatusBadge({ status, label }: { status: string; label: string }) {
    return (
        <Badge
            className={cn(
                status === "failed" && "border-danger-edge text-danger",
                status === "running" && "border-success-edge text-success"
            )}
        >
            {label}
        </Badge>
    );
}

/** A card's frame: the preview on top, the body below, the whole height of its row. */
export function StoreCardFrame({
    preview,
    children,
    muted
}: {
    preview: ReactNode;
    children: ReactNode;
    muted?: boolean;
}) {
    return (
        <article
            className={cn(
                "flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
                muted && "opacity-75"
            )}
        >
            {preview}
            <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">{children}</div>
        </article>
    );
}

/** One listing, from its preview to its footer. */
export function StoreCard({
    preview,
    mark,
    title,
    byline,
    summary,
    badges,
    note,
    status,
    actions,
    featured = false,
    muted
}: {
    preview: ReactNode;
    /** The app's mark at 40px. */
    mark: ReactNode;
    /** The name, as a link where there is a page to open. */
    title: ReactNode;
    /** Who makes it, one line. */
    byline: string;
    summary: string;
    /** The category and capability badges. */
    badges: ReactNode;
    /** A line under the badges, such as a consent the app needs. */
    note?: ReactNode;
    /** The left of the footer: its status, how many are installed. */
    status?: ReactNode;
    /** The right of the footer: what can be done with it. */
    actions?: ReactNode;
    /** A featured card has room for a third line of summary. */
    featured?: boolean;
    muted?: boolean;
}) {
    return (
        <StoreCardFrame muted={muted} preview={preview}>
            <div className="flex min-w-0 items-start gap-3">
                {mark}
                <div className="min-w-0 flex-1">
                    {title}
                    <p className="text-muted-foreground truncate text-xs" title={byline}>
                        {byline}
                    </p>
                </div>
            </div>
            <p
                className={cn(
                    "text-sm text-muted-foreground",
                    featured ? "line-clamp-3" : "line-clamp-2"
                )}
            >
                {summary}
            </p>
            <div className="flex min-w-0 flex-wrap gap-1">{badges}</div>
            {note}
            <div className="mt-auto flex min-w-0 items-center justify-between gap-2 pt-1">
                <div className="flex min-w-0 items-center gap-1.5">{status}</div>
                <div className="flex shrink-0 items-center gap-1">{actions}</div>
            </div>
        </StoreCardFrame>
    );
}

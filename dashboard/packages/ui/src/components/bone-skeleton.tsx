/**
 * A skeleton drawn from a captured layout rather than a guessed one.
 *
 * `npx boneyard-js build` walks the running dashboard and records where every
 * block a screen renders actually sits, once per breakpoint. This draws those
 * rectangles, so the placeholder is the shape of the page that is coming and
 * reserves its height - nothing shifts when the content lands. Which capture
 * applies is decided by media query rather than by measuring in an effect, so
 * the first painted frame is already the right one and there is nothing for
 * hydration to disagree about.
 *
 * A screen with no capture renders whatever `fallback` the caller passes.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";

/**
 * One rectangle: `[x, y, width, height, radius, isContainer?]`. x and width are
 * percentages of the captured width; y, height and a numeric radius are pixels.
 * Typed as the loose array TypeScript infers for an imported `.bones.json`.
 */
export type CapturedBone = readonly (number | string | boolean)[];

/** What one screen looked like at one breakpoint. */
export interface CapturedLayout {
    width: number;
    height: number;
    bones: CapturedBone[];
}

/** A screen's captures, keyed by the viewport width they were taken at. */
export interface ResponsiveLayout {
    breakpoints: Record<string, CapturedLayout>;
}

/**
 * Which viewports each captured width owns, as static classes so Tailwind can
 * see them. Keys are the widths in `apps/web/boneyard.config.json` - a capture
 * taken at a width missing here is never shown, so the two lists move together.
 */
const VISIBILITY: Record<string, string> = {
    "375": "md:hidden",
    "768": "hidden md:block xl:hidden",
    "1280": "hidden xl:block"
};

export function BoneSkeleton({
    layout,
    className,
    fallback
}: {
    layout?: ResponsiveLayout;
    className?: string;
    /** Shown when the screen has no capture yet. */
    fallback?: ReactNode;
}) {
    const captures = Object.entries(layout?.breakpoints ?? {}).filter(([width]) => VISIBILITY[width]);
    if (captures.length === 0) return <>{fallback ?? null}</>;

    return (
        <div className={cn("animate-pulse", className)} aria-busy="true" aria-live="polite">
            {captures.map(([width, capture]) => {
                const column = columnOf(capture);
                return (
                    <div
                        key={width}
                        // A long screen is sketched down to about a screen and a half
                        // and no further: a placeholder several viewports tall is a
                        // scrollbar the content is about to take back.
                        className={cn(
                            "relative max-h-[150vh] overflow-hidden",
                            column ? "mx-auto w-full" : "w-full",
                            VISIBILITY[width]
                        )}
                        style={{ height: capture.height, maxWidth: column?.width }}
                    >
                        {capture.bones.map(toBone).map((bone, index) =>
                            bone.container ? null : (
                                <div
                                    key={index}
                                    className="absolute bg-muted"
                                    style={{
                                        left: `${column ? ((bone.x - column.left) / column.span) * 100 : bone.x}%`,
                                        top: bone.y,
                                        // A round bone is round in pixels: a 50% radius on a
                                        // percentage width would draw an ellipse instead.
                                        width:
                                            bone.radius === "50%"
                                                ? bone.height
                                                : `${column ? (bone.w / column.span) * 100 : bone.w}%`,
                                        height: bone.height,
                                        borderRadius:
                                            typeof bone.radius === "number" ? `${bone.radius}px` : bone.radius
                                    }}
                                />
                            )
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** A recorded column counts as centred when its two margins match this closely. */
const CENTRED_TOLERANCE = 0.5;

/**
 * The fixed-width column a screen was recorded in, in pixels, or null when the
 * screen fills whatever it is given.
 *
 * A capture stores x and width as percentages of the width it was taken at,
 * which only reproduces the page at that exact width: on a wider viewport a
 * `max-w-2xl` column drawn as "68% of the content area" is half as wide again as
 * the column it stands in for. A centred column is the tell - `mx-auto` is what
 * puts it there, and it keeps its pixel width at any viewport - so the extent
 * the bones span is recovered in pixels and the sketch is drawn at that width
 * instead of stretched. A screen that is narrow because of what is in it (a grid
 * with one card in it) sits against its left edge rather than centred, and keeps
 * the percentages, which is what actually follows the content there.
 */
function columnOf(capture: CapturedLayout): { width: number; left: number; span: number } | null {
    if (capture.bones.length === 0) return null;
    const left = Math.min(...capture.bones.map((bone) => Number(bone[0]) || 0));
    const right = Math.max(...capture.bones.map((bone) => (Number(bone[0]) || 0) + (Number(bone[2]) || 0)));
    const span = right - left;
    if (span >= 98 || left <= CENTRED_TOLERANCE) return null;
    if (Math.abs(left - (100 - right)) > CENTRED_TOLERANCE) return null;
    return { width: Math.round((span / 100) * capture.width), left, span };
}

/** Read one bone out of the tuple the capture file stores it as. */
function toBone(raw: CapturedBone) {
    return {
        x: Number(raw[0]) || 0,
        y: Number(raw[1]) || 0,
        w: Number(raw[2]) || 0,
        height: Number(raw[3]) || 0,
        radius: typeof raw[4] === "string" ? raw[4] : Number(raw[4]) || 0,
        container: raw[5] === true
    };
}

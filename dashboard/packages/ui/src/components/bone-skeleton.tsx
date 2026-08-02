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

import { cn } from "../lib/cn.js";
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
            {captures.map(([width, capture]) => (
                <div
                    key={width}
                    // A long screen is sketched down to about a screen and a half
                    // and no further: a placeholder several viewports tall is a
                    // scrollbar the content is about to take back.
                    className={cn("relative w-full max-h-[150vh] overflow-hidden", VISIBILITY[width])}
                    style={{ height: capture.height }}
                >
                    {capture.bones.map(toBone).map((bone, index) =>
                        bone.container ? null : (
                            <div
                                key={index}
                                className="absolute bg-muted"
                                style={{
                                    left: `${bone.x}%`,
                                    top: bone.y,
                                    // A round bone is round in pixels: a 50% radius on a
                                    // percentage width would draw an ellipse instead.
                                    width: bone.radius === "50%" ? bone.height : `${bone.w}%`,
                                    height: bone.height,
                                    borderRadius: typeof bone.radius === "number" ? `${bone.radius}px` : bone.radius
                                }}
                            />
                        )
                    )}
                </div>
            ))}
        </div>
    );
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

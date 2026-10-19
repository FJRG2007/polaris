/**
 * A picture growing out of its thumbnail and shrinking back into it.
 *
 * Shared by the image viewer and Drive's preview, which open a picture from a
 * thumbnail in two different ways. The geometry is pure (`visibleBox`,
 * `flight`); the rest only drives the Web Animations API with transform, clip
 * and opacity, so nothing lays out while a picture flies. With reduced motion
 * asked for, or no `element.animate`, nothing animates at all.
 */

export const OPEN_MS = 220;
export const CLOSE_MS = 180;
export const EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** Where a picture with no thumbnail on screen starts and ends: in place, a
 *  little smaller, transparent. */
export const IN_PLACE = { opacity: 0, transform: "scale(0.94)" };

/** The picture as laid out, fully shown. */
const AT_REST = { opacity: 1, transform: "none", clipPath: "inset(0px 0px)" };

/** A tab in the background may never finish an animation, so a close that waits
 *  on one gives up a little after it should have ended. */
const GIVE_UP_MS = 120;

export interface Box {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** A thumbnail's box while there is one to fly to: on the page, with a size,
 *  and at least partly on screen. */
export function visibleBox(
    element: Element | null,
    viewport: { readonly width: number; readonly height: number }
): Box | null {
    if (!element || !element.isConnected) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    if (
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= viewport.height ||
        rect.left >= viewport.width
    ) {
        return null;
    }
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * The transform and clip that lay the full-size picture (`to`, as laid out) over
 * its thumbnail (`from`). Scaled evenly to cover the thumbnail and clipped to it,
 * so a square crop of a wide picture grows out of the square instead of
 * stretching - transform and clip only, nothing that lays out.
 */
export function flight(from: Box, to: Box): { transform: string; clipPath: string } {
    const scale = Math.max(from.width / to.width, from.height / to.height);
    const dx = from.x + from.width / 2 - (to.x + to.width / 2);
    const dy = from.y + from.height / 2 - (to.y + to.height / 2);
    const insetY = Math.max(0, (to.height - from.height / scale) / 2);
    const insetX = Math.max(0, (to.width - from.width / scale) / 2);
    return {
        transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        clipPath: `inset(${insetY}px ${insetX}px)`
    };
}

/**
 * The thumbnail on screen right now that `attribute` names `id` - the element
 * itself, or what `inner` selects inside it - for a picture to grow out of and
 * shrink back into. Compared as a value rather than built into a selector, so
 * an id with quotes in it finds nothing instead of breaking the query.
 */
export function thumbnailBy(attribute: string, id: string, inner?: string): Element | null {
    for (const holder of document.querySelectorAll(`[${attribute}]`)) {
        if (holder.getAttribute(attribute) !== id) continue;
        const picture = inner ? holder.querySelector(inner) : holder;
        if (visibleBox(picture, viewportSize())) return picture;
    }
    return null;
}

export function reducedMotion(): boolean {
    return (
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
}

export function viewportSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
}

/** Whether this element can fly at all here and now. */
export function canFly(element: Element | null | undefined): element is HTMLElement {
    return (
        element instanceof HTMLElement && !reducedMotion() && typeof element.animate === "function"
    );
}

export function boxOf(element: Element): Box {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Grow an element from `from` to where it is laid out (`at`), or fade and
 *  scale it in place when there is no thumbnail to grow from. */
export function growIn(element: HTMLElement, at: Box, from: Box | null): Animation {
    return element.animate([from ? flight(from, at) : IN_PLACE, AT_REST], {
        duration: OPEN_MS,
        easing: EASE
    });
}

/**
 * Shrink an element from where it is laid out (`at`) into `into`, or fade and
 * scale it in place, starting from `current` (its transform right now). Resolves
 * once it is over, or once it should have been.
 */
export function shrinkOut(
    element: HTMLElement,
    at: Box,
    into: Box | null,
    current = "none"
): Promise<void> {
    const flying = element.animate(
        [{ ...AT_REST, transform: current }, into ? flight(into, at) : IN_PLACE],
        { duration: CLOSE_MS, easing: EASE, fill: "forwards" }
    );
    return new Promise((resolve) => {
        flying.finished.then(
            () => resolve(),
            () => resolve()
        );
        setTimeout(resolve, CLOSE_MS + GIVE_UP_MS);
    });
}

/**
 * A copy of a picture laid over `at`, above everything, for a flight the real
 * one cannot make: it sits inside something that clips it, or it is about to be
 * taken off the page. The caller removes it once the flight is over.
 */
export function pictureCopy(src: string, at: Box): HTMLImageElement {
    const copy = document.createElement("img");
    copy.src = src;
    copy.alt = "";
    copy.setAttribute("aria-hidden", "true");
    Object.assign(copy.style, {
        position: "fixed",
        left: `${at.x}px`,
        top: `${at.y}px`,
        width: `${at.width}px`,
        height: `${at.height}px`,
        objectFit: "contain",
        pointerEvents: "none",
        zIndex: "60",
        margin: "0"
    });
    document.body.appendChild(copy);
    return copy;
}

/** A preview opened on one file, and where that file's picture grows from. */
export interface Opening {
    readonly key: string;
    readonly from: Box | null;
}

/**
 * What a preview remembers about its opening, from one render to the next.
 *
 * The thumbnail is measured once, as the preview opens and before it covers the
 * page. A file stepped to after that fades in place, and so does the first one
 * shown again, because its thumbnail is behind the preview by then. Closed,
 * nothing is kept, so the next opening measures afresh.
 */
export function nextOpening(
    opening: Opening | null,
    key: string | null,
    measure: () => Box | null
): Opening | null {
    if (key === null) return null;
    if (opening === null) return { key, from: measure() };
    if (opening.key !== key && opening.from) return { key: opening.key, from: null };
    return opening;
}

/** Where the picture of `key` grows from: the opened file's thumbnail, or in
 *  place. */
export function openingFrom(opening: Opening | null, key: string): Box | null {
    return opening?.key === key ? opening.from : null;
}

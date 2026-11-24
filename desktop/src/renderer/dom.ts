/**
 * The little the app's own pages share: finding their elements, and the bridge.
 */

import type { PolarisLocal } from "@/shared/bridge";
import { SEASON_MARK_ACCESSORIES, seasonMarkSvg } from "../../../dashboard/packages/core/src/season-mark";

declare global {
    interface Window {
        readonly polarisLocal: PolarisLocal;
    }
}

/** An element the page is known to have. */
export function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`#${id} is missing from the page`);
    return element as T;
}

/** Show a message in an element, or hide the element when there is none. */
export function say(element: HTMLElement, message: string | null): void {
    element.textContent = message ?? "";
    element.hidden = !message;
}

/** A button that looks and reads as unavailable but keeps its focus. */
export function available(button: HTMLButtonElement, yes: boolean): void {
    button.setAttribute("aria-disabled", String(!yes));
}

/**
 * Draw the page's Polaris mark (each `<img>` of the plain `mark.svg`) in the
 * season the window was opened in. Drawn in place rather than as a picture,
 * since the page loads no picture that is not one of its own files; a season
 * the mark has no dress for, or anything that goes wrong, leaves the plain one.
 */
export function dressMark(season: string | null, root: ParentNode = document): void {
    if (!season || !Object.hasOwn(SEASON_MARK_ACCESSORIES, season)) return;
    const markup = seasonMarkSvg(season as keyof typeof SEASON_MARK_ACCESSORIES);
    for (const image of root.querySelectorAll<HTMLImageElement>('img[src="mark.svg"]')) {
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        if (svg.nodeName !== "svg") return;
        svg.setAttribute("class", image.className);
        svg.setAttribute("aria-hidden", "true");
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        image.replaceWith(document.importNode(svg, true));
    }
}

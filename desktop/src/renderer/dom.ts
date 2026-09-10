/**
 * The little the app's own pages share: finding their elements, and the bridge.
 */

import type { PolarisLocal } from "@/shared/bridge";

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

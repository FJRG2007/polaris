/**
 * Right-clicking somewhere else while a context menu is open.
 *
 * Every desktop does the same thing here: the open menu goes and a new one
 * appears where the pointer now is, in one gesture. Polaris did half of it - the
 * menu closed and nothing came back, so reaching the second row's actions was a
 * right-click that appeared to do nothing followed by a second one that worked.
 *
 * The reason is not an oversight in the screens. An open menu is a Radix
 * dismissable layer with `disableOutsidePointerEvents`, which puts
 * `pointer-events: none` on the body: the press that closes the menu is the last
 * event anything outside it receives, and the `contextmenu` that follows never
 * reaches the row underneath. Nothing a screen writes can see that event.
 *
 * So it is answered once, here, for every menu in the application: while a menu
 * is open, the document is watched for a right-click outside it. The point is
 * remembered, the native menu is suppressed, and once the layer has actually gone
 * the same gesture is aimed again at whatever turned out to be under the pointer.
 * A row with a menu opens it; anything else has simply dismissed the menu, which
 * is what it was going to do anyway.
 *
 * Two frames rather than one, and that is the whole subtlety: the first lets
 * React unmount the layer, the second lets the browser apply the body's
 * pointer-events going back to normal. Aiming before that lands on the body,
 * every time, and `elementFromPoint` hands back the wrong element - which reads
 * exactly like the bug this replaces.
 */

import { useEffect } from "react";
import { MENU_SURFACE } from "./menu-press";

/** The button a right-click reports, which is what a re-aimed one has to say. */
const RIGHT_BUTTON = 2;

/** The gesture this dispatched, so the handler is never handed its own work
 *  back. Without it, a right-click the aim cannot resolve away from - one inside
 *  a surface this listener does not recognise - re-enters here two frames later,
 *  and again two frames after that, for as long as the menu is open. */
let reaimed: MouseEvent | null = null;

/** How many menus are open. One listener serves all of them, and it goes when
 *  the last one does rather than when the first one does. */
let watching = 0;

/**
 * What the document does with a right-click while a menu is open.
 *
 * Exported so it can be asked the question directly: the branch that matters is
 * one gesture landing on one element, and rendering a menu to produce it would
 * pin the framework rather than the rule.
 */
export function reaimContextMenu(event: MouseEvent): void {
    // The one this dispatched. It comes back through here because it is
    // dispatched on the document's own tree, and acting on it would be acting
    // on nothing but this function.
    if (event === reaimed) return;

    // Inside a menu: its own business. A menu that re-opened itself when
    // somebody right-clicked one of its own options would be a menu that cannot
    // be used with the right button at all. Asked of the document rather than of
    // one content node, because a submenu is a portal of its own and is not
    // underneath the menu that opened it - measured against the root content
    // alone, every option of an open submenu reads as the page behind it.
    const target = event.target;
    if (target instanceof Element && target.closest(MENU_SURFACE)) return;

    // The browser's own menu must not appear: the press underneath this one has
    // already started closing ours, and two menus arriving from one gesture is
    // worse than none.
    event.preventDefault();

    const x = event.clientX;
    const y = event.clientY;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const under = document.elementFromPoint(x, y);
            if (!under) return;
            reaimed = new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                button: RIGHT_BUTTON,
                buttons: 0
            });
            under.dispatchEvent(reaimed);
            reaimed = null;
        });
    });
}

/**
 * Re-aim a right-click at whatever is under it, once this menu has closed.
 *
 * Mounted by the menu's content, which exists only while the menu is open, so
 * the watch lasts exactly as long as there is something to dismiss.
 */
export function useReopenElsewhere(): void {
    useEffect(() => {
        // `elementFromPoint` is what aims the second gesture, and it is not
        // everywhere: a server render has no document at all, and a headless DOM
        // may have one without it. Nothing here degrades when it is missing -
        // the menu simply behaves as it did before, closing and leaving the next
        // right-click to open the new one.
        if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
            return;
        }

        // Capture, because the layer stops these before they bubble anywhere
        // useful.
        if (watching++ === 0) document.addEventListener("contextmenu", reaimContextMenu, true);
        return () => {
            if (--watching === 0) {
                document.removeEventListener("contextmenu", reaimContextMenu, true);
            }
        };
    }, []);
}

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

import { useEffect, type RefObject } from "react";

/** The button a right-click reports, which is what a re-aimed one has to say. */
const RIGHT_BUTTON = 2;

/**
 * Re-aim a right-click at whatever is under it, once this menu has closed.
 *
 * Mounted by the menu's content, which exists only while the menu is open, so
 * the watch lasts exactly as long as there is something to dismiss.
 *
 * @param content - The menu surface, so a right-click inside it is left alone.
 */
export function useReopenElsewhere(content: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        // `elementFromPoint` is what aims the second gesture, and it is not
        // everywhere: a server render has no document at all, and a headless DOM
        // may have one without it. Nothing here degrades when it is missing -
        // the menu simply behaves as it did before, closing and leaving the next
        // right-click to open the new one.
        if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
            return;
        }

        const onContextMenu = (event: MouseEvent) => {
            // Inside the menu: its own business. A menu that re-opened itself
            // when somebody right-clicked one of its own options would be a menu
            // that cannot be used with the right button at all.
            const target = event.target;
            if (target instanceof Node && content.current?.contains(target)) return;

            // The browser's own menu must not appear: the press underneath this
            // one has already started closing ours, and two menus arriving from
            // one gesture is worse than none.
            event.preventDefault();

            const x = event.clientX;
            const y = event.clientY;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const under = document.elementFromPoint(x, y);
                    if (!under) return;
                    under.dispatchEvent(
                        new MouseEvent("contextmenu", {
                            bubbles: true,
                            cancelable: true,
                            clientX: x,
                            clientY: y,
                            button: RIGHT_BUTTON,
                            buttons: 0
                        })
                    );
                });
            });
        };

        // Capture, because the layer stops these before they bubble anywhere
        // useful.
        document.addEventListener("contextmenu", onContextMenu, true);
        return () => document.removeEventListener("contextmenu", onContextMenu, true);
    }, [content]);
}

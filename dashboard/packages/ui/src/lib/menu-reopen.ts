"use client";

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

/** The button a right-click reports, which is what a re-aimed one has to say. */
const RIGHT_BUTTON = 2;

/**
 * Every surface that belongs to an open menu, submenus included.
 *
 * The first version of this asked whether the event landed inside the content
 * node it was handed, which is wrong for a menu with a submenu open: Radix
 * renders a submenu into a portal of its own, so a right-click on one of its
 * items is not inside the root content and was being treated as a click on the
 * page behind. The menu then suppressed the native menu, waited two frames and
 * aimed a fresh right-click at the same submenu item - which arrives at a menu
 * that is still open, and does it again.
 *
 * The same selector `menu-press` uses, and for the same reason: it is the mark
 * Radix puts on every menu surface it draws, dropdowns and context menus alike.
 */
const MENU_SURFACE = "[data-radix-menu-content], [data-radix-popper-content-wrapper]";

/**
 * Re-aim a right-click at whatever is under it, once this menu has closed.
 *
 * **Takes the surface itself, not a ref to it, and that is the whole safety of
 * this hook.** A ref never changes identity, so an effect watching one runs on
 * mount and never again - and the component that owns it, `ContextMenuContent`,
 * is in the tree whether or not its menu is open: Radix gates on the open state
 * *inside* `MenuPortal`, below where this is called. Written against a ref, the
 * document listener was installed permanently, once per `<ContextMenuContent>`
 * in the application, and every right-click anywhere - a link, the composer, a
 * misspelt word - was having its native menu suppressed and a synthetic one
 * dispatched two frames later.
 *
 * A node is different: it arrives when Radix mounts the content, which is when
 * the menu opens, and goes back to null when it unmounts. The effect follows it,
 * so the watch lasts exactly as long as there is a menu to dismiss and no longer.
 *
 * @param content - The open menu's surface, or null while there is none.
 */
export function useReopenElsewhere(content: HTMLElement | null): void {
    useEffect(() => {
        // No menu on screen: nothing to dismiss, and nothing of the browser's own
        // to get in the way of.
        if (!content) return;

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
            // that cannot be used with the right button at all - and with a
            // submenu open it would do it forever, since the gesture it aims
            // lands back on the same item.
            //
            // Asked of any menu surface rather than of this content node: a
            // submenu is a portal of its own and is not inside it.
            const target = event.target;
            if (target instanceof Element && target.closest(MENU_SURFACE)) return;
            if (target instanceof Node && content.contains(target)) return;

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

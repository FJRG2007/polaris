"use client";

import { useEffect } from "react";

/**
 * Swallow any drag that lands outside a drop zone.
 *
 * A browser's default for a dropped file is to open it, replacing the page with
 * the file itself - so missing the zone by a few pixels, or dropping on the
 * sidebar, threw away whatever was on screen and showed a PDF instead. There is
 * no arrangement of drop zones that covers a whole window, and the default is
 * never what anyone dragging a file into this app wanted.
 *
 * A zone that has claimed the drag has already called preventDefault on it by the
 * time this runs (React dispatches from the root container, which is inside the
 * window), so `defaultPrevented` tells the two cases apart and this leaves the
 * zone's own drop effect alone. Everywhere else the cursor says the drop will do
 * nothing, and then it does nothing.
 */
export function DropGuard() {
    useEffect(() => {
        function swallow(event: DragEvent) {
            if (event.defaultPrevented) return;
            event.preventDefault();
            if (event.type === "dragover" && event.dataTransfer) {
                event.dataTransfer.dropEffect = "none";
            }
        }
        window.addEventListener("dragover", swallow);
        window.addEventListener("drop", swallow);
        return () => {
            window.removeEventListener("dragover", swallow);
            window.removeEventListener("drop", swallow);
        };
    }, []);
    return null;
}

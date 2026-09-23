"use client";

/**
 * Who is taking the bottom right corner, and how much of it.
 *
 * That corner is shared. The mail composer docks into it, the countdown that
 * replaces the composer after Send sits in it, and the card that reports a file
 * being uploaded is fixed to it too. They were all on the same layer, so
 * attaching a file drew the progress card into the composer - over the
 * attachment strip it was reporting on, and over the Send button - with nothing
 * but the document order deciding which of the two won. Measured in Chrome at
 * the time: 22,152 square pixels of the composer covered on a laptop, the Send
 * button underneath it at every window size.
 *
 * A length rather than a flag, because what is docked there is several different
 * heights and on a phone it is whatever its contents come to. Whoever else wants
 * the corner reads `--docked-panel-height` and sits above it - see
 * `components/transfers/transfers-view`.
 *
 * On `document.body` rather than through a context, because the two sides are
 * not related: the panel that docks does not know the card exists, and the card
 * is mounted once for the whole dashboard.
 */

import { useEffect, type RefObject } from "react";

/** The length both sides of that arrangement name. */
export const DOCKED_HEIGHT = "--docked-panel-height";

export function useDockedCorner(node: RefObject<HTMLElement | null>, docked: boolean): void {
    useEffect(() => {
        const element = node.current;
        if (!element || !docked) {
            document.body.style.removeProperty(DOCKED_HEIGHT);
            return;
        }
        const publish = (): void => {
            document.body.style.setProperty(
                DOCKED_HEIGHT,
                `${Math.round(element.getBoundingClientRect().height)}px`
            );
        };
        publish();
        // It changes size as recipients wrap, as files are attached, and when it
        // is minimized - and a stale height is a card floating in mid air.
        const watch = new ResizeObserver(publish);
        watch.observe(element);
        return () => {
            watch.disconnect();
            document.body.style.removeProperty(DOCKED_HEIGHT);
        };
    }, [node, docked]);
}

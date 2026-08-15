"use client";

/**
 * The nudge that opens a submenu somebody has stopped on.
 *
 * A menu ignores a hover that arrives while the pointer still looks like it is
 * heading for the submenu it just left - the courtesy that lets somebody cut the
 * corner into a submenu without it closing under them. It lasts about 300ms, and
 * only a pointer that MOVES afterwards opens anything. So a hand that runs down
 * the options and stops on one inside that window gets nothing at all, and has
 * to jiggle the mouse to be noticed, which is what makes a quick scan feel
 * broken.
 *
 * This waits out the courtesy and, if the pointer is still sitting on a trigger
 * that has not opened, moves for it. Shared by the right-click menu and the
 * dropdown, because the two have the same submenus and there is no version of
 * this that should be true in one and not the other.
 */

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** How long to wait before a submenu that should have opened is asked again. */
const SETTLED_MS = 350;

export interface SettledHover {
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
}

export function useSettledHover(): SettledHover {
    const settled = useRef<number | undefined>(undefined);

    const cancel = () => {
        if (settled.current !== undefined) window.clearTimeout(settled.current);
        settled.current = undefined;
    };
    useEffect(() => cancel, []);

    return {
        onPointerMove: (event) => {
            if (event.pointerType !== "mouse" || settled.current !== undefined) return;
            const trigger = event.currentTarget;
            const { clientX, clientY } = event;
            // The pointer has arrived. If it is still here once the menu has
            // stopped being courteous and this is still shut, move for it - the
            // jiggle somebody would otherwise have to do themselves.
            settled.current = window.setTimeout(() => {
                settled.current = undefined;
                if (!trigger.isConnected || trigger.dataset.state === "open") return;
                if (!trigger.matches(":hover")) return;
                trigger.dispatchEvent(
                    new PointerEvent("pointermove", {
                        bubbles: true,
                        clientX,
                        clientY,
                        pointerType: "mouse"
                    })
                );
            }, SETTLED_MS);
        },
        onPointerLeave: cancel
    };
}

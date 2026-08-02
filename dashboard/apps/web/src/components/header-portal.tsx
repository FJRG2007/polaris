"use client";

/**
 * Renders into the app-shell header slot, right of the app switcher.
 *
 * A screen whose whole purpose is scoped to one thing - a Deploy project, a
 * firewall scope - puts that chooser here rather than at the top of its own body,
 * so it reads as part of the chrome and stays put while the content below changes.
 *
 * The slot is a plain div the shell renders, so nothing is portalled until after
 * mount. That is the point: it keeps the server render free of any dependency on a
 * DOM node the client owns.
 */

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";

export function HeaderPortal({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setTarget(document.getElementById("polaris-header-slot"));
    }, []);
    return target ? createPortal(children, target) : null;
}

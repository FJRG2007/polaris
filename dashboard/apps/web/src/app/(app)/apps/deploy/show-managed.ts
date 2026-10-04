"use client";

/**
 * Whether the Deploy list shows the projects Polaris runs for itself, as this
 * person last left it.
 *
 * Kept in the browser under the person's own id, the way Tasks keeps how a
 * screen was arranged: it is nobody else's business, and two people sharing a
 * browser each get their own answer. Until it has been chosen, the default
 * decides - hidden for the instance's administrator, shown for everybody else.
 */

import { useCallback, useEffect, useState } from "react";

const PREFIX = "polaris.deploy.showManaged.";

/** What was chosen here, or null when nothing has been. */
export function readShowManaged(viewerId: string): boolean | null {
    try {
        const raw = window.localStorage.getItem(PREFIX + viewerId);
        return raw === "1" ? true : raw === "0" ? false : null;
    } catch {
        return null;
    }
}

export function writeShowManaged(viewerId: string, show: boolean): void {
    try {
        window.localStorage.setItem(PREFIX + viewerId, show ? "1" : "0");
    } catch {
        // A browser that will not keep it still shows the choice for this visit.
    }
}

export function useShowManaged(
    viewerId: string,
    fallback: boolean
): [boolean, (show: boolean) => void] {
    const [show, setShow] = useState(fallback);

    // Read after the first paint rather than during it, so the server's render
    // and the browser's agree; the default is what most people have anyway.
    useEffect(() => {
        const kept = readShowManaged(viewerId);
        if (kept !== null) setShow(kept);
    }, [viewerId]);

    const choose = useCallback(
        (next: boolean) => {
            setShow(next);
            writeShowManaged(viewerId, next);
        },
        [viewerId]
    );

    return [show, choose];
}

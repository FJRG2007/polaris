"use client";

/**
 * A dialog's form starts from scratch every time it opens.
 *
 * `DialogContent` unmounts its children while the dialog is closed, so state
 * kept inside the content is new on every open by construction. State kept by
 * the component that renders the `Dialog` root is not: that component stays
 * mounted while the dialog is closed, and without this a number typed into
 * "Add phone number" and cancelled is still in the box the next time it opens.
 *
 * `reset` puts the form back to where a fresh mount would start it - empty for
 * an add, the record being edited for an edit - and runs at two moments:
 *
 * - While rendering the open that follows a close, so the first frame of the
 *   dialog, and every child seeded from those values, already sees the reset.
 * - Once the dialog has been closed for `DIALOG_WIPE_MS`, after its exit
 *   animation, so a typed password, code or token does not stay in memory
 *   behind a closed dialog.
 *
 * A flow that closes one dialog to show a confirm and then comes back to it
 * (one modal at a time) passes the open state of the whole flow, not of the
 * first dialog, so the step in between keeps what was typed.
 */

import { useEffect, useRef, useState } from "react";

/** How long a closed dialog keeps its values: longer than its exit animation. */
export const DIALOG_WIPE_MS = 400;

export function useResetOnOpen(isOpen: boolean | undefined, reset: () => void): void {
    const open = isOpen === true;
    const [shown, setShown] = useState(open);
    const latest = useRef(reset);
    useEffect(() => {
        latest.current = reset;
    });
    if (open !== shown) {
        setShown(open);
        // Only this component's own setters run here, which React allows during
        // its render: the open frame is rendered again with the reset values
        // before anything is committed.
        if (open) reset();
    }
    useEffect(() => {
        if (open) return;
        const timer = setTimeout(() => latest.current(), DIALOG_WIPE_MS);
        return () => clearTimeout(timer);
    }, [open]);
}

"use client";

/**
 * The runtime log of an installed app's container, polled while something is
 * looking at it. Shared by the app shell's raw log section and by an adapted
 * panel that shows the same output as a console, so a page holding both polls
 * for it the same way and at the same interval.
 */

import { useCallback, useEffect, useState } from "react";

const POLL_MS = 4000;

export function useRuntimeLog(
    applicationId: string | null,
    active: boolean,
    tail = 500
): { log: string; refresh: () => Promise<void> } {
    const [log, setLog] = useState("");

    const refresh = useCallback(async () => {
        if (!applicationId) return;
        try {
            const response = await fetch(`/api/deploy/apps/${applicationId}/logs?tail=${tail}`, { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { log?: string };
            setLog(data.log ?? "");
        } catch {
            // Transient; the next poll retries.
        }
    }, [applicationId, tail]);

    useEffect(() => {
        if (!applicationId || !active) return;
        void refresh();
        // Not while the tab is hidden: nobody is looking, and it reads once on
        // the way back instead.
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
        }, POLL_MS);
        const onReturn = (): void => {
            if (document.visibilityState === "visible") void refresh();
        };
        document.addEventListener("visibilitychange", onReturn);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onReturn);
        };
    }, [applicationId, active, refresh]);

    return { log, refresh };
}

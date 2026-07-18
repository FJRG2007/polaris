"use client";

/**
 * Passive update indicator in the top bar. Polls the cached update endpoint on
 * mount and on a slow interval, and shows a small badge linking to settings only
 * when the running build is behind the release branch. Silent otherwise, and
 * silent on any error - a failed check must never nag.
 */

import { useEffect, useState } from "react";
import { DownloadCloud } from "lucide-react";
import { Badge } from "@polaris/ui";

/** Re-poll every six hours; the server response is cached, so this is cheap. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function UpdateIndicator() {
    const [behindBy, setBehindBy] = useState(0);

    useEffect(() => {
        let active = true;
        async function poll() {
            try {
                const response = await fetch("/api/updates");
                if (!response.ok) return;
                const data = (await response.json()) as { behindBy?: number | null };
                if (active) setBehindBy(typeof data.behindBy === "number" ? data.behindBy : 0);
            } catch {
                // Network hiccup: leave the indicator hidden.
            }
        }
        poll();
        const timer = setInterval(poll, POLL_INTERVAL_MS);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, []);

    if (behindBy <= 0) return null;

    return (
        <a href="/settings" title={`${behindBy} commit(s) behind - open settings`}>
            <Badge variant="primary" className="gap-1">
                <DownloadCloud className="size-3.5" />
                Update
            </Badge>
        </a>
    );
}

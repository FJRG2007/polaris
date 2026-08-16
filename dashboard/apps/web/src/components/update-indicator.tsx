"use client";

/**
 * Passive update indicator in the top bar. Polls the cached update endpoint on
 * mount and on a slow interval, and shows a small badge linking to settings only
 * when there is an update that can actually be installed - a published image, not
 * a commit still being built. Silent otherwise, and silent on any error: a failed
 * check must never nag.
 */

import Link from "next/link";
import { Badge } from "@polaris/ui";
import { useEffect, useState } from "react";
import { DownloadCloud } from "lucide-react";

/** Re-poll every six hours; the server response is cached, so this is cheap. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function UpdateIndicator() {
    const [available, setAvailable] = useState<{ behindBy: number | null } | null>(null);

    useEffect(() => {
        let active = true;
        async function poll() {
            try {
                const response = await fetch("/api/updates");
                if (!response.ok) return;
                const data = (await response.json()) as { phase?: string; behindBy?: number | null };
                if (!active) return;
                setAvailable(
                    data.phase === "available"
                        ? { behindBy: typeof data.behindBy === "number" ? data.behindBy : null }
                        : null
                );
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

    if (!available) return null;

    return (
        <Link
            href="/settings"
            title={
                available.behindBy
                    ? `${available.behindBy} commit(s) behind - open settings`
                    : "A new build is published - open settings"
            }
        >
            <Badge variant="primary" className="gap-1">
                <DownloadCloud className="size-3.5" />
                Update
            </Badge>
        </Link>
    );
}

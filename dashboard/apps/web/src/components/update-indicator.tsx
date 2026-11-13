"use client";

/**
 * Passive update indicator in the top bar. Polls the cached update endpoint on
 * mount and on a slow interval, and shows a small badge linking to settings only
 * when there is an update that can actually be installed - a published image, not
 * a commit still being built. Silent otherwise, and silent on any error: a failed
 * check must never nag.
 */

import Link from "next/link";
import { Badge, pollWhileVisible } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState } from "react";
import { DownloadCloud } from "lucide-react";
import type { UpdateStatus } from "@/lib/update-service";
import * as shared from "@/lib/update-status-shared";

/** Re-poll every six hours; the server response is cached, so this is cheap. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the badge shows for a status: an installable update, or nothing. */
function badgeOf(status: UpdateStatus | null): { behindBy: number | null } | null {
    if (status?.phase !== "available") return null;
    return { behindBy: typeof status.behindBy === "number" ? status.behindBy : null };
}

export function UpdateIndicator() {
    const t = useTranslations("components");
    const [available, setAvailable] = useState(() => badgeOf(shared.latestUpdateStatus()));

    useEffect(() => {
        let active = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        // The Updates screen asks far more often than this; whatever it hears
        // shows here too, so the two never disagree.
        const stopHearing = shared.onUpdateStatus((status) => setAvailable(badgeOf(status)));
        async function poll(again = true) {
            try {
                const response = await fetch("/api/updates");
                if (!response.ok) return;
                const data = (await response.json()) as UpdateStatus;
                if (!active || typeof data.checkedAt !== "string") return;
                shared.noteUpdateStatus(data);
                // An answer the server is refreshing right now: take the fresh one.
                if (again && shared.isStale(data))
                    retry = setTimeout(() => void poll(false), shared.STALE_RETRY_MS);
            } catch {
                // Network hiccup: leave the indicator as it was.
            }
        }
        void poll();
        const stopPolling = pollWhileVisible(() => void poll(), POLL_INTERVAL_MS);
        return () => {
            active = false;
            if (retry) clearTimeout(retry);
            stopHearing();
            stopPolling();
        };
    }, []);

    if (!available) return null;

    return (
        <Link
            href="/admin/updates"
            title={
                available.behindBy
                    ? t("update.behind", { count: available.behindBy })
                    : t("update.published")
            }
        >
            <Badge variant="primary" className="gap-1">
                <DownloadCloud className="size-3.5" />
                {t("update.update")}
            </Badge>
        </Link>
    );
}

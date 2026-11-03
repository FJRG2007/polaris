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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState } from "react";
import { DownloadCloud } from "lucide-react";

/** Re-poll every six hours; the server response is cached, so this is cheap. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function UpdateIndicator() {
    const t = useTranslations("components");
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
        // Not while the tab is hidden: nobody is looking, and it reads once on
        // the way back instead.
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") poll();
        }, POLL_INTERVAL_MS);
        const onReturn = (): void => {
            if (document.visibilityState === "visible") poll();
        };
        document.addEventListener("visibilitychange", onReturn);
        return () => {
            active = false;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onReturn);
        };
    }, []);

    if (!available) return null;

    return (
        <Link
            href="/admin/settings"
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

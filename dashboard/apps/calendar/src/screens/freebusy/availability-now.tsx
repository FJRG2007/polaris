"use client";

/**
 * "Free until 14:00" / "Busy until 11:30" / "Away" for a person's card
 * (Nextcloud's availability on the contact card). Draws nothing for somebody
 * the reader may not look up, so a card never says more than the directory.
 */

import { useCalendarT } from "../i18n";
import { formatTime } from "../public/kit";
import { Skeleton, cn } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import * as freeBusyActions from "../../actions/freebusy";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";

type Answer = { status: "free" | "busy" | "away" | "unavailable"; until: string | null };

export function AvailabilityNow({ userId, zone, className }: { userId: string; zone: string; className?: string }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const read = useCachedRead<Answer>(cacheKey("availability", userId, zone), async () => {
        const answer = await unwrap(() => freeBusyActions.availabilityNowAction({ userId, zone }), t("freeBusy.failed"));
        return { status: answer.status, until: answer.until };
    });
    if (read.loading) return <Skeleton className={cn("h-4 w-28", className)} />;
    const answer = read.data;
    if (!answer || answer.status === "unavailable") return null;
    const until = answer.until ? formatTime(answer.until, zone, locale) : null;
    const text =
        answer.status === "busy"
            ? until
                ? t("freeBusy.busyUntil", { time: until })
                : t("freeBusy.busy")
            : answer.status === "away"
              ? until
                  ? t("freeBusy.awayUntil", { time: until })
                  : t("freeBusy.away")
              : until
                ? t("freeBusy.freeUntil", { time: until })
                : t("freeBusy.freeToday");
    return (
        <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
            <span aria-hidden className={cn("inline-block size-2 rounded-full", answer.status === "free" ? "bg-success" : answer.status === "busy" ? "bg-danger" : "bg-warning")} />
            {text}
        </span>
    );
}

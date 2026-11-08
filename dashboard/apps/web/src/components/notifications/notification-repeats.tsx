"use client";

/**
 * How many times an alert was raised while it was folded into one row.
 *
 * Drawn beside the time, which is already the latest repeat's, so together they
 * read "1 min ago - x12". Nothing for an alert that was raised once. One
 * component because the bell and the history both draw it.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NotificationView } from "@/lib/notification-service";

export function NotificationRepeats({ row }: { row: Pick<NotificationView, "repeatCount"> }) {
    const t = useTranslations("components");
    const count = row.repeatCount ?? 1;
    if (count <= 1) return null;
    const full = t("bell.repeatedTimes", { count });
    return (
        <>
            <span aria-hidden="true">-</span>
            <span className="shrink-0 tabular-nums" title={full} aria-label={full}>
                {t("bell.repeated", { count })}
            </span>
        </>
    );
}

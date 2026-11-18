"use client";

/**
 * "Last seen today at 14:32" - when somebody drawn as offline was last here.
 *
 * The server decides whether there is a time to show at all (`presenceFor`
 * sets `lastActive` only when both sides' setting allows it and the person is
 * not hidden or appearing offline); this only words it, on the reader's own
 * clock and date format.
 */

import { cn } from "@polaris/ui";
import { useNow } from "@/components/presence";
import type { DisplayFormat } from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { usePresence, type PresenceOf } from "@/components/presence-store";

const DAY_MS = 24 * 60 * 60_000;

/** The line, or empty when there is no time to show. Pure, so a row that
 *  already holds the presence and the formatter does not ask again. */
export function lastSeenLine(
    where: PresenceOf | null | undefined,
    t: NamespaceTranslator<"components">,
    format: DisplayFormat,
    now: number = Date.now()
): string {
    if (!where || where.status !== "offline" || !where.lastActive) return "";
    const at = new Date(where.lastActive);
    if (Number.isNaN(at.getTime())) return "";
    // Compared as dates on the reader's own calendar, so "yesterday" turns over
    // at their midnight rather than the server's.
    const day = format.date(at);
    const time = format.time(at);
    if (day === format.date(now)) return t("presence.lastSeen.today", { time });
    if (day === format.date(now - DAY_MS)) return t("presence.lastSeen.yesterday", { time });
    return t("presence.lastSeen.date", { date: day });
}

/** `lastSeenLine` for one person, from the store the face already asked. */
export function useLastSeen(personId: string | null | undefined): string {
    const where = usePresence(personId);
    const t = useTranslations("components");
    const format = useDisplayFormat();
    const now = useNow(60_000);
    return lastSeenLine(where, t, format, now);
}

/** The line as text, or nothing at all when there is no time to show. */
export function LastSeen({
    personId,
    className
}: {
    personId: string | null | undefined;
    className?: string;
}) {
    const line = useLastSeen(personId);
    if (!line) return null;
    return (
        <span className={cn("min-w-0 truncate text-xs text-muted-foreground", className)} title={line}>
            {line}
        </span>
    );
}

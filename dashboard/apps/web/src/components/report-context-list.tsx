"use client";

/**
 * The recent messages a report of a conversation or a person carried, as the
 * moderation queue draws them. Quoted as plain text, never rendered: a report is
 * not a place to run somebody else's formatting.
 */

import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ReportContextEntry } from "@/lib/chat/report-context";

export function ReportContextList({ entries }: { entries: readonly ReportContextEntry[] }) {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    if (entries.length === 0) return null;
    return (
        <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">
                {t("reports.recentMessages", { count: entries.length })}
            </p>
            <ol className="flex flex-col gap-1.5">
                {entries.map((entry, at) => (
                    <li key={`${entry.sentAt}-${at}`} className="min-w-0">
                        <p className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                            <span className="min-w-0 truncate font-medium" title={entry.authorName}>
                                {entry.authorName || t("reports.unknownAuthor")}
                            </span>
                            <span className="shrink-0">{format.dateTime(entry.sentAt)}</span>
                        </p>
                        <blockquote className="whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-sm">
                            {entry.excerpt}
                        </blockquote>
                    </li>
                ))}
            </ol>
        </div>
    );
}

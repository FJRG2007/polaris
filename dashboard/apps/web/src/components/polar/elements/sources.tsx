"use client";

/**
 * The sites an answer was built from, numbered the way the answer cites them,
 * with how many searches and page reads it took.
 */

import { Globe } from "lucide-react";
import type { WebSource } from "@/lib/polar/web-sources";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function WebSources({
    sources,
    calls
}: {
    sources: readonly WebSource[];
    calls: { searches: number; pages: number };
}) {
    const t = useTranslations("polar");
    return (
        <section className="min-w-0 space-y-1.5" aria-label={t("web.sources")}>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="font-medium text-foreground">{t("web.sources")}</span>
                {calls.searches + calls.pages > 0 ? (
                    <span className="min-w-0 truncate">{t("web.calls", calls)}</span>
                ) : null}
            </p>
            <ol className="flex min-w-0 flex-wrap gap-1.5">
                {sources.map((source, index) => (
                    <li key={source.url} className="min-w-0 max-w-full">
                        <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            title={`${source.title} - ${source.url}`}
                            className="flex min-w-0 max-w-64 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground"
                        >
                            <span className="shrink-0 font-medium tabular-nums text-foreground">
                                {index + 1}
                            </span>
                            <span className="min-w-0 truncate" title={source.title}>
                                {source.title}
                            </span>
                            <span className="shrink-0 text-muted-foreground">{source.host}</span>
                        </a>
                    </li>
                ))}
            </ol>
        </section>
    );
}

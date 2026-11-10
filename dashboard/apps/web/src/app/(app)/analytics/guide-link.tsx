"use client";

import { ExternalLink } from "lucide-react";
import { publicDocHref } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

/** The developer guide for the tracker, in the reader's language. */
export function AnalyticsGuideLink() {
    const t = useTranslations("analytics");
    const locale = useLocale();
    return (
        <a
            href={publicDocHref(locale, "analytics")}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        >
            {t("tracker.guide")}
            <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
    );
}

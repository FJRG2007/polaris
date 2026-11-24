"use client";

/**
 * The way out when an antivirus stops the desktop app: the public guide on
 * what to exclude, in the reader's language. The desktop app links the same
 * page from its own notice (`clients/desktop/src/main/antivirus-help.ts`).
 */

import { ShieldAlert } from "lucide-react";
import { publicDocHref } from "../../lib/public-docs";
import { useLocale, useTranslations } from "../../i18n";

/** The guide's slug on the public docs site: `docs/features/antivirus.md`. */
export const ANTIVIRUS_GUIDE = "antivirus";

export function AntivirusHelpLink() {
    const t = useTranslations("account");
    const locale = useLocale();
    return (
        <a
            href={publicDocHref(locale, ANTIVIRUS_GUIDE)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
            <ShieldAlert className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{t("downloads.desktop.antivirus")}</span>
        </a>
    );
}

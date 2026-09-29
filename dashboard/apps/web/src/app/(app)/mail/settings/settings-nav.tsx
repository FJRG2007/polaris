"use client";

/** The settings sub-rail. Horizontal, because there are several of them and a
 *  vertical rail beside a vertical rail is a maze. */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Each screen's name is `mailSettings.nav.<screen>`, the last part of its path. */
const SCREENS = [
    // First, because it is the only one about the person rather than about one
    // of their mailboxes - and the only one worth opening before there is a
    // mailbox at all.
    "general",
    "shortcuts",
    "accounts",
    "identities",
    "labels",
    "rules",
    "signature",
    "templates",
    "privacy",
    "junk",
    "blocked",
    "away",
    "archive"
] as const;

export function SettingsNav() {
    const pathname = usePathname();
    const t = useTranslations("mailSettings");
    return (
        <nav
            className="flex flex-wrap gap-1 border-b border-border pb-2"
            aria-label={t("layout.title")}
        >
            {SCREENS.map((screen) => {
                const href = `/mail/settings/${screen}`;
                return (
                    <Link
                        key={href}
                        href={href}
                        aria-current={pathname === href ? "page" : undefined}
                        className={cn(
                            "rounded-md px-2.5 py-1 text-[13px]",
                            pathname === href
                                ? "bg-card font-medium text-foreground"
                                : "text-muted-foreground hover:bg-card hover:text-foreground"
                        )}
                    >
                        {t(`nav.${screen}`)}
                    </Link>
                );
            })}
        </nav>
    );
}

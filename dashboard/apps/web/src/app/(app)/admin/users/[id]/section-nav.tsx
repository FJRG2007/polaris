"use client";

/**
 * The sections of one person's record, as links.
 *
 * Each is its own route so a section reads only what it shows, can be linked to,
 * and a new one slots in here instead of growing a single page.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Each section's name is `usersDetail.nav.<section>`; "" is the overview. */
const SECTIONS = ["", "security", "sessions", "access", "danger"] as const;

export function UserSectionNav({ userId }: { userId: string }) {
    const pathname = usePathname();
    const t = useTranslations("admin");
    return (
        <nav
            className="mb-4 flex flex-wrap gap-1 border-b border-border pb-2"
            aria-label={t("usersDetail.nav.label")}
        >
            {SECTIONS.map((section) => {
                const href = section
                    ? `/admin/users/${userId}/${section}`
                    : `/admin/users/${userId}`;
                const current = pathname === href;
                return (
                    <Link
                        key={href}
                        href={href}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                            "whitespace-nowrap rounded-md px-2.5 py-1 text-[13px]",
                            current
                                ? "bg-card font-medium text-foreground"
                                : "text-muted-foreground hover:bg-card hover:text-foreground"
                        )}
                    >
                        {t(`usersDetail.nav.${section || "overview"}`)}
                    </Link>
                );
            })}
        </nav>
    );
}

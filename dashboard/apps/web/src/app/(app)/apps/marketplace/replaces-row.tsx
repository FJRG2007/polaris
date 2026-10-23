"use client";

/**
 * The products an app replaces, as a row of their logos - the README's tiles,
 * each named in its tooltip. The store page has the room to name each one
 * beside its logo too; a built-in row only has room for the logos.
 */

import { cn } from "@polaris/ui";
import { ReplacedLogos } from "@polaris/ui/built-in-apps";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { replacedLogos } from "@/lib/apps/replaces";

export function ReplacesRow({
    appId,
    compact = false,
    className
}: {
    appId: string;
    /** Logos only, smaller: for a row with no room for the names. */
    compact?: boolean;
    className?: string;
}) {
    const t = useTranslations("marketplace");
    const items = replacedLogos(appId);
    if (items.length === 0) return null;
    const list = <ReplacedLogos items={items} label={t("detail.replaces")} compact={compact} />;
    if (compact) return <div className={cn("min-w-0", className)}>{list}</div>;
    return (
        <section className={cn("flex min-w-0 flex-col gap-2", className)}>
            <h2 className="text-sm font-medium">{t("detail.replaces")}</h2>
            {list}
        </section>
    );
}

"use client";

/**
 * The products an app replaces, as a row of their logos - the README's tiles,
 * each named in its tooltip. The store page has the room to name each one
 * beside its logo too; a built-in row only has room for the logos.
 */

import { cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { appReplaces, replacedLogoSrc } from "@/lib/apps/replaces";

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
    const items = appReplaces(appId);
    if (items.length === 0) return null;
    const size = compact ? 20 : 28;
    const list = (
        <ul
            aria-label={t("detail.replaces")}
            className={cn(
                "flex min-w-0 flex-wrap items-center",
                compact ? "gap-1" : "gap-x-4 gap-y-2"
            )}
        >
            {items.map((item) => (
                <li
                    key={item.name}
                    data-replaces={item.logo}
                    title={item.name}
                    className="flex min-w-0 items-center gap-1.5"
                >
                    <img
                        src={replacedLogoSrc(item)}
                        alt={item.name}
                        width={size}
                        height={size}
                        className="shrink-0"
                        style={{ width: size, height: size }}
                    />
                    {compact ? null : (
                        <span aria-hidden="true" className="text-muted-foreground truncate text-sm">
                            {item.name}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
    if (compact) return <div className={cn("min-w-0", className)}>{list}</div>;
    return (
        <section className={cn("flex min-w-0 flex-col gap-2", className)}>
            <h2 className="text-sm font-medium">{t("detail.replaces")}</h2>
            {list}
        </section>
    );
}

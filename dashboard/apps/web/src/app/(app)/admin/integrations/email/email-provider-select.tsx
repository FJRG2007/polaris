"use client";

/**
 * Picking the service an email sender goes out through.
 *
 * A short, fixed list, so it is handed over whole and filtered in the browser:
 * the match runs over the name and the words people use instead of it. The
 * shared searchable select, so the menu is portalled above the dialog, flips to
 * stay on screen and takes the arrow keys.
 */

import { memo, useMemo } from "react";
import { IntegrationLogo } from "@/components/logos";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SearchableSelect, type SearchableSelectOption } from "@polaris/ui";

/** One service in the list. */
export interface EmailProviderOption {
    readonly slug: string;
    readonly name: string;
    readonly aliases: readonly string[];
}

export const EmailProviderSelect = memo(function EmailProviderSelect({
    options,
    value,
    onChange,
    disabled
}: {
    options: readonly EmailProviderOption[];
    value: string;
    onChange: (slug: string) => void;
    disabled?: boolean;
}) {
    const t = useTranslations("components");

    const items = useMemo<SearchableSelectOption[]>(
        () =>
            options.map((option) => ({
                value: option.slug,
                // Not a plain string, so the search reads `keywords` for the name.
                label: (
                    <span className="min-w-0 truncate" title={option.name}>
                        {option.name}
                    </span>
                ),
                icon: <IntegrationLogo slug={option.slug} className="size-4 shrink-0" />,
                keywords: [option.name, ...option.aliases].join(" ")
            })),
        [options]
    );

    return (
        <SearchableSelect
            value={value}
            onValueChange={onChange}
            options={items}
            disabled={disabled}
            placeholder={t("providerSelect.pick")}
            searchPlaceholder={t("providerSelect.search")}
            emptyText={t("providerSelect.none")}
            aria-label={t("providerSelect.pick")}
            className="h-9"
        />
    );
});

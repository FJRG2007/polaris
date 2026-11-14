"use client";

/**
 * Picking the provider a key belongs to.
 *
 * There are sixty, and somebody arrives knowing the word ("groq", "kimi",
 * "gemini") rather than where it sits, so it filters. The match runs over the
 * name, the slug and the words people use instead of either, which is how
 * "gemini" finds Google AI and "kimi" finds Moonshot. "free" and "trial" match
 * too, and are the reason the badge is on the row: at sixty providers the
 * question is "which of these can I start on today".
 *
 * The shared searchable select, so the menu is portalled above the dialog,
 * flips to stay on screen and takes the arrow keys. Only the first rows are
 * drawn - opening it used to draw every provider with its logo in one go, which
 * is what made the Add dialog stall - and the rest are found by typing. The
 * options are built once per catalogue, and the component is memoised, so
 * typing in the rest of the form does not redraw it.
 */

import { memo, useMemo } from "react";
import { Badge, SearchableSelect, type SearchableSelectOption } from "@polaris/ui";
import { IntegrationLogo } from "@/components/logos";
import type { ProviderRow } from "@/lib/agents/model-key-providers";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Only what the list itself needs of a provider. */
type ProviderOption = Pick<ProviderRow, "slug" | "name" | "aliases" | "freeTier">;

/** The free-tier badge's words, as `providerSelect.free.<kind>`. */
const FREE_KEYS = { free: "providerSelect.free.free", trial: "providerSelect.free.trial" } as const;

/** Rows drawn at once. Enough to see the shape of the list; the rest are typed. */
const SHOWN = 24;

export const ProviderSelect = memo(function ProviderSelect({
    options,
    value,
    onChange,
    disabled
}: {
    options: ProviderOption[];
    value: string;
    onChange: (slug: string) => void;
    disabled?: boolean;
}) {
    const t = useTranslations("components");

    const items = useMemo<SearchableSelectOption[]>(
        () =>
            options.map((option) => {
                const free = option.freeTier ? t(FREE_KEYS[option.freeTier.kind]) : null;
                return {
                    value: option.slug,
                    // Not a plain string, so the search reads `keywords` for the name.
                    label: (
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate" title={option.name}>
                                {option.name}
                            </span>
                            {option.freeTier && free ? (
                                <Badge
                                    variant={option.freeTier.kind === "free" ? "success" : "neutral"}
                                    title={option.freeTier.note}
                                    className="shrink-0"
                                >
                                    {free}
                                </Badge>
                            ) : null}
                        </span>
                    ),
                    icon: <IntegrationLogo slug={option.slug} className="size-4 shrink-0" />,
                    keywords: [
                        option.name,
                        ...option.aliases,
                        ...(option.freeTier && free ? [free, option.freeTier.kind] : [])
                    ].join(" ")
                };
            }),
        [options, t]
    );

    return (
        <SearchableSelect
            value={value}
            onValueChange={onChange}
            options={items}
            disabled={disabled}
            limit={SHOWN}
            moreText={(hidden) => t("providerSelect.more", { count: hidden })}
            placeholder={t("providerSelect.pick")}
            searchPlaceholder={t("providerSelect.search")}
            emptyText={t("providerSelect.none")}
            aria-label={t("providerSelect.pick")}
            className="h-9"
        />
    );
});

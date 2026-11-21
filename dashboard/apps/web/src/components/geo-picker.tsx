"use client";

/**
 * Country/continent allowlist picker for shares and drop points. Continents are a
 * short chip row; countries are added from a searchable list and shown as
 * removable chips with their flags. Both are the shared value pickers the rule
 * builders use. Controlled: the parent owns the selected code arrays.
 */

import { CONTINENTS } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { ChoiceChips, CountryPicker } from "@/components/rules/value-pickers";

export { regionName } from "@/components/rules/value-pickers";

export function GeoPicker({
    countries,
    continents,
    onCountries,
    onContinents
}: {
    countries: string[];
    continents: string[];
    onCountries: (next: string[]) => void;
    onContinents: (next: string[]) => void;
}) {
    const t = useTranslations("components");
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("geo.continents")}</span>
                <ChoiceChips
                    label={t("geo.continents")}
                    options={CONTINENTS.map((continent) => ({
                        value: continent.code,
                        label: t(`geo.continentNames.${continent.code}` as NamespaceKey<"components">)
                    }))}
                    selected={continents}
                    onChange={onContinents}
                />
            </div>

            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("geo.countries")}</span>
                <CountryPicker selected={countries} onChange={onCountries} />
            </div>
            <span className="text-xs text-muted-foreground">{t("geo.hint")}</span>
        </div>
    );
}

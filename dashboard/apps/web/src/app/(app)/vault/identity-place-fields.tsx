"use client";

/**
 * The country and region boxes of an identity, as lists to type down rather
 * than text to spell. See `identity-places.ts` for what is stored.
 */

import { COUNTRY_CODES } from "@polaris/core";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { Input, SearchableSelect, type SearchableSelectOption } from "@polaris/ui";
import { countryCodeOf, countryLabel, regionsOf, type Region } from "./identity-places";

/** Every country, named in the reader's language and found by its English name
 *  and code as well. A stored value that names no country stays, as typed. */
export function CountryField({
    value,
    onChange,
    label
}: {
    value: string;
    onChange: (code: string) => void;
    /** What the box is called to a screen reader, where it is not the address's country. */
    label?: string;
}) {
    const t = useTranslations("vault");
    const locale = useLocale();
    const code = useMemo(() => countryCodeOf(value, [locale]), [value, locale]);
    const options = useMemo(() => {
        const list: SearchableSelectOption[] = COUNTRY_CODES.map((one) => ({
            value: one,
            label: countryLabel(one, locale),
            keywords: `${one} ${countryLabel(one, "en")}`
        })).sort((a, b) => String(a.label).localeCompare(String(b.label), locale));
        if (value.trim() !== "" && !code) list.unshift({ value, label: value });
        return list;
    }, [locale, value, code]);
    return (
        <SearchableSelect
            value={code ?? value}
            onValueChange={onChange}
            options={options}
            searchPlaceholder={t("identity.searchCountry")}
            emptyText={t("identity.noCountry")}
            placeholder={t("identity.pickCountry")}
            aria-label={label ?? t("identity.fields.country")}
        />
    );
}

/**
 * The regions of the chosen country, when the list has them; a plain box when
 * it does not, or before a country is chosen. A region the list lacks can still
 * be typed and kept.
 */
export function RegionField({
    value,
    country,
    onChange
}: {
    value: string;
    country: string;
    onChange: (region: string) => void;
}) {
    const t = useTranslations("vault");
    const locale = useLocale();
    const code = useMemo(() => countryCodeOf(country, [locale]), [country, locale]);
    const [regions, setRegions] = useState<{ country: string; list: Region[] } | null>(null);

    useEffect(() => {
        if (!code) return;
        let live = true;
        void regionsOf(code)
            .then((list) => {
                if (live) setRegions({ country: code, list });
            })
            .catch(() => {
                if (live) setRegions({ country: code, list: [] });
            });
        return () => {
            live = false;
        };
    }, [code]);

    const list = regions && regions.country === code ? regions.list : [];
    const options = useMemo(() => {
        const made: SearchableSelectOption[] = list.map((region) => ({
            value: region.name,
            label: region.name,
            keywords: region.code
        }));
        if (value.trim() !== "" && !list.some((region) => region.name === value)) {
            made.unshift({ value, label: value });
        }
        return made;
    }, [list, value]);

    if (!code || list.length === 0) {
        return (
            <Input
                value={value}
                onChange={(event) => onChange(event.target.value)}
                aria-label={t("identity.fields.state")}
                autoComplete="off"
            />
        );
    }
    return (
        <SearchableSelect
            value={value}
            onValueChange={onChange}
            options={options}
            searchPlaceholder={t("identity.searchRegion")}
            emptyText={t("identity.noRegion")}
            typedText={(typed) => t("identity.useTyped", { typed })}
            placeholder={t("identity.pickRegion")}
            aria-label={t("identity.fields.state")}
        />
    );
}

"use client";

/**
 * The street of an identity in its parts: the type, the name, the number, the
 * floor and the door. Stored as custom fields with agreed names
 * (`ADDRESS_FIELDS`); the street line other clients read is composed from them
 * on save, in the order the address's country writes it.
 */

import { useMemo } from "react";
import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Input, SearchableSelect, type SearchableSelectOption } from "@polaris/ui";

export function IdentityStreetFields({
    value,
    country,
    onChange
}: {
    value: core.AddressParts;
    /** The address's country as a two-letter code, which picks the types offered. */
    country: string;
    onChange: (next: core.AddressParts) => void;
}) {
    const t = useTranslations("vault");
    const set = (key: core.AddressKey, next: string) => onChange({ ...value, [key]: next });
    // The types are words of the address's own language, not of the screen.
    const options = useMemo(() => {
        const list: SearchableSelectOption[] = core.streetTypesFor(country).map((one) => ({ value: one, label: one }));
        if (value.streetType.trim() !== "" && !list.some((one) => one.value === value.streetType)) {
            list.unshift({ value: value.streetType, label: value.streetType });
        }
        return list;
    }, [country, value.streetType]);
    return (
        <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-6">
            <div className="flex min-w-0 flex-col gap-1 text-sm min-[400px]:col-span-2">
                {t("identity.street.type")}
                <SearchableSelect
                    value={value.streetType}
                    onValueChange={(next) => set("streetType", next)}
                    options={options}
                    searchPlaceholder={t("identity.street.searchType")}
                    emptyText={t("identity.street.noType")}
                    typedText={(typed) => t("identity.useTyped", { typed })}
                    placeholder={t("identity.street.pickType")}
                    aria-label={t("identity.street.type")}
                />
            </div>
            <label className="flex min-w-0 flex-col gap-1 text-sm min-[400px]:col-span-4">
                {t("identity.street.name")}
                <Input
                    value={value.streetName}
                    onChange={(event) => set("streetName", event.target.value)}
                    autoComplete="off"
                    maxLength={200}
                />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm min-[400px]:col-span-2">
                {t("identity.street.number")}
                <Input
                    value={value.houseNumber}
                    onChange={(event) => set("houseNumber", event.target.value)}
                    autoComplete="off"
                    maxLength={20}
                />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm min-[400px]:col-span-2">
                {t("identity.street.floor")}
                <Input
                    value={value.floor}
                    onChange={(event) => set("floor", event.target.value)}
                    autoComplete="off"
                    maxLength={20}
                />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm min-[400px]:col-span-2">
                {t("identity.street.door")}
                <Input
                    value={value.door}
                    onChange={(event) => set("door", event.target.value)}
                    autoComplete="off"
                    maxLength={20}
                />
            </label>
        </div>
    );
}

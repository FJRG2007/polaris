"use client";

/**
 * The personal details of an identity: an identity document, the date and
 * country of birth, the nationality and the marital status. Stored as custom
 * fields with agreed names (`PERSON_FIELDS`), drawn here as boxes of their own.
 */

import * as core from "@polaris/core";
import { Input, Select } from "@polaris/ui";
import { CountryField } from "./identity-place-fields";
import { useTranslations } from "@/components/i18n/i18n-provider";

const NO_STATUS = "__none__";

export function IdentityPersonFields({
    value,
    onChange
}: {
    value: core.PersonValues;
    onChange: (next: core.PersonValues) => void;
}) {
    const t = useTranslations("vault");
    const set = (key: core.PersonKey, next: string) => onChange({ ...value, [key]: next });
    return (
        <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-muted-foreground">{t("identity.groups.person")}</legend>
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("identity.person.nationalId")}
                    <Input
                        value={value.nationalId}
                        onChange={(event) => set("nationalId", event.target.value)}
                        placeholder={t("identity.person.nationalIdHint")}
                        autoComplete="off"
                        maxLength={40}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("identity.person.birthDate")}
                    <Input
                        type="date"
                        value={value.birthDate}
                        max={new Date().toISOString().slice(0, 10)}
                        onChange={(event) => set("birthDate", event.target.value)}
                        autoComplete="off"
                    />
                </label>
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("identity.person.birthCountry")}
                    <CountryField
                        value={value.birthCountry}
                        onChange={(code) => set("birthCountry", code)}
                        label={t("identity.person.birthCountry")}
                    />
                </div>
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("identity.person.nationality")}
                    <CountryField
                        value={value.nationality}
                        onChange={(code) => set("nationality", code)}
                        label={t("identity.person.nationality")}
                    />
                </div>
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("identity.person.maritalStatus")}
                    <Select
                        value={value.maritalStatus || NO_STATUS}
                        onValueChange={(next) => set("maritalStatus", next === NO_STATUS ? "" : next)}
                        options={[
                            { value: NO_STATUS, label: t("identity.person.statusNone") },
                            ...core.MARITAL_STATUSES.map((status) => ({
                                value: status,
                                label: t(`identity.person.statuses.${status}`)
                            }))
                        ]}
                        aria-label={t("identity.person.maritalStatus")}
                    />
                </div>
            </div>
        </fieldset>
    );
}

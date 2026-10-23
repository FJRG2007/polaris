"use client";

/**
 * The one "Advanced" section of every share-by-link dialog in Polaris: a
 * password, an expiry, a cap on uses, and who may open it by address and by
 * region. Drive, snippets, notes, documents and Places all draw this same
 * section so a link offers the same limits, in the same words and order,
 * wherever it is made. A surface leaves out only what does not apply to it (a
 * Places link has its own dates and uses, so it shows the address rules alone).
 *
 * Controlled: the parent owns the value. What is shown here is only what will
 * be saved; the public route enforces it (`lib/link-guards` `checkLink`).
 */

import { Lock } from "lucide-react";
import { Input } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AccessRulesEditor, type AccessRulesValue } from "@/components/access-rules-editor";

/** The parts a surface can leave out. */
export type LinkAdvancedPart = "password" | "expiry" | "uses";

export interface LinkAdvancedValue {
    password: string;
    /** A `yyyy-mm-dd` day, or empty for no expiry. */
    expiresAt: string;
    /** A positive whole number as typed, or empty for no cap. */
    maxUses: string;
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
}

export const EMPTY_LINK_ADVANCED: LinkAdvancedValue = {
    password: "",
    expiresAt: "",
    maxUses: "",
    allowedCidrs: [],
    allowedCountries: [],
    allowedContinents: []
};

/** The address rules of a value, as a link's schema takes them. */
export function linkAddressRules(value: LinkAdvancedValue): {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
} {
    return {
        allowedCidrs: value.allowedCidrs,
        allowedCountries: value.allowedCountries,
        allowedContinents: value.allowedContinents
    };
}

/** How many limits a value sets, for the section's summary. */
export function linkAdvancedCount(value: LinkAdvancedValue): number {
    return [
        value.password,
        value.expiresAt,
        value.maxUses,
        value.allowedCidrs.length > 0,
        value.allowedCountries.length + value.allowedContinents.length > 0
    ].filter(Boolean).length;
}

export function LinkAdvancedFields({
    value,
    onChange,
    omit = [],
    usesLabel,
    passwordSet = false,
    idPrefix = "link"
}: {
    value: LinkAdvancedValue;
    onChange: (next: LinkAdvancedValue) => void;
    omit?: readonly LinkAdvancedPart[];
    /** What one use is called here: a download, an open, a view. */
    usesLabel?: string;
    /** The link already has a password; typing one replaces it. */
    passwordSet?: boolean;
    idPrefix?: string;
}) {
    const t = useTranslations("components");
    const shows = (part: LinkAdvancedPart) => !omit.includes(part);
    const rules: AccessRulesValue = { groupIds: [], ...linkAddressRules(value) };
    const count = linkAdvancedCount(value);

    return (
        <details className="group rounded-md border border-border" open={count > 0}>
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{t("linkAdvanced.title")}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                    {count > 0 ? t("linkAdvanced.set", { count }) : t("linkAdvanced.none")}
                </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-border p-3">
                {shows("password") || shows("expiry") || shows("uses") ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {shows("password") ? (
                            <label className="flex min-w-0 flex-col gap-1" htmlFor={`${idPrefix}-password`}>
                                <span className="text-xs text-muted-foreground">
                                    <Lock className="mr-1 inline size-3" aria-hidden />
                                    {passwordSet
                                        ? t("linkAdvanced.replacePassword")
                                        : t("linkAdvanced.password")}
                                </span>
                                {/* enigma:allow-no-breach-check enigma:allow-identity-password -
                                    a link's own passphrase, not a credential: it authenticates
                                    nobody and guesses at it are limited per link per address. */}
                                <Input
                                    id={`${idPrefix}-password`}
                                    type="password"
                                    value={value.password}
                                    placeholder={
                                        passwordSet
                                            ? t("linkAdvanced.passwordSet")
                                            : t("linkAdvanced.passwordNone")
                                    }
                                    autoComplete="new-password"
                                    onChange={(event) =>
                                        onChange({ ...value, password: event.target.value })
                                    }
                                />
                            </label>
                        ) : null}
                        {shows("expiry") ? (
                            <label className="flex min-w-0 flex-col gap-1" htmlFor={`${idPrefix}-expires`}>
                                <span className="text-xs text-muted-foreground">
                                    {t("linkAdvanced.expires")}
                                </span>
                                <Input
                                    id={`${idPrefix}-expires`}
                                    type="date"
                                    value={value.expiresAt}
                                    onChange={(event) =>
                                        onChange({ ...value, expiresAt: event.target.value })
                                    }
                                />
                            </label>
                        ) : null}
                        {shows("uses") ? (
                            <label className="flex min-w-0 flex-col gap-1" htmlFor={`${idPrefix}-uses`}>
                                <span className="text-xs text-muted-foreground">
                                    {usesLabel ?? t("linkAdvanced.uses")}
                                </span>
                                <Input
                                    id={`${idPrefix}-uses`}
                                    type="number"
                                    min={1}
                                    step={1}
                                    inputMode="numeric"
                                    value={value.maxUses}
                                    placeholder={t("linkAdvanced.noLimit")}
                                    onChange={(event) =>
                                        onChange({ ...value, maxUses: event.target.value })
                                    }
                                />
                            </label>
                        ) : null}
                    </div>
                ) : null}
                <AccessRulesEditor
                    value={rules}
                    groups={[]}
                    showGroups={false}
                    onChange={(next) =>
                        onChange({
                            ...value,
                            allowedCidrs: next.allowedCidrs,
                            allowedCountries: next.allowedCountries,
                            allowedContinents: next.allowedContinents
                        })
                    }
                />
                <p className="text-xs text-muted-foreground">{t("linkAdvanced.hint")}</p>
            </div>
        </details>
    );
}

"use client";

/**
 * The language this account reads Polaris in.
 *
 * Saved the moment it is picked, with no button: the whole page redraws in the
 * new language as the answer, which is a clearer "saved" than any message. The
 * picker moves at once and moves back, with the reason, if the save is refused.
 * Every other tab the account has open follows on its own (`LocaleWatcher`).
 *
 * Each language is listed in itself, so somebody who picked the wrong one by
 * mistake can still find their own.
 */

import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Card, CardBody, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { isLocale, LOCALE_INFO, LOCALES, type Locale } from "@polaris/core";

const OPTIONS = LOCALES.map((locale) => ({ value: locale, label: LOCALE_INFO[locale].name }));

export function LanguageCard({
    current,
    save
}: {
    /** The language the page was drawn in. */
    current: Locale;
    save: (locale: Locale) => Promise<{ error?: string }>;
}) {
    const t = useTranslations("account");
    const [chosen, setChosen] = useState<Locale>(current);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    // A change made in another tab arrives as a redraw with a new `current`.
    useEffect(() => setChosen(current), [current]);

    async function pick(value: string) {
        if (!isLocale(value) || value === chosen) return;
        const previous = chosen;
        setChosen(value);
        setError("");
        setSaving(true);
        const result = await runAction(() => save(value), setError);
        setSaving(false);
        if (result && !result.error) return;
        setChosen(previous);
        if (result?.error) setError(result.error);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("language.title")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("language.hint")}</p>
                    {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
                </div>
                <Select
                    value={chosen}
                    onValueChange={(value) => void pick(value)}
                    options={OPTIONS}
                    disabled={saving}
                    aria-label={t("language.title")}
                    className="sm:w-56"
                />
            </CardBody>
        </Card>
    );
}

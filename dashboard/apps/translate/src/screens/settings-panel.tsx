"use client";

/**
 * Translate's settings for this whole Polaris: which engines may answer, and
 * the language a new translation goes into. An administrator's page, reached
 * from the app's menu under Polaris apps like every other app's settings.
 * Save waits for a change; the keys themselves are on the Integrations screen,
 * which the page links to.
 */

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { useLanguageOptions } from "./language-options";
import { unwrap, useTranslateLocale, useTranslateT } from "./i18n";
import { saveSettingsAction, settingsAction } from "../actions/translate";
import { ENGINE_IDS, type EngineId, type TranslateSettings } from "../model/schemas";
import { Button, Card, SearchableSelect, Skeleton, Switch, isDirty, useToast } from "@polaris/ui";

const NAME = {
    browser: "engine.browser",
    polar: "engine.polar",
    deepl: "engine.deepl",
    google: "engine.google"
} as const;

const HINT = {
    browser: "settings.browserHint",
    polar: "settings.polarHint",
    deepl: "settings.deeplHint",
    google: "settings.googleHint"
} as const;

export function SettingsPanel() {
    const t = useTranslateT();
    const toast = useToast();
    const ids = useId();
    const languages = useLanguageOptions(useTranslateLocale());
    const [loaded, setLoaded] = useState<TranslateSettings | null>(null);
    const [draft, setDraft] = useState<TranslateSettings | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const load = () => {
        setFailed(null);
        void unwrap(() => settingsAction(), t("errors.generic"))
            .then((answer) => {
                setLoaded(answer.settings);
                setDraft(answer.settings);
            })
            .catch((caught: Error) => setFailed(caught.message));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, on arrival
    useEffect(load, []);

    const changed = loaded !== null && draft !== null && isDirty(loaded, draft);

    const save = async () => {
        if (!draft || !changed) return;
        setSaving(true);
        try {
            const answer = await unwrap(() => saveSettingsAction(draft), t("errors.saveFailed"));
            setLoaded(answer.settings);
            setDraft(answer.settings);
            toast.show({ title: t("settings.saved") });
        } catch (caught) {
            toast.show({ title: t("errors.saveFailed"), body: (caught as Error).message });
        } finally {
            setSaving(false);
        }
    };

    const toggle = (id: EngineId, on: boolean) =>
        setDraft((current) =>
            current ? { ...current, engines: { ...current.engines, [id]: on } } : current
        );

    if (failed !== null)
        return (
            <Card className="flex min-w-0 flex-col items-start gap-3 p-4">
                <p className="text-sm">{failed}</p>
                <Button variant="outline" size="sm" onClick={load}>
                    {t("settings.retry")}
                </Button>
            </Card>
        );

    return (
        <Card className="flex min-w-0 flex-col gap-5 p-4">
            {draft === null ? (
                <div className="space-y-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : (
                <>
                    <fieldset className="space-y-3">
                        <legend className="mb-2 text-sm font-medium">
                            {t("settings.engines")}
                        </legend>
                        {ENGINE_IDS.map((id) => (
                            <div
                                key={id}
                                className="flex min-w-0 items-start justify-between gap-3"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm">{t(NAME[id])}</p>
                                    <p
                                        id={`${ids}-${id}`}
                                        className="text-xs text-muted-foreground"
                                    >
                                        {t(HINT[id])}
                                    </p>
                                </div>
                                <Switch
                                    checked={draft.engines[id]}
                                    onChange={(on) => toggle(id, on)}
                                    aria-label={t(NAME[id])}
                                    aria-describedby={`${ids}-${id}`}
                                />
                            </div>
                        ))}
                        <Link
                            href="/admin/integrations"
                            className="inline-block text-xs text-primary underline-offset-2 hover:underline"
                        >
                            {t("settings.keys")}
                        </Link>
                    </fieldset>
                    <div className="max-w-sm space-y-1.5">
                        <p className="text-sm font-medium">{t("settings.target")}</p>
                        <SearchableSelect
                            className="w-full"
                            aria-label={t("settings.target")}
                            value={draft.defaultTarget}
                            onValueChange={(value) =>
                                setDraft((current) =>
                                    current
                                        ? {
                                              ...current,
                                              defaultTarget:
                                                  value as TranslateSettings["defaultTarget"]
                                          }
                                        : current
                                )
                            }
                            options={languages}
                            searchPlaceholder={t("lang.search")}
                            emptyText={t("lang.none")}
                        />
                    </div>
                </>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                <Button
                    variant="outline"
                    onClick={() => setDraft(loaded)}
                    disabled={!changed || saving}
                >
                    {t("settings.cancel")}
                </Button>
                <Button onClick={() => void save()} disabled={!changed || saving}>
                    {t("settings.save")}
                </Button>
            </div>
        </Card>
    );
}

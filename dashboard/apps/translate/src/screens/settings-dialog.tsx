"use client";

/**
 * The owner's settings: which engines may answer here, and the language a new
 * translation goes into. Save waits for a change; the keys themselves are on
 * the Integrations screen, which the dialog links to.
 */

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    SearchableSelect,
    Skeleton,
    Switch,
    isDirty,
    useToast,
    type SearchableSelectOption
} from "@polaris/ui";
import { unwrap, useTranslateT } from "./i18n";
import { saveSettingsAction, settingsAction } from "../actions/translate";
import { ENGINE_IDS, type EngineId, type TranslateSettings } from "../model/schemas";

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

export function SettingsDialog({
    open,
    onOpenChange,
    onSaved,
    languages
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
    languages: SearchableSelectOption[];
}) {
    const t = useTranslateT();
    const toast = useToast();
    const ids = useId();
    const [loaded, setLoaded] = useState<TranslateSettings | null>(null);
    const [draft, setDraft] = useState<TranslateSettings | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        void unwrap(() => settingsAction(), t("errors.generic"))
            .then((answer) => {
                setLoaded(answer.settings);
                setDraft(answer.settings);
            })
            .catch((caught: Error) => {
                toast.show({ title: t("errors.generic"), body: caught.message });
                onOpenChange(false);
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- read each time it opens
    }, [open]);

    const changed = loaded !== null && draft !== null && isDirty(loaded, draft);

    const save = async () => {
        if (!draft || !changed) return;
        setSaving(true);
        try {
            const answer = await unwrap(() => saveSettingsAction(draft), t("errors.saveFailed"));
            setLoaded(answer.settings);
            toast.show({ title: t("settings.saved") });
            onSaved();
            onOpenChange(false);
        } catch (caught) {
            toast.show({ title: t("errors.saveFailed"), body: (caught as Error).message });
        } finally {
            setSaving(false);
        }
    };

    const toggle = (id: EngineId, on: boolean) =>
        setDraft((current) => (current ? { ...current, engines: { ...current.engines, [id]: on } } : current));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("settings.title")}</DialogTitle>
                    <DialogDescription>{t("settings.description")}</DialogDescription>
                </DialogHeader>
                {draft === null ? (
                    <div className="space-y-3">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                ) : (
                    <div className="space-y-4">
                        <fieldset className="space-y-3">
                            <legend className="mb-2 text-sm font-medium">{t("settings.engines")}</legend>
                            {ENGINE_IDS.map((id) => (
                                <div key={id} className="flex min-w-0 items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm">{t(NAME[id])}</p>
                                        <p id={`${ids}-${id}`} className="text-xs text-muted-foreground">
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
                        <div className="space-y-1.5">
                            <p className="text-sm font-medium">{t("settings.target")}</p>
                            <SearchableSelect
                                className="w-full"
                                aria-label={t("settings.target")}
                                value={draft.defaultTarget}
                                onValueChange={(value) =>
                                    setDraft((current) =>
                                        current
                                            ? { ...current, defaultTarget: value as TranslateSettings["defaultTarget"] }
                                            : current
                                    )
                                }
                                options={languages}
                                searchPlaceholder={t("lang.search")}
                                emptyText={t("lang.none")}
                            />
                        </div>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t("settings.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={!changed || saving}>
                        {t("settings.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

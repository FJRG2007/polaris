"use client";

/**
 * Polar's extras in its settings: whether a suggested next message follows
 * each answer, and the model that writes it and the thread's title
 * (`lib/polar/helper-model.ts`). Automatic by default; a picked model that
 * can no longer be used says so here, while the server quietly uses
 * Automatic instead.
 */

import { useEffect, useState } from "react";
import { Switch, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useSettingsModels } from "@/components/polar/settings-models";
import { helperModelOf, type PolarHelperModel } from "@/lib/polar/display";
import { automaticChoice, isAutomatic, type ModelChoice } from "@/lib/polar/shared";
import { changePolarDisplay, usePolarDisplay } from "@/components/polar/polar-display";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";

/** The helper model as the picker shows it: always at the fastest level. */
export function helperChoiceOf(helper: PolarHelperModel | null): ModelChoice {
    return helper ? { kind: "language", ...helper, intelligence: "fast" } : automaticChoice("fast");
}

/** Whether a picked helper model is one this person can use now. */
export function helperAvailable(
    helper: PolarHelperModel | null,
    providers: readonly ModelSelectorProvider[] | null
): boolean {
    if (!helper || !providers) return true;
    const provider = providers.find((entry) => entry.provider === helper.provider);
    if (!provider) return false;
    if (helper.payer && !provider.payers.includes(helper.payer)) return false;
    return provider.models.some((model) => model.model === helper.model);
}

async function saveHelper(helper: PolarHelperModel | null): Promise<boolean> {
    const response = await fetch("/api/polar/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ helperModel: helper })
    }).catch(() => null);
    return !!response?.ok;
}

export function HelperSettings({ providers }: { providers: ModelSelectorProvider[] | null }) {
    const t = useTranslations("polar");
    const toast = useToast();
    const display = usePolarDisplay();
    // Undefined until read: the picker waits rather than showing a wrong pick.
    const [helper, setHelper] = useState<PolarHelperModel | null | undefined>(undefined);
    useEffect(() => {
        let live = true;
        void fetch("/api/polar/preferences")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { helperModel?: unknown } | null) => {
                if (live) setHelper(helperModelOf(data?.helperModel));
            })
            .catch(() => (live ? setHelper(null) : undefined));
        return () => {
            live = false;
        };
    }, []);
    const failed = () => toast.show({ title: t("settings.helper.failed") });
    const pick = (choice: ModelChoice) => {
        const next: PolarHelperModel | null = isAutomatic(choice)
            ? null
            : { provider: choice.provider, model: choice.model, payer: choice.payer };
        const before = helper ?? null;
        if (JSON.stringify(before) === JSON.stringify(next)) return;
        // Shown at once, put back if the server did not keep it.
        setHelper(next);
        void saveHelper(next).then((saved) => {
            if (saved) return;
            setHelper(before);
            failed();
        });
    };
    const available = helperAvailable(helper ?? null, providers);
    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">
                    {t("settings.helper.title")}
                </h2>
                <p className="text-xs text-muted-foreground">{t("settings.helper.intro")}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                <li className="flex min-w-0 items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground">
                            {t("settings.helper.suggestions")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("settings.helper.suggestionsHint")}
                        </p>
                    </div>
                    <Switch
                        checked={display.suggestions}
                        aria-label={t("settings.helper.suggestions")}
                        onChange={(value) =>
                            void changePolarDisplay("suggestions", value).then((saved) =>
                                saved ? undefined : failed()
                            )
                        }
                    />
                </li>
                <li className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground">{t("settings.helper.model")}</p>
                        <p
                            className={
                                available ? "text-xs text-muted-foreground" : "text-xs text-warning"
                            }
                            role={available ? undefined : "status"}
                        >
                            {available
                                ? t("settings.helper.modelHint")
                                : t("settings.helper.unavailable")}
                        </p>
                    </div>
                    {helper !== undefined ? (
                        <ModelSelector
                            providers={providers ?? []}
                            choice={helperChoiceOf(helper)}
                            onChoice={pick}
                        />
                    ) : (
                        <span className="h-7 w-24 animate-pulse rounded-md bg-muted" />
                    )}
                </li>
            </ul>
        </section>
    );
}

/** The extras section on the settings page, with the models this person can
 *  pick read from the server; until then a pick is not reported unavailable. */
export function PolarHelperSettings() {
    const { answer } = useSettingsModels();
    return <HelperSettings providers={answer?.providers ?? null} />;
}

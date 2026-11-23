"use client";

/**
 * The Dockerfile build's ARG values and the stage it stops at. Empty is how
 * every service built before the setting existed; the next deploy applies it.
 */

import { Plus, Trash2 } from "lucide-react";
import { Button, Input } from "@polaris/ui";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { buildOptionsAction, setBuildOptionsAction } from "./build-options-actions";
import { CardError, CardSkeleton, SaveBar, SettingsCard, useSavedFlash } from "./settings-kit";
import {
    MAX_BUILD_ARGS,
    MAX_BUILD_ARG_VALUE,
    buildOptionsProblem,
    normalizeBuildOptions,
    type BuildOptionsInput
} from "@/lib/deploy/build-options-schema";

export function BuildOptionsCard({
    applicationId,
    canConfigure
}: {
    applicationId: string;
    canConfigure: boolean;
}) {
    const t = useTranslations("deployService");
    const [saved, setSaved] = useState<BuildOptionsInput | null>(null);
    const [draft, setDraft] = useState<BuildOptionsInput | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [justSaved, markSaved] = useSavedFlash();

    const load = () => {
        setLoadError(null);
        void buildOptionsAction(applicationId).then((result) => {
            if (result.error || !result.options) return setLoadError(result.error ?? "");
            setSaved(result.options);
            setDraft(result.options);
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(load, [applicationId]);

    if (loadError !== null)
        return (
            <CardError entry="buildOptions" title={t("buildOptions.title")} message={loadError} onRetry={load} />
        );
    if (!saved || !draft) return <CardSkeleton entry="buildOptions" title={t("buildOptions.title")} rows={2} />;

    const next = normalizeBuildOptions(draft);
    const problem = buildOptionsProblem(draft);
    const dirty = JSON.stringify(next) !== JSON.stringify(saved);
    const setRow = (index: number, patch: Partial<{ key: string; value: string }>) =>
        setDraft({ ...draft, args: draft.args.map((row, at) => (at === index ? { ...row, ...patch } : row)) });

    const save = () =>
        startTransition(async () => {
            setError(null);
            const result = await setBuildOptionsAction(applicationId, next);
            if (result.error) return setError(result.error);
            setSaved(next);
            setDraft(next);
            markSaved();
        });

    return (
        <SettingsCard
            entry="buildOptions"
            title={t("buildOptions.title")}
            description={t("buildOptions.description")}
            actions={
                canConfigure ? (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDraft({ ...draft, args: [...draft.args, { key: "", value: "" }] })}
                        disabled={draft.args.length >= MAX_BUILD_ARGS}
                    >
                        <Plus aria-hidden /> {t("buildOptions.add")}
                    </Button>
                ) : undefined
            }
            footer={
                canConfigure ? (
                    <SaveBar
                        dirty={dirty}
                        pending={pending}
                        justSaved={justSaved}
                        invalid={
                            problem
                                ? t(`buildOptions.problem.${problem}`, {
                                      max: MAX_BUILD_ARG_VALUE,
                                      count: MAX_BUILD_ARGS
                                  })
                                : null
                        }
                        error={error}
                        onSave={save}
                        onDiscard={() => setDraft(saved)}
                    />
                ) : undefined
            }
        >
            <div className="flex flex-col gap-3">
                <label className="flex min-w-0 flex-col gap-1 sm:max-w-xs">
                    <span className="text-xs font-medium">{t("buildOptions.target")}</span>
                    <Input
                        value={draft.targetStage}
                        onChange={(event) => setDraft({ ...draft, targetStage: event.target.value })}
                        placeholder={t("buildOptions.targetPlaceholder")}
                        disabled={!canConfigure}
                        aria-invalid={problem === "stage" ? true : undefined}
                        spellCheck={false}
                        autoComplete="off"
                    />
                </label>
                {draft.args.map((row, index) => (
                    <div key={index} className="flex min-w-0 items-center gap-2">
                        <Input
                            value={row.key}
                            onChange={(event) => setRow(index, { key: event.target.value })}
                            placeholder="NODE_ENV"
                            className="h-8 w-28 shrink-0 font-mono sm:w-40"
                            disabled={!canConfigure}
                            aria-label={t("buildOptions.name")}
                            spellCheck={false}
                            autoComplete="off"
                        />
                        <Input
                            value={row.value}
                            onChange={(event) => setRow(index, { value: event.target.value })}
                            placeholder="production"
                            className="h-8 min-w-0 flex-1 font-mono"
                            disabled={!canConfigure}
                            aria-label={t("buildOptions.value")}
                            spellCheck={false}
                            autoComplete="off"
                        />
                        {canConfigure && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                onClick={() =>
                                    setDraft({ ...draft, args: draft.args.filter((_, at) => at !== index) })
                                }
                                aria-label={t("buildOptions.remove", { name: row.key || String(index + 1) })}
                            >
                                <Trash2 aria-hidden />
                            </Button>
                        )}
                    </div>
                ))}
            </div>
        </SettingsCard>
    );
}

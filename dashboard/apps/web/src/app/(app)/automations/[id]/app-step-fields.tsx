"use client";

/**
 * The settings of a step an installed app declares in its manifest, drawn from
 * its declared fields: text and long text take references to earlier steps,
 * numbers stay within their bounds, a choice offers only its options. Checked
 * as it is typed by the same schema the engine checks it with on save, publish
 * and run.
 */

import * as core from "@polaris/core";
import { RefInput, RefTextarea } from "./references";
import { Checkbox, Input, Select } from "@polaris/ui";
import type { AppStepView } from "@/lib/automations/app-steps";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Config = Record<string, unknown>;

/** The first field the declared schema finds wrong, for the hint under it. */
function wrongFields(step: AppStepView, config: unknown): Set<string> {
    const parsed = core.appStepConfigSchema(step).safeParse(config ?? {});
    return new Set(parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0] ?? "")));
}

export function AppStepFields({
    step,
    config,
    setConfig,
    disabled
}: {
    step: AppStepView;
    config: unknown;
    setConfig: (config: unknown) => void;
    disabled: boolean;
}) {
    const t = useTranslations("automations");
    const values = (config && typeof config === "object" ? config : {}) as Config;
    const wrong = wrongFields(step, values);
    const set = (key: string, value: unknown) => {
        const next = { ...values };
        if (value === undefined || value === "") delete next[key];
        else next[key] = value;
        setConfig(next);
    };
    return (
        <div className="flex flex-col gap-3">
            {step.description ? <p className="text-xs text-muted-foreground">{step.description}</p> : null}
            {step.fields.map((field) => {
                const value = values[field.key];
                const invalid = wrong.has(field.key);
                const label = field.required ? `${field.label} *` : field.label;
                return (
                    <div key={field.key} className="min-w-0 space-y-1 text-sm">
                        {field.kind === "boolean" ? (
                            <label className="flex items-center gap-2">
                                <Checkbox
                                    checked={value === true}
                                    disabled={disabled}
                                    onChange={(event) => set(field.key, event.target.checked)}
                                />
                                <span className="min-w-0">{field.label}</span>
                            </label>
                        ) : (
                            <label className="block min-w-0 space-y-1">
                                <span>{label}</span>
                                {field.kind === "choice" ? (
                                    <Select
                                        value={typeof value === "string" ? value : ""}
                                        placeholder={t("appSteps.choose")}
                                        options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
                                        onValueChange={(picked) => set(field.key, picked)}
                                        disabled={disabled}
                                        aria-label={field.label}
                                    />
                                ) : field.kind === "number" ? (
                                    <Input
                                        type="number"
                                        min={field.min}
                                        max={field.max}
                                        value={typeof value === "number" ? value : ""}
                                        disabled={disabled}
                                        aria-invalid={invalid || undefined}
                                        onChange={(event) =>
                                            set(field.key, event.target.value === "" ? undefined : Number(event.target.value))
                                        }
                                    />
                                ) : field.kind === "text" ? (
                                    <RefTextarea
                                        value={typeof value === "string" ? value : ""}
                                        maxLength={field.max ?? 4_000}
                                        disabled={disabled}
                                        aria-invalid={invalid || undefined}
                                        onChange={(event) => set(field.key, event.target.value)}
                                    />
                                ) : (
                                    <RefInput
                                        value={typeof value === "string" ? value : ""}
                                        maxLength={field.kind === "id" ? 64 : (field.max ?? 200)}
                                        disabled={disabled}
                                        aria-invalid={invalid || undefined}
                                        onChange={(event) => set(field.key, event.target.value)}
                                    />
                                )}
                            </label>
                        )}
                        {field.hint ? <p className="text-xs text-muted-foreground">{field.hint}</p> : null}
                        {invalid && value !== undefined ? (
                            <p className="text-xs text-danger">{t("appSteps.invalid")}</p>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

"use client";

/**
 * What an agent works with, as both agent editors show it: the account it signs
 * in with and the models it may use, in order, the first preferred - the shape
 * of GitHub Copilot's custom agents (an ordered `model:` list) with the account
 * picked from the ones on Account > AI keys.
 */

import Link from "next/link";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Button, Select, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { modelProviderName } from "@/lib/agents/model-key-providers";
import { ModelSelector, type ModelSelectorProvider } from "@/components/polar/elements/model-selector";
import type { AgentEngine, ComposerAccount } from "@/lib/polar/agents/composer-agents";
import {
    AGENT_MODELS_MAX,
    POLAR_ENGINE,
    type AgentModel,
    type AgentWork
} from "@/lib/polar/agents/shared";

/** A model the agent can list, as the picker shows it. */
export interface AgentModelOption {
    provider: string;
    model: string;
    label: string;
}

const ANY_ACCOUNT = "any";
const keyOf = (provider: string, model: string) => `${provider}\u0000${model}`;

type Translate = ReturnType<typeof useTranslations>;

/** What to call one way of signing in. */
export function accountLabel(account: ComposerAccount, t: Translate): string {
    if (account.kind === "machine") return t("settings.agents.work.machine");
    if (account.kind === "any" || !account.label) return t("settings.agents.work.anyAccount");
    return account.kind === "apiKey"
        ? t("settings.agents.work.apiKey", { name: account.label })
        : account.label;
}

/** The value an account is stored as: "machine", its id, or null for any. */
export function accountValue(account: ComposerAccount): string | null {
    return account.machine ? "machine" : account.accountId;
}

/** The models an engine's list is picked from. */
export function modelOptionsFor(
    engine: string,
    engines: readonly AgentEngine[],
    polarModels: readonly AgentModelOption[]
): AgentModelOption[] {
    const found = engines.find((entry) => entry.engine === engine);
    if (engine === POLAR_ENGINE || found?.modelSource === "polar") return [...polarModels];
    return (found?.catalogue ?? []).map((model) => ({
        provider: model.provider,
        model: model.model,
        label: model.name
    }));
}

/** The models still free to add, grouped the way Polar's model picker draws
 *  them: one group per provider, under that provider's name and logo. */
export function selectorProviders(options: readonly AgentModelOption[]): ModelSelectorProvider[] {
    const groups = new Map<string, ModelSelectorProvider>();
    for (const option of options) {
        const group = groups.get(option.provider) ?? {
            provider: option.provider,
            name: modelProviderName(option.provider),
            payers: [],
            models: []
        };
        group.models.push({
            provider: option.provider,
            model: option.model,
            name: option.label,
            reasoning: false
        });
        groups.set(option.provider, group);
    }
    return [...groups.values()];
}

export function AgentWorkFields({
    value,
    onChange,
    engines,
    polarModels,
    idPrefix
}: {
    value: AgentWork;
    onChange: (next: AgentWork) => void;
    engines: readonly AgentEngine[];
    polarModels: readonly AgentModelOption[];
    idPrefix: string;
}) {
    const t = useTranslations("polar");
    const engine = engines.find((entry) => entry.engine === value.engine) ?? null;
    const polar = value.engine === POLAR_ENGINE;
    const takesModels = polar || (engine !== null && engine.modelSource !== "none");
    const options = modelOptionsFor(value.engine, engines, polarModels);
    const labelOf = (entry: AgentModel) =>
        options.find((option) => option.provider === entry.provider && option.model === entry.model)
            ?.label ?? entry.model;
    const free = options.filter(
        (option) =>
            !value.models.some(
                (entry) => entry.provider === option.provider && entry.model === option.model
            )
    );
    const setModels = (models: AgentModel[]) =>
        onChange({
            ...value,
            models,
            // Only a list can be kept to.
            modelPolicy: models.length === 0 ? "preferred" : value.modelPolicy
        });
    const move = (index: number, by: -1 | 1) => {
        const next = [...value.models];
        const [entry] = next.splice(index, 1);
        if (!entry) return;
        next.splice(index + by, 0, entry);
        setModels(next);
    };

    // The accounts this tool can sign in with; "any" is the first that works.
    const accounts = (engine?.accounts ?? []).filter((entry) => entry.kind !== "any");
    const accountOptions = [
        { value: ANY_ACCOUNT, label: t("settings.agents.work.anyAccount") },
        ...accounts.map((entry) => ({
            value: accountValue(entry) ?? ANY_ACCOUNT,
            label: accountLabel(entry, t)
        })),
        // An account removed since still reads as what it was.
        ...(value.account && !accounts.some((entry) => accountValue(entry) === value.account)
            ? [{ value: value.account, label: t("settings.agents.work.accountGone") }]
            : [])
    ];

    return (
        <>
            {!polar ? (
                <div className="flex flex-col gap-1 text-sm">
                    <label htmlFor={`${idPrefix}-account`}>{t("settings.agents.work.account")}</label>
                    <Select
                        id={`${idPrefix}-account`}
                        value={value.account ?? ANY_ACCOUNT}
                        options={accountOptions}
                        onValueChange={(next) =>
                            onChange({ ...value, account: next === ANY_ACCOUNT ? null : next })
                        }
                    />
                    <span className="text-xs text-muted-foreground">
                        {t("settings.agents.work.accountHint")}{" "}
                        <Link href="/account/ai-keys" className="text-primary hover:underline">
                            {t("settings.agents.work.manageAccounts")}
                        </Link>
                    </span>
                </div>
            ) : null}
            <fieldset className="flex min-w-0 flex-col gap-1.5 text-sm">
                <legend>{t("settings.agents.work.models")}</legend>
                {!takesModels ? (
                    <span className="text-xs text-muted-foreground">
                        {t("settings.agents.work.ownModel")}
                    </span>
                ) : (
                    <>
                        <span className="text-xs text-muted-foreground">
                            {value.models.length === 0
                                ? t("settings.agents.work.anyModel")
                                : t("settings.agents.work.modelsHint")}
                        </span>
                        {value.models.length > 0 ? (
                            <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
                                {value.models.map((entry, index) => (
                                    <li
                                        key={keyOf(entry.provider, entry.model)}
                                        className="flex min-w-0 items-center gap-2 px-2 py-1.5"
                                    >
                                        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                                            {index + 1}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate" title={labelOf(entry)}>
                                            {labelOf(entry)}
                                        </span>
                                        {index === 0 ? (
                                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                                                {t("settings.agents.work.preferred")}
                                            </span>
                                        ) : null}
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={index === 0}
                                            aria-label={t("settings.agents.work.up")}
                                            title={t("settings.agents.work.up")}
                                            onClick={() => move(index, -1)}
                                        >
                                            <ArrowUp className="size-4 shrink-0" />
                                        </Button>
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={index === value.models.length - 1}
                                            aria-label={t("settings.agents.work.down")}
                                            title={t("settings.agents.work.down")}
                                            onClick={() => move(index, 1)}
                                        >
                                            <ArrowDown className="size-4 shrink-0" />
                                        </Button>
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={t("settings.agents.work.remove")}
                                            title={t("settings.agents.work.remove")}
                                            onClick={() =>
                                                setModels(value.models.filter((_, at) => at !== index))
                                            }
                                        >
                                            <X className="size-4 shrink-0" />
                                        </Button>
                                    </li>
                                ))}
                            </ol>
                        ) : null}
                        {free.length > 0 && value.models.length < AGENT_MODELS_MAX ? (
                            <ModelSelector
                                providers={selectorProviders(free)}
                                choice={null}
                                forCode
                                triggerClassName="inline-flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-sm text-muted-foreground"
                                triggerContent={t("settings.agents.work.add")}
                                onChoice={(picked) =>
                                    setModels([
                                        ...value.models,
                                        { provider: picked.provider, model: picked.model }
                                    ])
                                }
                            />
                        ) : options.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                                {t("settings.agents.work.noModels")}{" "}
                                <Link href="/account/ai-keys" className="text-primary hover:underline">
                                    {t("settings.agents.work.manageAccounts")}
                                </Link>
                            </span>
                        ) : null}
                        {value.models.length > 0 ? (
                            <label className="flex items-center justify-between gap-3">
                                <span className="min-w-0">
                                    <span className="block">{t("settings.agents.work.required")}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {t("settings.agents.work.requiredHint")}
                                    </span>
                                </span>
                                <Switch
                                    checked={value.modelPolicy === "required"}
                                    aria-label={t("settings.agents.work.required")}
                                    onChange={(on) =>
                                        onChange({ ...value, modelPolicy: on ? "required" : "preferred" })
                                    }
                                />
                            </label>
                        ) : null}
                    </>
                )}
            </fieldset>
        </>
    );
}

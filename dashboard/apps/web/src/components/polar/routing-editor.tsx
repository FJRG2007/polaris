"use client";

/**
 * The routing editor: the ordered fallback list a failing call walks, and the
 * models a coding tool's request lands on. One component for a person's own
 * routing in Polar's settings and the deployment's default on /admin/agents.
 *
 * Parity with free-claude-code's Admin UI (`admin_static/admin.js`, the
 * fallback editor, and `config/admin/manifest.py`, Model Routing): an add row
 * of model, effort and key; rows that drag, move by keyboard and delete; a
 * refusal of an incomplete entry and of one already listed; a default model,
 * one override per Claude tier and the efforts. Keys are named by their name
 * here rather than by a number, since a person reorders them.
 *
 * Controlled: the caller holds the routing and saves it. Without `onChange`
 * everything is shown as text, for the deployment's routing a person follows.
 */

import { useState } from "react";
import type { ModelChoice } from "@/lib/polar/shared";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import type { RouteKeyOption } from "@/lib/polar/routing-keys";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Select, Switch, cn, type SelectOption } from "@polaris/ui";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import {
    FALLBACKS_MOST,
    ROUTE_REASONING,
    targetKey,
    type ClaudeTier,
    type PolarRouting,
    type RouteReasoning,
    type RouteTarget
} from "@/lib/polar/routing";

/** The key select's value for "any key, in order": Radix refuses "". */
const ANY_KEY = "any";

/** The tiers in the order a person reads them (free-claude-code's manifest). */
const TIER_ORDER: readonly ClaudeTier[] = ["fable", "opus", "sonnet", "haiku"];

type Translator = NamespaceTranslator<"polar">;

function choiceOf(target: Pick<RouteTarget, "provider" | "model"> | null): ModelChoice | null {
    return target
        ? {
              kind: "language",
              provider: target.provider,
              model: target.model,
              intelligence: "balanced",
              payer: null
          }
        : null;
}

/** A model's name as the picker lists it, or its id when it is not on offer. */
export function modelLabel(
    target: Pick<RouteTarget, "provider" | "model">,
    providers: readonly ModelSelectorProvider[] | null
): { label: string; offered: boolean } {
    const provider = providers?.find((entry) => entry.provider === target.provider);
    const model = provider?.models.find((entry) => entry.model === target.model);
    if (model) return { label: model.name, offered: true };
    // Not knowing the list yet is not "not offered".
    return { label: `${target.provider}/${target.model}`, offered: providers === null };
}

export function effortOptions(t: Translator, withInherit = true): SelectOption[] {
    return ROUTE_REASONING.filter((level) => withInherit || level !== "inherit").map((level) => ({
        value: level,
        label: t(`routing.effort.${level}`)
    }));
}

/** "Any key, in order", the keys held for this provider, and a stored key that
 *  is gone, said as such rather than dropped. */
export function keyOptions(
    t: Translator,
    keys: readonly RouteKeyOption[],
    provider: string | null,
    stored: string | null = null
): SelectOption[] {
    const held = provider ? keys.filter((key) => key.provider === provider) : [];
    const options: SelectOption[] = [
        { value: ANY_KEY, label: t("routing.keys.any") },
        ...held.map((key) => ({
            value: key.id,
            label:
                key.source === "instance"
                    ? t("routing.keys.deployment", { name: key.name })
                    : key.name
        }))
    ];
    if (stored && !held.some((key) => key.id === stored)) {
        options.push({ value: stored, label: t("routing.keys.unavailable") });
    }
    return options;
}

export function RoutingEditor({
    value,
    onChange,
    providers,
    keys
}: {
    value: PolarRouting;
    onChange?: (next: PolarRouting) => void;
    /** The models on offer; null while they are read. */
    providers: ModelSelectorProvider[] | null;
    keys: readonly RouteKeyOption[];
}) {
    const t = useTranslations("polar");
    const editable = !!onChange;
    const set = (patch: Partial<PolarRouting>) => onChange?.({ ...value, ...patch });
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <FallbackList
                fallbacks={value.fallbacks}
                onChange={editable ? (fallbacks) => set({ fallbacks }) : undefined}
                providers={providers}
                keys={keys}
                t={t}
            />
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                <li className="flex min-w-0 items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground">{t("routing.pinned")}</p>
                        <p className="text-xs text-muted-foreground">{t("routing.pinnedHint")}</p>
                    </div>
                    <Switch
                        checked={value.pinnedFallsBack}
                        disabled={!editable}
                        aria-label={t("routing.pinned")}
                        onChange={(pinnedFallsBack) => set({ pinnedFallsBack })}
                    />
                </li>
            </ul>
            <section className="flex min-w-0 flex-col gap-2">
                <div className="min-w-0">
                    <h3 className="text-sm font-medium text-foreground">
                        {t("routing.tools.title")}
                    </h3>
                    <p className="text-xs text-muted-foreground">{t("routing.tools.intro")}</p>
                </div>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    <TargetRow
                        label={t("routing.tools.default")}
                        empty={t("routing.tools.automatic")}
                        target={value.defaultModel}
                        onChange={editable ? (defaultModel) => set({ defaultModel }) : undefined}
                        providers={providers}
                        t={t}
                    />
                    {TIER_ORDER.map((tier) => (
                        <TargetRow
                            key={tier}
                            label={t(`routing.tools.${tier}`)}
                            empty={t("routing.tools.useDefault")}
                            target={value.tiers[tier]}
                            onChange={
                                editable
                                    ? (target) => set({ tiers: { ...value.tiers, [tier]: target } })
                                    : undefined
                            }
                            providers={providers}
                            t={t}
                        />
                    ))}
                    <li className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm text-foreground">
                                {t("routing.tools.defaultEffort")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t("routing.tools.defaultEffortHint")}
                            </p>
                        </div>
                        <EffortField
                            value={value.defaultReasoning}
                            withInherit={false}
                            onChange={
                                editable
                                    ? (level) =>
                                          set({
                                              defaultReasoning: level as Exclude<
                                                  RouteReasoning,
                                                  "inherit"
                                              >
                                          })
                                    : undefined
                            }
                            label={t("routing.tools.defaultEffort")}
                            t={t}
                        />
                    </li>
                </ul>
            </section>
        </div>
    );
}

function EffortField({
    value,
    onChange,
    withInherit = true,
    label,
    t
}: {
    value: RouteReasoning;
    onChange?: (level: RouteReasoning) => void;
    withInherit?: boolean;
    label: string;
    t: Translator;
}) {
    if (!onChange) {
        return (
            <span className="shrink-0 text-xs text-muted-foreground">
                {t(`routing.effort.${value}`)}
            </span>
        );
    }
    return (
        <Select
            value={value}
            onValueChange={(next) => onChange(next as RouteReasoning)}
            options={effortOptions(t, withInherit)}
            aria-label={label}
            className="w-32 shrink-0"
        />
    );
}

/** The default model or one tier's override. */
function TargetRow({
    label,
    empty,
    target,
    onChange,
    providers,
    t
}: {
    label: string;
    /** What no model here means. */
    empty: string;
    target: RouteTarget | null;
    onChange?: (target: RouteTarget | null) => void;
    providers: ModelSelectorProvider[] | null;
    t: Translator;
}) {
    const shown = target ? modelLabel(target, providers) : null;
    return (
        <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{label}</p>
                <p
                    className={cn(
                        "truncate text-xs",
                        shown && !shown.offered ? "text-warning" : "text-muted-foreground"
                    )}
                    title={shown?.label ?? empty}
                >
                    {shown
                        ? shown.offered
                            ? shown.label
                            : t("routing.notOffered", { model: shown.label })
                        : empty}
                </p>
            </div>
            {onChange ? (
                <div className="flex min-w-0 items-center gap-1">
                    <ModelSelector
                        providers={providers ?? []}
                        choice={choiceOf(target)}
                        forCode
                        onChoice={(choice) =>
                            onChange({
                                provider: choice.provider,
                                model: choice.model,
                                reasoning: target?.reasoning ?? "inherit",
                                keyId: null
                            })
                        }
                    />
                    {target ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("routing.clearNamed", { name: label })}
                            title={t("routing.clear")}
                            onClick={() => onChange(null)}
                        >
                            <X className="size-4 shrink-0" />
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {target ? (
                <EffortField
                    value={target.reasoning}
                    onChange={onChange ? (reasoning) => onChange({ ...target, reasoning }) : undefined}
                    label={t("routing.effortNamed", { name: label })}
                    t={t}
                />
            ) : null}
        </li>
    );
}

/** The fallback list, with its add row. */
function FallbackList({
    fallbacks,
    onChange,
    providers,
    keys,
    t
}: {
    fallbacks: RouteTarget[];
    onChange?: (next: RouteTarget[]) => void;
    providers: ModelSelectorProvider[] | null;
    keys: readonly RouteKeyOption[];
    t: Translator;
}) {
    const [draft, setDraft] = useState<ModelChoice | null>(null);
    const [effort, setEffort] = useState<RouteReasoning>("inherit");
    const [keyId, setKeyId] = useState<string>(ANY_KEY);
    const [error, setError] = useState<string | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const full = fallbacks.length >= FALLBACKS_MOST;

    const move = (from: number, to: number) => {
        if (!onChange || to < 0 || to >= fallbacks.length || from === to) return;
        const next = [...fallbacks];
        const [entry] = next.splice(from, 1);
        if (!entry) return;
        next.splice(to, 0, entry);
        onChange(next);
    };
    const replace = (index: number, entry: RouteTarget) => {
        if (!onChange) return;
        const next = fallbacks.map((current, at) => (at === index ? entry : current));
        const keyOf = targetKey(entry);
        if (next.some((other, at) => at !== index && targetKey(other) === keyOf)) {
            setError(t("routing.errors.duplicate"));
            return;
        }
        setError(null);
        onChange(next);
    };
    const add = () => {
        if (!onChange) return;
        if (!draft) {
            setError(t("routing.errors.pickModel"));
            return;
        }
        if (full) {
            setError(t("routing.errors.tooMany"));
            return;
        }
        const entry: RouteTarget = {
            provider: draft.provider,
            model: draft.model,
            reasoning: effort,
            keyId: keyId === ANY_KEY ? null : keyId
        };
        if (fallbacks.some((other) => targetKey(other) === targetKey(entry))) {
            setError(t("routing.errors.duplicate"));
            return;
        }
        setError(null);
        onChange([...fallbacks, entry]);
        setDraft(null);
        setEffort("inherit");
        setKeyId(ANY_KEY);
    };

    return (
        <section className="flex min-w-0 flex-col gap-2">
            <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">
                    {t("routing.fallbacks.title")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("routing.fallbacks.order")}</p>
            </div>
            <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
                {fallbacks.length === 0 ? (
                    <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                        {t("routing.fallbacks.empty")}
                    </li>
                ) : (
                    fallbacks.map((entry, index) => {
                        const shown = modelLabel(entry, providers);
                        return (
                            <li
                                key={targetKey(entry)}
                                draggable={!!onChange}
                                onDragStart={(event) =>
                                    event.dataTransfer.setData("text/plain", String(index))
                                }
                                onDragOver={(event) => {
                                    if (!onChange) return;
                                    event.preventDefault();
                                    setOver(index);
                                }}
                                onDragLeave={() => setOver(null)}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    setOver(null);
                                    const from = Number(event.dataTransfer.getData("text/plain"));
                                    if (Number.isInteger(from)) move(from, index);
                                }}
                                className={cn(
                                    "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 px-2 py-2",
                                    over === index && "bg-muted/40"
                                )}
                            >
                                <div className="flex min-w-0 flex-1 basis-48 items-center gap-1">
                                    {onChange ? (
                                        <button
                                            type="button"
                                            className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground hover:text-foreground"
                                            aria-label={t("routing.fallbacks.move", {
                                                model: shown.label
                                            })}
                                            title={t("routing.fallbacks.moveHint")}
                                            onKeyDown={(event) => {
                                                if (event.key === "ArrowUp") {
                                                    event.preventDefault();
                                                    move(index, index - 1);
                                                } else if (event.key === "ArrowDown") {
                                                    event.preventDefault();
                                                    move(index, index + 1);
                                                }
                                            }}
                                        >
                                            <GripVertical className="size-4 shrink-0" />
                                        </button>
                                    ) : null}
                                    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                                        {index + 1}
                                    </span>
                                    <span
                                        className={cn(
                                            "min-w-0 truncate text-sm",
                                            shown.offered ? "text-foreground" : "text-warning"
                                        )}
                                        title={`${entry.provider}/${entry.model}`}
                                    >
                                        {shown.offered
                                            ? shown.label
                                            : t("routing.notOffered", { model: shown.label })}
                                    </span>
                                </div>
                                <div className="flex min-w-0 items-center gap-1">
                                    <EffortField
                                        value={entry.reasoning}
                                        onChange={
                                            onChange
                                                ? (reasoning) =>
                                                      replace(index, { ...entry, reasoning })
                                                : undefined
                                        }
                                        label={t("routing.effortNamed", { name: shown.label })}
                                        t={t}
                                    />
                                    <KeyField
                                        provider={entry.provider}
                                        value={entry.keyId}
                                        keys={keys}
                                        onChange={
                                            onChange
                                                ? (next) => replace(index, { ...entry, keyId: next })
                                                : undefined
                                        }
                                        label={t("routing.keyNamed", { name: shown.label })}
                                        t={t}
                                    />
                                    {onChange ? (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={t("routing.fallbacks.remove", {
                                                model: shown.label
                                            })}
                                            title={t("routing.fallbacks.removeShort")}
                                            onClick={() => {
                                                setError(null);
                                                onChange(fallbacks.filter((_, at) => at !== index));
                                            }}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                        </Button>
                                    ) : null}
                                </div>
                            </li>
                        );
                    })
                )}
            </ol>
            {onChange ? (
                full ? (
                    <p className="text-xs text-muted-foreground" role="status">
                        {t("routing.fallbacks.full", { most: FALLBACKS_MOST })}
                    </p>
                ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <ModelSelector
                            providers={providers ?? []}
                            choice={draft}
                            forCode
                            onChoice={(choice) => {
                                setDraft(choice);
                                setKeyId(ANY_KEY);
                                setError(null);
                            }}
                        />
                        <Select
                            value={effort}
                            onValueChange={(next) => setEffort(next as RouteReasoning)}
                            options={effortOptions(t)}
                            aria-label={t("routing.fallbacks.newEffort")}
                            className="w-32 shrink-0"
                        />
                        <Select
                            value={keyId}
                            onValueChange={setKeyId}
                            options={keyOptions(t, keys, draft?.provider ?? null)}
                            disabled={!draft}
                            aria-label={t("routing.fallbacks.newKey")}
                            className="w-44 min-w-0"
                        />
                        <Button type="button" size="sm" onClick={add}>
                            <Plus className="size-4 shrink-0" />
                            {t("routing.fallbacks.add")}
                        </Button>
                    </div>
                )
            ) : null}
            {error ? (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            ) : null}
        </section>
    );
}

function KeyField({
    provider,
    value,
    keys,
    onChange,
    label,
    t
}: {
    provider: string;
    value: string | null;
    keys: readonly RouteKeyOption[];
    onChange?: (keyId: string | null) => void;
    label: string;
    t: Translator;
}) {
    const options = keyOptions(t, keys, provider, value);
    if (!onChange) {
        const shown = options.find((option) => option.value === (value ?? ANY_KEY));
        return (
            <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
                {shown?.label}
            </span>
        );
    }
    return (
        <Select
            value={value ?? ANY_KEY}
            onValueChange={(next) => onChange(next === ANY_KEY ? null : next)}
            options={options}
            aria-label={label}
            className="w-44 min-w-0"
        />
    );
}

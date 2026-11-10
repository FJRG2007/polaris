"use client";

/**
 * The routing editor: the ordered fallback list a failing call walks, and the
 * models a coding tool's request lands on. One component for a person's own
 * routing in Polar's settings and the deployment's default on /admin/agents;
 * Polar's settings show the two halves on pages of their own
 * (`FallbackEditor`, `CodingToolsEditor`).
 *
 * Parity with free-claude-code's Admin UI (`admin_static/admin.js`, the
 * fallback editor, and `config/admin/manifest.py`, Model Routing): fallbacks
 * of model, effort and key that reorder and delete; a refusal of an incomplete
 * entry and of one already listed; a default model, one override per Claude
 * tier and the efforts. Keys are named by their name here rather than by a
 * number, since a person reorders them.
 *
 * Each fallback is a row that says what it is - provider, model, key, effort -
 * and is added or changed in a dialog whose every field is labelled, so no
 * bare select reads "No model" or "Inherit" with nothing saying what it is.
 *
 * Controlled: the caller holds the routing and saves it. Without `onChange`
 * everything is shown as text, for the deployment's routing a person follows.
 */

import { IntegrationLogo } from "@/components/logos";
import type { ModelChoice } from "@/lib/polar/shared";
import { useEffect, useState, type ReactNode } from "react";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { RouteKeyOption } from "@/lib/polar/routing-keys";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { toolMappings, type ToolMapping } from "@/lib/polar/routing-map";
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import {
    FALLBACKS_MOST,
    ROUTE_REASONING,
    targetKey,
    type PolarRouting,
    type RouteReasoning,
    type RouteTarget
} from "@/lib/polar/routing";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Switch,
    cn,
    moved,
    useListOrder,
    type SelectOption
} from "@polaris/ui";

/** The key select's value for "any key, in order": Radix refuses "". */
const ANY_KEY = "any";

/** The model picker as a form field rather than a chip on the composer. */
const FIELD_TRIGGER =
    "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-field px-3 text-sm text-foreground hover:bg-card-hover";

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

function providerName(slug: string, providers: readonly ModelSelectorProvider[] | null): string {
    return providers?.find((entry) => entry.provider === slug)?.name ?? slug;
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

function keyLabel(t: Translator, keys: readonly RouteKeyOption[], entry: RouteTarget): string {
    if (!entry.keyId) return t("routing.keys.any");
    const key = keys.find((option) => option.id === entry.keyId && option.provider === entry.provider);
    if (!key) return t("routing.keys.unavailable");
    return key.source === "instance" ? t("routing.keys.deployment", { name: key.name }) : key.name;
}

/**
 * The fallback list after a change, or the refusal that keeps it as it was:
 * an entry already listed (same model and key) or one past the most. `at` is
 * the row being replaced, or null for a new one at the end. Pure.
 */
export function withFallback(
    fallbacks: readonly RouteTarget[],
    entry: RouteTarget,
    at: number | null
): { ok: true; fallbacks: RouteTarget[] } | { ok: false; refusal: "duplicate" | "tooMany" } {
    const key = targetKey(entry);
    if (fallbacks.some((other, index) => index !== at && targetKey(other) === key)) {
        return { ok: false, refusal: "duplicate" };
    }
    if (at === null) {
        if (fallbacks.length >= FALLBACKS_MOST) return { ok: false, refusal: "tooMany" };
        return { ok: true, fallbacks: [...fallbacks, entry] };
    }
    return { ok: true, fallbacks: fallbacks.map((current, index) => (index === at ? entry : current)) };
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
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <FallbackEditor value={value} onChange={onChange} providers={providers} keys={keys} />
            <CodingToolsEditor value={value} onChange={onChange} providers={providers} />
        </div>
    );
}

function SectionHeading({ title, intro, action }: { title: string; intro: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
            <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-foreground">{title}</h3>
                <div className="text-xs text-muted-foreground">{intro}</div>
            </div>
            {action}
        </div>
    );
}

/** A provider's logo and a model's name, the way every row here names a model. */
function ModelName({
    target,
    providers,
    t
}: {
    target: Pick<RouteTarget, "provider" | "model">;
    providers: ModelSelectorProvider[] | null;
    t: Translator;
}) {
    const shown = modelLabel(target, providers);
    return (
        <span className="flex min-w-0 items-center gap-2">
            <IntegrationLogo slug={target.provider} className="size-4 shrink-0" />
            <span
                className={cn(
                    "min-w-0 truncate text-sm",
                    shown.offered ? "text-foreground" : "text-warning"
                )}
                title={`${providerName(target.provider, providers)} - ${target.provider}/${target.model}`}
            >
                {shown.offered ? shown.label : t("routing.notOffered", { model: shown.label })}
            </span>
        </span>
    );
}

/** The fallback list, the switch for picked models, and the dialog that adds
 *  or changes one entry. */
export function FallbackEditor({
    value,
    onChange,
    providers,
    keys
}: {
    value: PolarRouting;
    onChange?: (next: PolarRouting) => void;
    providers: ModelSelectorProvider[] | null;
    keys: readonly RouteKeyOption[];
}) {
    const t = useTranslations("polar");
    const fallbacks = value.fallbacks;
    const editable = !!onChange;
    const set = (next: RouteTarget[]) => onChange?.({ ...value, fallbacks: next });
    // null: closed; "new": adding one; a number: changing that row.
    const [editing, setEditing] = useState<"new" | number | null>(null);
    const full = fallbacks.length >= FALLBACKS_MOST;
    const order = useListOrder(
        fallbacks.length,
        (from, to) => set(moved(fallbacks, from, to)),
        fallbacks.map(targetKey)
    );
    const step = (from: number, to: number) => {
        if (to < 0 || to >= fallbacks.length) return;
        set(moved(fallbacks, from, to));
    };

    return (
        <div className="flex min-w-0 flex-col gap-6">
            <section className="flex min-w-0 flex-col gap-2">
                <SectionHeading
                    title={t("routing.fallbacks.title")}
                    intro={
                        <>
                            <p>{t("routing.fallbacks.order")}</p>
                            <p className="text-foreground-subtle">{t("routing.fallbacks.example")}</p>
                        </>
                    }
                    action={
                        editable && !full ? (
                            <Button type="button" size="sm" onClick={() => setEditing("new")}>
                                <Plus className="size-4 shrink-0" />
                                {t("routing.fallbacks.add")}
                            </Button>
                        ) : null
                    }
                />
                <ol
                    {...(editable ? order.listProps : {})}
                    aria-label={t("routing.fallbacks.title")}
                    className="flex flex-col divide-y divide-border rounded-md border border-border"
                >
                    {fallbacks.length === 0 ? (
                        <li className="flex flex-col items-center gap-1 px-3 py-5 text-center">
                            <p className="text-sm text-foreground">{t("routing.fallbacks.empty")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("routing.fallbacks.emptyHint")}
                            </p>
                        </li>
                    ) : (
                        fallbacks.map((entry, index) => {
                            const name = modelLabel(entry, providers).label;
                            return (
                                <li
                                    key={targetKey(entry)}
                                    {...(editable ? order.rowProps(index) : {})}
                                    className={cn(
                                        "flex min-w-0 items-center gap-2 px-2 py-2",
                                        order.dragging === index && "opacity-60",
                                        order.dropAt === index &&
                                            order.dragging !== null &&
                                            "shadow-[inset_0_2px_0_var(--color-primary)]"
                                    )}
                                >
                                    {editable ? (
                                        <button
                                            type="button"
                                            {...order.handleProps(index, fallbacks.length)}
                                            className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground hover:text-foreground"
                                            aria-label={t("routing.fallbacks.move", { model: name })}
                                            title={t("routing.fallbacks.moveHint")}
                                        >
                                            <GripVertical className="size-4 shrink-0" />
                                        </button>
                                    ) : null}
                                    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                                        {index + 1}
                                    </span>
                                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <ModelName target={entry} providers={providers} t={t} />
                                        <p className="flex min-w-0 flex-wrap gap-x-3 text-xs text-muted-foreground">
                                            <span className="min-w-0 truncate">
                                                {t("routing.fallbacks.keyIs", {
                                                    key: keyLabel(t, keys, entry)
                                                })}
                                            </span>
                                            <span className="shrink-0">
                                                {t("routing.fallbacks.effortIs", {
                                                    effort: t(`routing.effort.${entry.reasoning}`)
                                                })}
                                            </span>
                                        </p>
                                    </div>
                                    {editable ? (
                                        <div className="flex shrink-0 items-center">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                disabled={index === 0}
                                                aria-label={t("routing.fallbacks.up", { model: name })}
                                                title={t("routing.fallbacks.upShort")}
                                                onClick={() => step(index, index - 1)}
                                            >
                                                <ArrowUp className="size-4 shrink-0" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                disabled={index === fallbacks.length - 1}
                                                aria-label={t("routing.fallbacks.down", { model: name })}
                                                title={t("routing.fallbacks.downShort")}
                                                onClick={() => step(index, index + 1)}
                                            >
                                                <ArrowDown className="size-4 shrink-0" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t("routing.fallbacks.edit", { model: name })}
                                                title={t("routing.fallbacks.editShort")}
                                                onClick={() => setEditing(index)}
                                            >
                                                <Pencil className="size-4 shrink-0" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t("routing.fallbacks.remove", { model: name })}
                                                title={t("routing.fallbacks.removeShort")}
                                                onClick={() => set(fallbacks.filter((_, at) => at !== index))}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        </div>
                                    ) : null}
                                </li>
                            );
                        })
                    )}
                </ol>
                {editable && full ? (
                    <p className="text-xs text-muted-foreground" role="status">
                        {t("routing.fallbacks.full", { most: FALLBACKS_MOST })}
                    </p>
                ) : null}
            </section>
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
                        onChange={(pinnedFallsBack) => onChange?.({ ...value, pinnedFallsBack })}
                    />
                </li>
            </ul>
            {editable && editing !== null ? (
                <FallbackDialog
                    initial={editing === "new" ? null : (fallbacks[editing] ?? null)}
                    providers={providers}
                    keys={keys}
                    onClose={() => setEditing(null)}
                    onSave={(entry) => {
                        const result = withFallback(fallbacks, entry, editing === "new" ? null : editing);
                        if (!result.ok) return t(`routing.errors.${result.refusal}`);
                        set(result.fallbacks);
                        setEditing(null);
                        return null;
                    }}
                />
            ) : null}
        </div>
    );
}

function FieldLabel({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm text-foreground">{label}</span>
            {children}
            {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
    );
}

/** One fallback, every field named: the model, the key it spends, its effort. */
function FallbackDialog({
    initial,
    providers,
    keys,
    onClose,
    onSave
}: {
    initial: RouteTarget | null;
    providers: ModelSelectorProvider[] | null;
    keys: readonly RouteKeyOption[];
    onClose: () => void;
    /** The refusal to show, or null once it is kept. */
    onSave: (entry: RouteTarget) => string | null;
}) {
    const t = useTranslations("polar");
    const [draft, setDraft] = useState<ModelChoice | null>(choiceOf(initial));
    const [effort, setEffort] = useState<RouteReasoning>(initial?.reasoning ?? "inherit");
    const [keyId, setKeyId] = useState<string>(initial?.keyId ?? ANY_KEY);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => setError(null), [draft, effort, keyId]);
    const submit = () => {
        if (!draft) {
            setError(t("routing.errors.pickModel"));
            return;
        }
        setError(
            onSave({
                provider: draft.provider,
                model: draft.model,
                reasoning: effort,
                keyId: keyId === ANY_KEY ? null : keyId
            })
        );
    };
    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>
                        {initial ? t("routing.fallbacks.editTitle") : t("routing.fallbacks.addTitle")}
                    </DialogTitle>
                    <DialogDescription>{t("routing.fallbacks.dialogHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <FieldLabel label={t("routing.fallbacks.model")}>
                        <ModelSelector
                            providers={providers ?? []}
                            choice={draft}
                            forCode
                            triggerClassName={FIELD_TRIGGER}
                            triggerLabel={t("routing.fallbacks.model")}
                            onChoice={(choice) => {
                                if (choice.provider !== draft?.provider) setKeyId(ANY_KEY);
                                setDraft(choice);
                            }}
                        />
                    </FieldLabel>
                    <FieldLabel label={t("routing.fallbacks.key")} hint={t("routing.fallbacks.keyHint")}>
                        <Select
                            value={keyId}
                            onValueChange={setKeyId}
                            options={keyOptions(t, keys, draft?.provider ?? null, initial?.keyId ?? null)}
                            disabled={!draft}
                            aria-label={t("routing.fallbacks.key")}
                            className="w-full min-w-0"
                        />
                    </FieldLabel>
                    <FieldLabel
                        label={t("routing.fallbacks.effort")}
                        hint={t("routing.fallbacks.effortHint")}
                    >
                        <Select
                            value={effort}
                            onValueChange={(next) => setEffort(next as RouteReasoning)}
                            options={effortOptions(t)}
                            aria-label={t("routing.fallbacks.effort")}
                            className="w-full min-w-0"
                        />
                    </FieldLabel>
                    {error ? (
                        <p className="text-xs text-danger" role="alert">
                            {error}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("routing.fallbacks.cancel")}
                    </Button>
                    <Button type="button" onClick={submit} aria-disabled={!draft || undefined}>
                        {initial ? t("routing.fallbacks.save") : t("routing.fallbacks.add")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Where a coding tool's request lands, as a table: what the tool asks for on
 * the left, the model Polar answers with on the right - its own pick, or what
 * it follows (the default model, or Automatic) said as such - and the effort
 * it runs at.
 */
export function CodingToolsEditor({
    value,
    onChange,
    providers
}: {
    value: PolarRouting;
    onChange?: (next: PolarRouting) => void;
    providers: ModelSelectorProvider[] | null;
}) {
    const t = useTranslations("polar");
    const editable = !!onChange;
    const set = (patch: Partial<PolarRouting>) => onChange?.({ ...value, ...patch });
    const change = (asked: ToolMapping["asked"], target: RouteTarget | null) =>
        asked === "default"
            ? set({ defaultModel: target })
            : set({ tiers: { ...value.tiers, [asked]: target } });
    const asks = (asked: ToolMapping["asked"]) =>
        asked === "default" ? t("routing.tools.askOther") : t(`routing.tools.ask.${asked}`);
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <SectionHeading title={t("routing.tools.title")} intro={<p>{t("routing.tools.intro")}</p>} />
            <div className="min-w-0 overflow-hidden rounded-md border border-border">
                <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 bg-surface/60 px-3 py-2 text-xs font-medium text-foreground sm:grid">
                    <span>{t("routing.tools.whenAsked")}</span>
                    <span>{t("routing.tools.polarUses")}</span>
                </div>
                <ul className="flex flex-col divide-y divide-border sm:border-t sm:border-border">
                    {toolMappings(value).map((row) => (
                        <li
                            key={row.asked}
                            className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-center"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm text-foreground" title={asks(row.asked)}>
                                    {asks(row.asked)}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {row.asked === "default"
                                        ? t("routing.tools.askOtherHint")
                                        : t("routing.tools.askHint", { tier: row.asked })}
                                </p>
                            </div>
                            <MappingTarget
                                label={asks(row.asked)}
                                row={row}
                                editable={editable}
                                onChange={(target) => change(row.asked, target)}
                                providers={providers}
                                t={t}
                            />
                        </li>
                    ))}
                </ul>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                <li className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground">{t("routing.tools.defaultEffort")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("routing.tools.defaultEffortHint")}
                        </p>
                    </div>
                    {editable ? (
                        <Select
                            value={value.defaultReasoning}
                            onValueChange={(next) =>
                                set({ defaultReasoning: next as PolarRouting["defaultReasoning"] })
                            }
                            options={effortOptions(t, false)}
                            aria-label={t("routing.tools.defaultEffort")}
                            className="w-36 shrink-0"
                        />
                    ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {t(`routing.effort.${value.defaultReasoning}`)}
                        </span>
                    )}
                </li>
            </ul>
        </section>
    );
}

function MappingTarget({
    label,
    row,
    editable,
    onChange,
    providers,
    t
}: {
    /** What the tool asks for, naming this row's controls. */
    label: string;
    row: ToolMapping;
    editable: boolean;
    onChange: (target: RouteTarget | null) => void;
    providers: ModelSelectorProvider[] | null;
    t: Translator;
}) {
    const follows =
        row.via === "default"
            ? t("routing.tools.followsDefault")
            : row.via === "automatic"
              ? t("routing.tools.followsAutomatic")
              : null;
    const effort = t("routing.tools.effortIs", { effort: t(`routing.effort.${row.effort}`) });
    return (
        <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {row.target ? (
                    <ModelName target={row.target} providers={providers} t={t} />
                ) : (
                    <span className="truncate text-sm text-foreground">{t("routing.tools.automatic")}</span>
                )}
                <p className="flex min-w-0 flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {follows ? <span className="min-w-0 truncate" title={follows}>{follows}</span> : null}
                    <span className="shrink-0">{effort}</span>
                </p>
            </div>
            {editable ? (
                <div className="flex shrink-0 items-center gap-1">
                    <ModelSelector
                        providers={providers ?? []}
                        choice={choiceOf(row.own)}
                        forCode
                        triggerClassName="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-2.5 text-xs text-foreground hover:bg-card-hover"
                        triggerContent={row.own ? t("routing.tools.change") : t("routing.tools.choose")}
                        triggerLabel={`${row.own ? t("routing.tools.change") : t("routing.tools.choose")} - ${label}`}
                        onChoice={(choice) =>
                            onChange({
                                provider: choice.provider,
                                model: choice.model,
                                reasoning: row.own?.reasoning ?? "inherit",
                                keyId: null
                            })
                        }
                    />
                    {row.own ? (
                        <>
                            <Select
                                value={row.own.reasoning}
                                onValueChange={(next) =>
                                    row.own &&
                                    onChange({ ...row.own, reasoning: next as RouteReasoning })
                                }
                                options={effortOptions(t)}
                                aria-label={t("routing.effortNamed", { name: label })}
                                className="w-28 shrink-0"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("routing.tools.resetNamed", { name: label })}
                                title={t("routing.tools.reset")}
                                onClick={() => onChange(null)}
                            >
                                <X className="size-4 shrink-0" />
                            </Button>
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

"use client";

/**
 * The list view of an automation's graph: "When" (triggers), the steps in
 * order with If branches nested, and "Always, at the end". Edits change a
 * `ListFlow`; saving turns it back into the graph with `graphFromList`, the
 * same pure function the tests round-trip.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Play, Trash2 } from "lucide-react";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    CopyButton,
    Input,
    PageHeader,
    Select,
    Skeleton,
    Switch,
    Textarea,
    useToast,
    type SelectOption
} from "@polaris/ui";
import * as core from "@polaris/core";
import type { SecretSummary } from "@/lib/automations/secrets";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import {
    deleteAutomationAction,
    getAutomationAction,
    publishAction,
    rotateHookAction,
    runNowAction,
    saveDraftAction,
    setLocalNetworkAction,
    updateSettingsAction
} from "../actions";
import { LoadFailed, RowsSkeleton, Section, useCachedAction } from "../shared";

type T = ReturnType<typeof useTranslations<"automations">>;

const NODE_KEYS = {
    "core.manual": "manual",
    "core.schedule": "schedule",
    "core.webhook": "webhook",
    "core.if": "if",
    "core.wait": "wait",
    "core.notify": "notify",
    "core.http": "http",
    "core.chat": "chat"
} as const;
type NodeKey = (typeof NODE_KEYS)[keyof typeof NODE_KEYS];

const TRIGGER_TYPES = ["core.manual", "core.schedule", "core.webhook"] as const;
const STEP_TYPES = ["core.if", "core.wait", "core.notify", "core.http", "core.chat"] as const;

const DEFAULT_CONFIG: Record<string, () => unknown> = {
    "core.manual": () => ({}),
    "core.schedule": () => ({ kind: "every", amount: 15, unit: "minutes" }),
    "core.webhook": () => ({ method: "POST", rotation: 0 }),
    "core.if": () => ({ condition: { kind: "group", join: "all", items: [{ kind: "compare", left: "", op: "eq", right: "" }] } }),
    "core.wait": () => ({ kind: "duration", duration: { amount: 5, unit: "minutes" } }),
    "core.notify": () => ({ title: "", body: "" }),
    "core.http": () => ({
        method: "POST",
        url: "",
        urlSecretId: null,
        auth: { kind: "none" },
        query: [],
        headers: [],
        body: { kind: "none" },
        timeoutSeconds: 15,
        acceptAnyStatus: false
    }),
    "core.chat": () => ({ preset: "slack", secretId: "", title: "", text: "", link: "", level: "info" })
};

function newNode(type: string): core.GraphNode {
    return { id: core.automationNodeId(), type, typeVersion: 1, config: DEFAULT_CONFIG[type]?.() ?? {} };
}

function nodeTitle(t: T, type: string): string {
    const key = (NODE_KEYS as Record<string, NodeKey>)[type];
    return key ? t(`nodes.${key}`) : t("nodes.unknown");
}

function configValid(node: core.GraphNode): boolean {
    return core.isCoreNodeType(node.type) ? core.CORE_NODE_CONFIGS[node.type].safeParse(node.config).success : false;
}

export function AutomationEditor({ id }: { id: string }) {
    const t = useTranslations("automations");
    const { data, error, refresh } = useCachedAction(`polaris.automations.one.${id}`, () => getAutomationAction(id));

    return (
        <div className="space-y-6">
            <Link href="/automations" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
                {t("editor.back")}
            </Link>
            {error !== null && !data ? (
                <LoadFailed message={error || t("list.loadFailed")} onRetry={() => void refresh()} />
            ) : !data ? (
                <>
                    <Skeleton className="h-7 w-64" />
                    <RowsSkeleton rows={5} />
                </>
            ) : (
                <Loaded key={data.automation.id} detail={data.automation} secrets={data.secrets} onChanged={() => void refresh()} />
            )}
        </div>
    );
}

function Loaded({ detail, secrets, onChanged }: { detail: AutomationDetail; secrets: SecretSummary[]; onChanged: () => void }) {
    const t = useTranslations("automations");
    const toast = useToast();
    const router = useRouter();
    const initial = useMemo(() => core.listFromGraph(detail.draft), [detail.draft]);
    const [flow, setFlow] = useState<core.ListFlow | null>(initial);
    const [saved, setSaved] = useState(() => JSON.stringify(detail.draft));
    const [pending, start] = useTransition();
    const [deleting, setDeleting] = useState(false);
    const [lan, setLan] = useState(detail.allowLocalNetwork);
    const graph = useMemo(() => (flow ? core.graphFromList(flow) : detail.draft), [flow, detail.draft]);
    const dirty = JSON.stringify(graph) !== saved;
    const readOnly = !detail.canEdit;

    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    const save = async (): Promise<boolean> => {
        const answer = await saveDraftAction(detail.id, graph);
        if (!answer.ok) {
            toast.show({ title: answer.error });
            return false;
        }
        setSaved(JSON.stringify(graph));
        return true;
    };

    const act = (work: () => Promise<void>) => start(work);

    if (!flow)
        return (
            <>
                <PageHeader title={detail.name} />
                <p className="text-sm text-muted-foreground">{t("editor.notStructured")}</p>
            </>
        );

    const update = (change: Partial<core.ListFlow>) => setFlow({ ...flow, ...change });
    const hasManual = flow.triggers.some((node) => node.type === "core.manual");

    return (
        <>
            <PageHeader
                title={detail.name}
                description={detail.description || undefined}
                actions={
                    readOnly ? undefined : (
                        <div className="flex flex-wrap gap-2">
                            {dirty ? <span className="self-center text-xs text-muted-foreground">{t("editor.unsaved")}</span> : null}
                            <Button variant="outline" disabled={!dirty || pending} onClick={() => act(async () => void ((await save()) && toast.show({ title: t("editor.saved") })))}>
                                {t("editor.save")}
                            </Button>
                            <Button
                                disabled={pending}
                                onClick={() =>
                                    act(async () => {
                                        if (dirty && !(await save())) return;
                                        const answer = await publishAction(detail.id);
                                        toast.show({ title: answer.ok ? t("editor.published") : answer.error });
                                        if (answer.ok) onChanged();
                                    })
                                }
                            >
                                {t("editor.publish")}
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={pending || !detail.published || !hasManual}
                                title={!hasManual ? t("editor.noManual") : !detail.published ? t("list.notPublished") : undefined}
                                onClick={() =>
                                    act(async () => {
                                        const answer = await runNowAction(detail.id);
                                        toast.show({ title: answer.ok ? t("editor.runStarted") : answer.error });
                                    })
                                }
                            >
                                <Play aria-hidden="true" />
                                {t("editor.runNow")}
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={t("editor.delete")} title={t("editor.delete")} onClick={() => setDeleting(true)}>
                                <Trash2 aria-hidden="true" />
                            </Button>
                        </div>
                    )
                }
            />
            {readOnly ? <p className="text-sm text-muted-foreground">{t("editor.readOnly")}</p> : null}
            <p className="text-xs text-muted-foreground">{t("editor.references", { example: "{{trigger.body.name}}" })}</p>

            <Section title={t("editor.when")} hint={t("editor.whenHint")}>
                <NodeList
                    nodes={flow.triggers.map((node) => ({ node }))}
                    onChange={(steps) => update({ triggers: steps.map((step) => step.node) })}
                    types={TRIGGER_TYPES}
                    addLabel={t("editor.addTrigger")}
                    detail={detail}
                    secrets={secrets}
                    readOnly={readOnly}
                    onChanged={onChanged}
                />
            </Section>
            <Section title={t("editor.steps")} hint={t("editor.stepsHint")}>
                <NodeList nodes={flow.steps} onChange={(steps) => update({ steps })} types={STEP_TYPES} addLabel={t("editor.addStep")} detail={detail} secrets={secrets} readOnly={readOnly} onChanged={onChanged} />
            </Section>
            <Section title={t("editor.always")} hint={t("editor.alwaysHint")}>
                <NodeList nodes={flow.finally} onChange={(steps) => update({ finally: steps })} types={STEP_TYPES} addLabel={t("editor.addStep")} detail={detail} secrets={secrets} readOnly={readOnly} onChanged={onChanged} />
                <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={flow.finallyOnCancel} disabled={readOnly} onChange={(event) => update({ finallyOnCancel: event.target.checked })} />
                    {t("editor.alsoOnCancel")}
                </label>
            </Section>

            {readOnly ? null : (
                <Settings detail={detail} onSaved={onChanged} />
            )}
            <section className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-4">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("editor.localNetwork")}</p>
                    <p className="text-xs text-muted-foreground">
                        {detail.localNetworkRefusal === "orgAdminOnly"
                            ? t("editor.localNetworkOrgAdminOnly")
                            : detail.localNetworkRefusal === "instanceAdminOnly"
                              ? t("editor.localNetworkInstanceAdminOnly")
                              : t("editor.localNetworkHint")}
                    </p>
                </div>
                <Switch
                    checked={lan}
                    disabled={readOnly || detail.localNetworkRefusal !== null}
                    aria-label={t("editor.localNetwork")}
                    onChange={async (next: boolean) => {
                        setLan(next);
                        const answer = await setLocalNetworkAction(detail.id, next);
                        if (!answer.ok) {
                            setLan(!next);
                            toast.show({ title: answer.error });
                        } else toast.show({ title: next ? t("editor.localNetworkOn") : t("editor.localNetworkOff") });
                    }}
                />
            </section>

            <ConfirmDeleteDialog
                open={deleting}
                onOpenChange={setDeleting}
                name={detail.name}
                kind={t("title")}
                requireTyping={false}
                confirmLabel={t("editor.delete")}
                pending={pending}
                onConfirm={() =>
                    act(async () => {
                        const answer = await deleteAutomationAction(detail.id);
                        if (!answer.ok) return void toast.show({ title: answer.error });
                        toast.show({ title: t("editor.deleted") });
                        router.push("/automations");
                    })
                }
            />
        </>
    );
}

function Settings({ detail, onSaved }: { detail: AutomationDetail; onSaved: () => void }) {
    const t = useTranslations("automations");
    const toast = useToast();
    const [form, setForm] = useState({ name: detail.name, description: detail.description, mode: detail.mode, maxRuns: detail.maxRuns, rateLimit: detail.rateLimit });
    const parsed = core.automationSettingsSchema.safeParse(form);
    const changed = JSON.stringify(form) !== JSON.stringify({ name: detail.name, description: detail.description, mode: detail.mode, maxRuns: detail.maxRuns, rateLimit: detail.rateLimit });
    const [pending, start] = useTransition();
    const modes: SelectOption[] = core.AUTOMATION_MODES.map((mode) => ({ value: mode, label: t(`modes.${mode}`) }));
    return (
        <Section title={t("editor.settings")}>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                    <span>{t("create.name")} *</span>
                    <Input value={form.name} maxLength={core.AUTOMATION_LIMITS.nameLength} onChange={(event) => setForm({ ...form, name: event.target.value })} aria-invalid={!parsed.success && form.name.trim() !== "" ? true : undefined} />
                </label>
                <label className="space-y-1 text-sm">
                    <span>{t("editor.mode")}</span>
                    <Select value={form.mode} onValueChange={(mode) => setForm({ ...form, mode: mode as core.AutomationMode })} options={modes} aria-label={t("editor.mode")} />
                    <span className="block text-xs text-muted-foreground">{t(`modeHints.${form.mode}`)}</span>
                </label>
                <label className="space-y-1 text-sm sm:col-span-2">
                    <span>{t("create.descriptionLabel")}</span>
                    <Textarea rows={2} value={form.description} maxLength={core.AUTOMATION_LIMITS.descriptionLength} onChange={(event) => setForm({ ...form, description: event.target.value })} />
                </label>
                <NumberField label={t("editor.maxRuns")} value={form.maxRuns} min={1} max={core.AUTOMATION_LIMITS.maxRunsCeiling} onChange={(maxRuns) => setForm({ ...form, maxRuns })} />
                <NumberField label={t("editor.rateLimit")} value={form.rateLimit} min={1} max={core.AUTOMATION_LIMITS.rateLimitCeiling} onChange={(rateLimit) => setForm({ ...form, rateLimit })} />
            </div>
            <div className="flex justify-end">
                <Button
                    variant="outline"
                    disabled={!changed || !parsed.success || pending}
                    onClick={() =>
                        start(async () => {
                            const answer = await updateSettingsAction(detail.id, form);
                            toast.show({ title: answer.ok ? t("editor.settingsSaved") : answer.error });
                            if (answer.ok) onSaved();
                        })
                    }
                >
                    {t("editor.saveSettings")}
                </Button>
            </div>
        </Section>
    );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
    const valid = Number.isInteger(value) && value >= min && value <= max;
    return (
        <label className="space-y-1 text-sm">
            <span>{label}</span>
            <Input type="number" inputMode="numeric" min={min} max={max} value={Number.isNaN(value) ? "" : value} aria-invalid={valid ? undefined : true} onChange={(event) => onChange(event.target.valueAsNumber)} />
        </label>
    );
}

interface ListProps {
    nodes: core.ListStep[];
    onChange: (steps: core.ListStep[]) => void;
    types: readonly string[];
    addLabel: string;
    detail: AutomationDetail;
    secrets: SecretSummary[];
    readOnly: boolean;
    onChanged: () => void;
}

function NodeList({ nodes, onChange, types, addLabel, ...rest }: ListProps) {
    const t = useTranslations("automations");
    const options = types.map((type) => ({ value: type, label: nodeTitle(t, type) }));
    const replaceAt = (index: number, step: core.ListStep | null) =>
        onChange(step ? nodes.map((entry, at) => (at === index ? step : entry)) : nodes.filter((_, at) => at !== index));
    return (
        <div className="space-y-2">
            {nodes.map((step, index) => (
                <NodeCard
                    key={step.node.id}
                    step={step}
                    onChange={(next) => replaceAt(index, next)}
                    onMove={(by) => onChange(core.moveBy(nodes, index, by))}
                    first={index === 0}
                    last={index === nodes.length - 1}
                    {...rest}
                />
            ))}
            {rest.readOnly ? null : (
                <Select
                    value=""
                    placeholder={addLabel}
                    options={options}
                    aria-label={addLabel}
                    className="w-full sm:w-56"
                    onValueChange={(type) => {
                        const node = newNode(type);
                        onChange([...nodes, type === "core.if" ? { node, then: [], else: [] } : { node }]);
                    }}
                />
            )}
        </div>
    );
}

function NodeCard({
    step,
    onChange,
    onMove,
    first,
    last,
    detail,
    secrets,
    readOnly,
    onChanged
}: Omit<ListProps, "nodes" | "onChange" | "types" | "addLabel"> & {
    step: core.ListStep;
    onChange: (step: core.ListStep | null) => void;
    onMove: (by: number) => void;
    first: boolean;
    last: boolean;
}) {
    const t = useTranslations("automations");
    const [open, setOpen] = useState(() => !configValid(step.node));
    const valid = configValid(step.node);
    const setConfig = (config: unknown) => onChange({ ...step, node: { ...step.node, config } });
    const isAction = core.nodeRole(step.node.type) === "action";
    return (
        <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{nodeTitle(t, step.node.type)}</p>
                    {!valid ? <p className="text-xs text-warning-ink">{t("runErrors.badConfig")}</p> : null}
                </div>
                {readOnly ? null : (
                    <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon-sm" disabled={first} aria-label={t("editor.moveUp")} title={t("editor.moveUp")} onClick={() => onMove(-1)}>
                            <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" disabled={last} aria-label={t("editor.moveDown")} title={t("editor.moveDown")} onClick={() => onMove(1)}>
                            <ArrowDown aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={open ? t("editor.done") : t("editor.edit")} title={open ? t("editor.done") : t("editor.edit")} onClick={() => setOpen(!open)}>
                            <Pencil aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={t("editor.remove")} title={t("editor.remove")} onClick={() => onChange(null)}>
                            <Trash2 aria-hidden="true" />
                        </Button>
                    </div>
                )}
            </div>
            {open || readOnly ? (
                <fieldset disabled={readOnly} className="space-y-3 border-t border-border p-3">
                    <NodeFields node={step.node} setConfig={setConfig} detail={detail} secrets={secrets} onChanged={onChanged} />
                    {isAction ? (
                        <label className="block space-y-1 text-sm">
                            <span>{t("editor.ifFails")}</span>
                            <Select
                                value={step.node.onError ?? "stop"}
                                onValueChange={(value) => onChange({ ...step, node: { ...step.node, onError: value as "stop" | "continue" } })}
                                options={[
                                    { value: "stop", label: t("editor.onErrorStop") },
                                    { value: "continue", label: t("editor.onErrorContinue") }
                                ]}
                                aria-label={t("editor.ifFails")}
                                className="w-full sm:w-56"
                            />
                        </label>
                    ) : null}
                </fieldset>
            ) : null}
            {step.node.type === "core.if" ? (
                <div className="space-y-3 border-t border-border p-3 pl-4 sm:pl-6">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">{t("editor.then")}</p>
                    <NodeList nodes={step.then ?? []} onChange={(then) => onChange({ ...step, then })} types={STEP_TYPES} addLabel={t("editor.addStep")} detail={detail} secrets={secrets} readOnly={readOnly} onChanged={onChanged} />
                    <p className="text-xs font-semibold uppercase text-muted-foreground">{t("editor.else")}</p>
                    <NodeList nodes={step.else ?? []} onChange={(otherwise) => onChange({ ...step, else: otherwise })} types={STEP_TYPES} addLabel={t("editor.addStep")} detail={detail} secrets={secrets} readOnly={readOnly} onChanged={onChanged} />
                </div>
            ) : null}
        </div>
    );
}

type Config = Record<string, any>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span>{label}</span>
            {children}
        </label>
    );
}

function Days({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
    const t = useTranslations("automations");
    const keys = ["0", "1", "2", "3", "4", "5", "6"] as const;
    return (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("fields.weekdays")}>
            {keys.map((key) => (
                <label key={key} className="flex items-center gap-1 text-xs">
                    <Checkbox
                        checked={value.includes(Number(key))}
                        onChange={(event) => onChange(event.target.checked ? [...value, Number(key)].sort() : value.filter((day) => day !== Number(key)))}
                    />
                    {t(`weekdays.${key}`)}
                </label>
            ))}
        </div>
    );
}

function NodeFields({
    node,
    setConfig,
    detail,
    secrets,
    onChanged
}: {
    node: core.GraphNode;
    setConfig: (config: unknown) => void;
    detail: AutomationDetail;
    secrets: SecretSummary[];
    onChanged: () => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const config = (node.config ?? {}) as Config;
    const set = (change: Config) => setConfig({ ...config, ...change });
    const secretOptions = (kinds: readonly string[]) =>
        secrets.filter((secret) => kinds.includes(secret.kind)).map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.hint})` }));
    const secretPick = (value: string, kinds: readonly string[], onPick: (id: string) => void) => {
        const options = secretOptions(kinds);
        return options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
                {t("fields.noSecrets")} <Link className="underline" href="/automations/secrets">{t("secrets.title")}</Link>
            </p>
        ) : (
            <Select value={options.some((option) => option.value === value) ? value : ""} placeholder={t("fields.chooseSecret")} options={options} onValueChange={onPick} aria-label={t("fields.secret")} />
        );
    };
    const units: SelectOption[] = [
        { value: "minutes", label: t("fields.minutes") },
        { value: "hours", label: t("fields.hours") },
        { value: "days", label: t("fields.days") }
    ];

    switch (node.type) {
        case "core.manual":
            return null;
        case "core.webhook": {
            const path = detail.hooks[node.id];
            const url = path && typeof window !== "undefined" ? `${window.location.origin}${path}` : null;
            return (
                <div className="space-y-3">
                    <Field label={t("fields.method")}>
                        <Select value={config.method ?? "POST"} onValueChange={(method) => set({ method })} options={[{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }, { value: "any", label: t("fields.anyMethod") }]} aria-label={t("fields.method")} />
                    </Field>
                    <div className="space-y-1 text-sm">
                        <span>{t("editor.webhookUrl")}</span>
                        {url ? (
                            <div className="flex min-w-0 items-center gap-2">
                                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={url}>
                                    {url}
                                </code>
                                <CopyButton value={url} />
                            </div>
                        ) : null}
                        <p className="text-xs text-muted-foreground">{t("editor.webhookUnpublished")}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                                const answer = await rotateHookAction(detail.id, node.id);
                                toast.show({ title: answer.ok ? t("editor.newAddressDone") : answer.error });
                                if (answer.ok) onChanged();
                            }}
                        >
                            {t("editor.newAddress")}
                        </Button>
                    </div>
                </div>
            );
        }
        case "core.schedule":
            return (
                <div className="space-y-3">
                    <Field label={t("fields.scheduleKind")}>
                        <Select
                            value={config.kind}
                            onValueChange={(kind) =>
                                setConfig(kind === "every" ? { kind, amount: 15, unit: "minutes" } : kind === "daily" ? { kind, times: ["08:00"], days: [] } : { kind, expression: "0 8 * * 1-5" })
                            }
                            options={[{ value: "every", label: t("fields.every") }, { value: "daily", label: t("fields.daily") }, { value: "cron", label: t("fields.cron") }]}
                            aria-label={t("fields.scheduleKind")}
                        />
                    </Field>
                    {config.kind === "every" ? (
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t("fields.amount")}>
                                <Input type="number" min={1} value={config.amount ?? ""} onChange={(event) => set({ amount: event.target.valueAsNumber })} />
                            </Field>
                            <Field label={t("fields.unit")}>
                                <Select value={config.unit} onValueChange={(unit) => set({ unit })} options={units} aria-label={t("fields.unit")} />
                            </Field>
                        </div>
                    ) : config.kind === "daily" ? (
                        <>
                            <Field label={t("fields.times")}>
                                <Input
                                    value={(config.times ?? []).join(", ")}
                                    onChange={(event) => set({ times: event.target.value.split(",").map((part) => part.trim()).filter(Boolean) })}
                                    placeholder="08:00, 18:30"
                                />
                            </Field>
                            <Days value={config.days ?? []} onChange={(days) => set({ days })} />
                        </>
                    ) : (
                        <Field label={t("fields.expression")}>
                            <Input value={config.expression ?? ""} onChange={(event) => set({ expression: event.target.value })} placeholder="0 8 * * 1-5" />
                        </Field>
                    )}
                </div>
            );
        case "core.if": {
            const group = config.condition as core.ConditionGroup;
            const leaves = group.items.filter((item): item is core.CompareLeaf => item.kind === "compare");
            const setGroup = (change: Partial<core.ConditionGroup>) => set({ condition: { ...group, ...change } });
            return (
                <div className="space-y-3">
                    <Field label={t("fields.join")}>
                        <Select value={group.join} onValueChange={(join) => setGroup({ join: join as "all" | "any" })} options={[{ value: "all", label: t("fields.joinAll") }, { value: "any", label: t("fields.joinAny") }]} aria-label={t("fields.join")} />
                    </Field>
                    {leaves.map((leaf, index) => (
                        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]">
                            <Input aria-label={t("fields.left")} placeholder="{{trigger.body.value}}" value={leaf.left} onChange={(event) => setGroup({ items: leaves.map((entry, at) => (at === index ? { ...entry, left: event.target.value } : entry)) })} />
                            <Select
                                value={leaf.op}
                                onValueChange={(op) => setGroup({ items: leaves.map((entry, at) => (at === index ? { ...entry, op: op as core.CompareOperator } : entry)) })}
                                options={core.COMPARE_OPERATORS.map((op) => ({ value: op, label: t(`operators.${op}`) }))}
                                aria-label={t("fields.op")}
                            />
                            {core.UNARY_OPERATORS.includes(leaf.op) ? (
                                <span />
                            ) : (
                                <Input aria-label={t("fields.right")} value={leaf.right} onChange={(event) => setGroup({ items: leaves.map((entry, at) => (at === index ? { ...entry, right: event.target.value } : entry)) })} />
                            )}
                            <Button variant="ghost" size="icon-sm" aria-label={t("editor.remove")} title={t("editor.remove")} disabled={leaves.length === 1} onClick={() => setGroup({ items: leaves.filter((_, at) => at !== index) })}>
                                <Trash2 aria-hidden="true" />
                            </Button>
                        </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => setGroup({ items: [...leaves, { kind: "compare", left: "", op: "eq", right: "" }] })}>
                        {t("fields.addCondition")}
                    </Button>
                </div>
            );
        }
        case "core.wait":
            return (
                <div className="space-y-3">
                    <Field label={t("fields.waitKind")}>
                        <Select
                            value={config.kind}
                            onValueChange={(kind) => setConfig(kind === "duration" ? { kind, duration: { amount: 5, unit: "minutes" } } : { kind, time: "08:00", days: [] })}
                            options={[{ value: "duration", label: t("fields.waitDuration") }, { value: "until", label: t("fields.waitUntil") }]}
                            aria-label={t("fields.waitKind")}
                        />
                    </Field>
                    {config.kind === "duration" ? (
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t("fields.amount")}>
                                <Input type="number" min={0} value={config.duration?.amount ?? ""} onChange={(event) => set({ duration: { ...config.duration, amount: event.target.valueAsNumber } })} />
                            </Field>
                            <Field label={t("fields.unit")}>
                                <Select value={config.duration?.unit} onValueChange={(unit) => set({ duration: { ...config.duration, unit } })} options={[{ value: "seconds", label: t("fields.seconds") }, ...units]} aria-label={t("fields.unit")} />
                            </Field>
                        </div>
                    ) : (
                        <>
                            <Field label={t("fields.time")}>
                                <Input type="time" value={config.time ?? ""} onChange={(event) => set({ time: event.target.value })} />
                            </Field>
                            <Days value={config.days ?? []} onChange={(days) => set({ days })} />
                        </>
                    )}
                </div>
            );
        case "core.notify":
            return (
                <div className="space-y-3">
                    <Field label={`${t("fields.title")} *`}>
                        <Input value={config.title ?? ""} maxLength={200} onChange={(event) => set({ title: event.target.value })} />
                    </Field>
                    <Field label={t("fields.body")}>
                        <Textarea rows={3} value={config.body ?? ""} onChange={(event) => set({ body: event.target.value })} />
                    </Field>
                </div>
            );
        case "core.chat":
            return (
                <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.preset")}>
                            <Select value={config.preset} onValueChange={(preset) => set({ preset })} options={core.CHAT_PRESETS.map((preset) => ({ value: preset, label: preset === "slack" ? "Slack" : preset === "discord" ? "Discord" : "Teams" }))} aria-label={t("fields.preset")} />
                        </Field>
                        <Field label={`${t("fields.secret")} *`}>
                            {secretPick(config.secretId ?? "", ["url"], (secretId) => set({ secretId }))}
                        </Field>
                    </div>
                    <Field label={`${t("fields.title")} *`}>
                        <Input value={config.title ?? ""} maxLength={256} onChange={(event) => set({ title: event.target.value })} />
                    </Field>
                    <Field label={t("fields.body")}>
                        <Textarea rows={3} value={config.text ?? ""} onChange={(event) => set({ text: event.target.value })} />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.link")}>
                            <Input value={config.link ?? ""} onChange={(event) => set({ link: event.target.value })} />
                        </Field>
                        <Field label={t("fields.level")}>
                            <Select
                                value={config.level}
                                onValueChange={(level) => set({ level })}
                                options={[{ value: "info", label: t("fields.levelInfo") }, { value: "success", label: t("fields.levelSuccess") }, { value: "warning", label: t("fields.levelWarning") }, { value: "danger", label: t("fields.levelDanger") }]}
                                aria-label={t("fields.level")}
                            />
                        </Field>
                    </div>
                </div>
            );
        case "core.http": {
            const fromSecret = config.urlSecretId !== null && config.urlSecretId !== undefined;
            const auth = (config.auth ?? { kind: "none" }) as Config;
            const body = (config.body ?? { kind: "none" }) as Config;
            return (
                <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                        <Field label={t("fields.method")}>
                            <Select value={config.method} onValueChange={(method) => set({ method })} options={core.HTTP_METHODS.map((method) => ({ value: method, label: method }))} aria-label={t("fields.method")} />
                        </Field>
                        <Field label={t("fields.url")}>
                            <Select
                                value={fromSecret ? "secret" : "typed"}
                                onValueChange={(source) => set(source === "secret" ? { urlSecretId: "", url: "" } : { urlSecretId: null })}
                                options={[{ value: "typed", label: t("fields.urlTyped") }, { value: "secret", label: t("fields.urlFromSecret") }]}
                                aria-label={t("fields.url")}
                            />
                        </Field>
                    </div>
                    {fromSecret ? (
                        secretPick(config.urlSecretId, ["url"], (urlSecretId) => set({ urlSecretId }))
                    ) : (
                        <Input aria-label={t("fields.url")} value={config.url ?? ""} placeholder="https://api.example.com/items" onChange={(event) => set({ url: event.target.value })} />
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.auth")}>
                            <Select
                                value={auth.kind}
                                onValueChange={(kind) => set({ auth: kind === "none" ? { kind } : kind === "header" ? { kind, secretId: "", header: "X-Api-Key" } : { kind, secretId: "" } })}
                                options={[{ value: "none", label: t("fields.authNone") }, { value: "bearer", label: t("fields.authBearer") }, { value: "basic", label: t("fields.authBasic") }, { value: "header", label: t("fields.authHeader") }]}
                                aria-label={t("fields.auth")}
                            />
                        </Field>
                        {auth.kind !== "none" ? (
                            <Field label={t("fields.secret")}>
                                {secretPick(auth.secretId ?? "", auth.kind === "basic" ? ["basic"] : auth.kind === "header" ? ["header", "token"] : ["token"], (secretId) => set({ auth: { ...auth, secretId } }))}
                            </Field>
                        ) : null}
                        {auth.kind === "header" ? (
                            <Field label={t("fields.header")}>
                                <Input value={auth.header ?? ""} onChange={(event) => set({ auth: { ...auth, header: event.target.value } })} />
                            </Field>
                        ) : null}
                    </div>
                    {config.method !== "GET" && config.method !== "HEAD" ? (
                        <>
                            <Field label={t("fields.bodyKind")}>
                                <Select
                                    value={body.kind}
                                    onValueChange={(kind) => set({ body: kind === "json" ? { kind, json: "{}" } : kind === "text" ? { kind, text: "" } : { kind } })}
                                    options={[{ value: "none", label: t("fields.bodyNone") }, { value: "json", label: t("fields.bodyJson") }, { value: "text", label: t("fields.bodyText") }]}
                                    aria-label={t("fields.bodyKind")}
                                />
                            </Field>
                            {body.kind === "json" ? (
                                <Textarea aria-label={t("fields.json")} rows={5} className="font-mono text-xs" value={body.json ?? ""} onChange={(event) => set({ body: { kind: "json", json: event.target.value } })} />
                            ) : body.kind === "text" ? (
                                <Textarea aria-label={t("fields.text")} rows={4} value={body.text ?? ""} onChange={(event) => set({ body: { kind: "text", text: event.target.value } })} />
                            ) : null}
                        </>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.timeout")}>
                            <Input type="number" min={1} max={30} value={config.timeoutSeconds ?? 15} onChange={(event) => set({ timeoutSeconds: event.target.valueAsNumber })} />
                        </Field>
                        <label className="flex items-center gap-2 self-end text-sm">
                            <Checkbox checked={Boolean(config.acceptAnyStatus)} onChange={(event) => set({ acceptAnyStatus: event.target.checked })} />
                            {t("fields.acceptAnyStatus")}
                        </label>
                    </div>
                </div>
            );
        }
        default:
            return <p className="text-sm text-muted-foreground">{t("nodes.unknown")}</p>;
    }
}

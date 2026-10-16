"use client";

/**
 * The automation editor: one graph, drawn either on the canvas or as the list
 * view - "When" (triggers), the steps in order with If branches nested, and
 * "Always, at the end". The graph is the one source of truth; the list view
 * edits a `ListFlow` turned back into the graph with `graphFromList` (notes and
 * positions kept), the same pure functions the tests round-trip. On a phone
 * the canvas is for looking and the list view is the editor.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, FlaskConical, History, Pencil, Play, Trash2 } from "lucide-react";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Badge,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
    Input,
    PageHeader,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    Textarea,
    useToast,
    type SelectOption
} from "@polaris/ui";
import * as core from "@polaris/core";
import type { SecretSummary } from "@/lib/automations/secrets";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import {
    deleteAutomationAction,
    getAutomationAction,
    getRunAction,
    listVersionsAction,
    publishAction,
    restoreVersionAction,
    startTestRunAction,
    runNowAction,
    saveDraftAction,
    setLocalNetworkAction,
    updateSettingsAction
} from "../actions";
import { useWide } from "@polaris/ui/automation-blocks";
import { useDraftHistory } from "@polaris/ui/automation-history";
import type { RunDetail, VersionRow } from "@/lib/automations/history";
import { CanvasEditor, nodeLabel } from "./canvas-editor";
import { EditorGraphProvider, ReferenceScope } from "./references";
import { LoadFailed, RowsSkeleton, Section, StatusChip, nodeTitle, useCachedAction, when } from "../shared";
import { NodeFields, STEP_TYPES, TRIGGER_TYPES, configValid, newNode } from "./node-fields";

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

type View = "canvas" | "list";
const VIEW_KEY = "polaris.automations.view";

function readView(): View | null {
    try {
        const value = localStorage.getItem(VIEW_KEY);
        return value === "canvas" || value === "list" ? value : null;
    } catch {
        return null;
    }
}

/** The list view's edits, back onto the graph: notes stay, and positions travel on the nodes. */
function withList(graph: core.AutomationGraph, flow: core.ListFlow): core.AutomationGraph {
    return { ...core.graphFromList(flow), notes: graph.notes };
}

/** The newest test run, refetched while it is still going. */
function useTestRun(runId: string | null): RunDetail | null {
    const [run, setRun] = useState<RunDetail | null>(null);
    useEffect(() => {
        if (!runId) return setRun(null);
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = async () => {
            const answer = await getRunAction(runId).catch(() => null);
            if (stopped) return;
            if (answer?.ok) setRun(answer.run);
            if (!answer?.ok || !core.runFinished(answer.run.status)) timer = setTimeout(load, 1500);
        };
        void load();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [runId]);
    return run;
}

function Loaded({ detail, secrets, onChanged }: { detail: AutomationDetail; secrets: SecretSummary[]; onChanged: () => void }) {
    const t = useTranslations("automations");
    const toast = useToast();
    const router = useRouter();
    const wide = useWide("(min-width: 768px)");
    const initial = useMemo(() => core.layoutGraph(detail.draft), [detail.draft]);
    const draft = useDraftHistory<core.AutomationGraph>(initial);
    const graph = draft.value ?? initial;
    const [saved, setSaved] = useState(() => JSON.stringify(initial));
    useEffect(() => setSaved(JSON.stringify(initial)), [initial]);
    const [pending, start] = useTransition();
    const [deleting, setDeleting] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [lan, setLan] = useState(detail.allowLocalNetwork);
    const [chosen, setChosen] = useState<View | null>(null);
    const [testRunId, setTestRunId] = useState<string | null>(detail.lastTestRunId);
    const testRun = useTestRun(testRunId);
    const flow = useMemo(() => core.listFromGraph(graph), [graph]);
    const dirty = JSON.stringify(graph) !== saved;
    const readOnly = !detail.canEdit;

    useEffect(() => setChosen(readView()), []);
    const view: View = !flow ? "canvas" : (chosen ?? (wide ? "canvas" : "list"));
    const choose = (next: View) => {
        setChosen(next);
        try {
            localStorage.setItem(VIEW_KEY, next);
        } catch {
            // The choice is only kept for this visit.
        }
    };

    const samples = useMemo(() => {
        const out: Record<string, unknown> = {};
        for (const step of testRun?.steps ?? []) if (step.output !== null && step.output !== undefined) out[step.nodeId] = step.output;
        return out;
    }, [testRun]);
    const states = useMemo(() => {
        if (!testRun) return undefined;
        const out: Record<string, string> = {};
        for (const step of testRun.steps) out[step.nodeId] = step.status;
        return out;
    }, [testRun]);

    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    const save = useCallback(async (): Promise<boolean> => {
        const answer = await saveDraftAction(detail.id, graph);
        if (!answer.ok) {
            toast.show({ title: answer.error });
            return false;
        }
        setSaved(JSON.stringify(graph));
        return true;
    }, [detail.id, graph, toast]);

    const act = (work: () => Promise<void>) => start(work);

    useEffect(() => {
        if (readOnly) return;
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (dirty) start(async () => void ((await save()) && toast.show({ title: t("editor.saved") })));
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [dirty, readOnly, save, t, toast]);

    const update = (change: Partial<core.ListFlow>) => flow && draft.change((current) => withList(current, { ...flow, ...change }), { group: true });
    const hasManual = graph.nodes.some((node) => node.type === "core.manual");
    const differs = core.draftDiffers(graph, detail.publishedVersion?.graph ?? null);
    const testing = testRun !== null && !core.runFinished(testRun.status) && testRun.id === testRunId;

    const editorGraph = useMemo(
        () => ({ graph, samples, label: (nodeId: string) => nodeLabel(t, graph.nodes.find((node) => node.id === nodeId)) }),
        [graph, samples, t]
    );

    return (
        <EditorGraphProvider value={editorGraph}>
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
                                variant="outline"
                                disabled={pending || testing}
                                title={t("canvas.testHint")}
                                onClick={() =>
                                    act(async () => {
                                        if (dirty && !(await save())) return;
                                        const answer = await startTestRunAction({ automationId: detail.id });
                                        if (!answer.ok) return void toast.show({ title: answer.error });
                                        setTestRunId(answer.runId);
                                        toast.show({ title: t("canvas.testStarted") });
                                    })
                                }
                            >
                                <FlaskConical aria-hidden="true" />
                                {testing ? t("canvas.testing") : t("canvas.test")}
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
            <div className="flex flex-wrap items-center gap-2">
                {detail.publishedVersion ? (
                    <Badge variant={differs ? "warning" : "success"}>{differs ? t("versions.draftDiffers", { number: detail.publishedVersion.number }) : t("versions.draftSame", { number: detail.publishedVersion.number })}</Badge>
                ) : (
                    <Badge variant="neutral">{t("versions.notPublished")}</Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => setVersionsOpen(true)}>
                    <History aria-hidden="true" />
                    {t("versions.title")}
                </Button>
                {testRun ? (
                    <Link href={`/automations/runs/${testRun.id}`} className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                        <span className="truncate">{t("canvas.lastTest")}</span>
                        <StatusChip status={testRun.status} />
                    </Link>
                ) : null}
                <SegmentedControl
                    className="ml-auto"
                    size="sm"
                    value={view}
                    onValueChange={choose}
                    aria-label={t("canvas.view")}
                    options={[
                        { value: "canvas", label: t("canvas.viewCanvas") },
                        { value: "list", label: t("canvas.viewList"), disabled: !flow, title: !flow ? t("canvas.listUnavailable") : undefined }
                    ]}
                />
            </div>
            {readOnly ? <p className="text-sm text-muted-foreground">{t("editor.readOnly")}</p> : null}
            {!flow ? <p className="text-xs text-muted-foreground">{t("canvas.listUnavailable")}</p> : null}
            {view === "canvas" && !wide && !readOnly ? <p className="text-xs text-muted-foreground">{t("canvas.phoneReadOnly")}</p> : null}

            {view === "canvas" ? (
                <CanvasEditor
                    graph={graph}
                    change={draft.change}
                    undo={draft.undo}
                    redo={draft.redo}
                    readOnly={readOnly || !wide}
                    detail={detail}
                    secrets={secrets}
                    samples={samples}
                    states={states}
                    onChanged={onChanged}
                />
            ) : flow ? (
                <div className="mx-auto w-full max-w-4xl space-y-6">
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
                </div>
            ) : null}

            <div className="mx-auto w-full max-w-4xl space-y-6">
                {readOnly ? null : <Settings detail={detail} onSaved={onChanged} />}
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
            </div>

            <VersionsDialog
                open={versionsOpen}
                onOpenChange={setVersionsOpen}
                automationId={detail.id}
                canRestore={!readOnly}
                onRestored={(restored) => {
                    const laid = core.layoutGraph(restored);
                    draft.change(() => laid, { group: false });
                    setSaved(JSON.stringify(laid));
                    toast.show({ title: t("versions.restored") });
                }}
            />
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
        </EditorGraphProvider>
    );
}

function VersionsDialog({
    open,
    onOpenChange,
    automationId,
    canRestore,
    onRestored
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    automationId: string;
    canRestore: boolean;
    onRestored: (graph: core.AutomationGraph) => void;
}) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const [rows, setRows] = useState<VersionRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const load = useCallback(async () => {
        setError(null);
        const answer = await listVersionsAction(automationId).catch(() => null);
        if (answer?.ok) setRows(answer.rows);
        else setError(answer?.error ?? t("errors.generic"));
    }, [automationId, t]);
    useEffect(() => {
        if (open) void load();
    }, [open, load]);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogTitle>{t("versions.title")}</DialogTitle>
                <DialogDescription>{t("versions.hint")}</DialogDescription>
                {error !== null && !rows ? (
                    <LoadFailed message={error} onRetry={() => void load()} />
                ) : !rows ? (
                    <RowsSkeleton rows={3} />
                ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("versions.empty")}</p>
                ) : (
                    <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                        {rows.map((row) => (
                            <li key={row.id} className="flex min-w-0 items-center gap-3 p-3">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{row.name || t("versions.number", { number: row.number })}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {when(row.createdAt, locale)}
                                        {row.savedBy ? ` - ${t("versions.by", { name: row.savedBy })}` : ""}
                                    </p>
                                </div>
                                {row.live ? <Badge variant="success">{t("versions.live")}</Badge> : null}
                                {canRestore ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy !== null}
                                        onClick={async () => {
                                            setBusy(row.id);
                                            const answer = await restoreVersionAction({ automationId, versionId: row.id }).catch(() => null);
                                            setBusy(null);
                                            if (!answer?.ok) return void toast.show({ title: answer?.error ?? t("errors.generic") });
                                            onRestored(answer.graph);
                                            onOpenChange(false);
                                        }}
                                    >
                                        {t("versions.restore")}
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
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
                    <ReferenceScope nodeId={step.node.id}>
                        <NodeFields node={step.node} setConfig={setConfig} detail={detail} secrets={secrets} onChanged={onChanged} />
                    </ReferenceScope>
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

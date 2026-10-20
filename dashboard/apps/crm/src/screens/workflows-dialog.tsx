"use client";

/**
 * A kind of record's workflows, drawn with the pieces every rule builder in
 * Polaris uses: the list of rules with their switch and last run, the editor
 * that reads as a sentence (when -> if -> then) or as a diagram, and the run
 * log. What a trigger or action asks for is drawn by `workflow-fields`, so a
 * new kind of either only adds its own fields there.
 *
 * The IF of the sentence is the workflow's first step when that step is a
 * filter: the saved shape stays a plain list of actions, and a filter anywhere
 * else is still one of the THEN steps.
 */

import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/workflows";
import { hostUi } from "@polaris/app-host/client";
import type { CrmObject } from "../model/objects";
import { useCallback, useEffect, useState } from "react";
import { recordHref } from "../model/related";
import { WorkflowDiagram } from "./workflow-diagram";
import * as flow from "@polaris/ui/automation";
import * as rules from "@polaris/ui/automation-rules";
import { Filter, History, Layers, Pencil, Play, Plus, Trash2, Workflow, Zap } from "lucide-react";
import { ActionFields, ActionList, TriggerFields, useWorkflowWords } from "./workflow-fields";
import {
    Button,
    Checkbox,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    isDirty,
    SegmentedControl,
    Select,
    useToast
} from "@polaris/ui";
import * as model from "../model/workflows";

export interface WorkflowsDialogProps {
    readonly object: CrmObject;
    readonly open: boolean;
    readonly onClose: () => void;
    readonly confirm: (options: {
        title: string;
        description: string;
        confirmLabel: string;
        danger: boolean;
    }) => Promise<boolean>;
}

/** The workflow being edited: a draft, saved only when the reader says so. */
interface Draft {
    readonly id?: string;
    readonly name: string;
    readonly trigger: model.WorkflowTrigger;
    readonly actions: model.WorkflowAction[];
    readonly enabled: boolean;
    readonly newHookSecret?: boolean;
}

/** How a run reads at a glance. */
const RUN_TONES: Readonly<Record<model.RunStatus, rules.RuleTone>> = {
    running: "active",
    waiting: "active",
    done: "success",
    stopped: "muted",
    failed: "danger",
    cancelled: "muted"
};

/** Where the reader's choice between the sentence and the diagram is kept. */
const LAYOUT_KEY = "crm.workflows.layout";

/** The step the IF of the sentence stands for: a filter put first. */
function leadingFilter(actions: readonly model.WorkflowAction[]): model.WorkflowAction | null {
    const first = actions[0];
    return first && first.kind === "filter" ? first : null;
}

const blank = (): Draft => ({ name: "", trigger: { kind: "created" }, actions: [], enabled: true });

export function WorkflowsDialog(props: WorkflowsDialogProps) {
    const { object, open } = props;
    const t = useCrmT();
    const toast = useToast();
    const words = useWorkflowWords(object);
    const format = hostUi.displayFormat.useDisplayFormat();
    const [rows, setRows] = useState<model.WorkflowView[] | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    /** The saved workflow the draft was opened from; null for a new one. */
    const [loaded, setLoaded] = useState<Draft | null>(null);
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState<{ text: string; copy: string } | null>(null);
    const [options, setOptions] = useState<model.WorkflowOptions>({ taskLists: [], people: [] });
    /** The workflow whose runs are shown, and its runs once read. */
    const [runsOf, setRunsOf] = useState<model.WorkflowView | null>(null);
    const [runs, setRuns] = useState<model.WorkflowRunView[] | null>(null);
    /** The workflow whose saved versions are shown, its versions once read,
     *  and the one whose steps are open. */
    const [versionsOf, setVersionsOf] = useState<model.WorkflowView | null>(null);
    const [versions, setVersions] = useState<model.WorkflowVersionView[] | null>(null);
    const [openVersion, setOpenVersion] = useState<string | null>(null);
    /** The run whose detail is unfolded. */
    const [openRun, setOpenRun] = useState<string | null>(null);
    const [layout, chooseLayout] = flow.useFlowLayout(LAYOUT_KEY);

    const showVersions = (row: model.WorkflowView) => {
        setNotice(null);
        setVersionsOf(row);
        setVersions(null);
        setOpenVersion(null);
        unwrap(
            () => actions.listWorkflowVersionsAction({ object, id: row.id }),
            t("errors.loadFailed")
        )
            .then((answer) => setVersions(answer.versions))
            .catch((caught) => {
                setVersions([]);
                toast.show({ title: t("errors.loadFailed"), body: messageOf(caught) });
            });
    };

    /** Who saved a version, by the name the shelf knows them by. */
    const savedBy = (id: string | null): string | null =>
        (id && options.people.find((person) => person.id === id)?.name) || null;

    const showRuns = (row: model.WorkflowView) => {
        setNotice(null);
        setRunsOf(row);
        setRuns(null);
        setOpenRun(null);
        unwrap(() => actions.listWorkflowRunsAction({ object, id: row.id }), t("errors.loadFailed"))
            .then((answer) => setRuns(answer.runs))
            .catch((caught) => {
                setRuns([]);
                toast.show({ title: t("errors.loadFailed"), body: messageOf(caught) });
            });
    };

    const load = useCallback(() => {
        unwrap(() => actions.listWorkflowsAction({ object }), t("errors.loadFailed"))
            .then((answer) => setRows(answer.workflows))
            .catch((caught) => {
                setRows([]);
                toast.show({ title: t("errors.loadFailed"), body: messageOf(caught) });
            });
    }, [object, t, toast]);

    // Without these the editor offers no task or notification action; nothing
    // else waits on them, so a failure only leaves those two out.
    useEffect(() => {
        if (!open) return;
        let live = true;
        unwrap(() => actions.workflowOptionsAction({ object }), "")
            .then((answer) => live && setOptions(answer))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [open, object]);

    useEffect(() => {
        if (open) load();
        else {
            setDraft(null);
            setNotice(null);
            setRunsOf(null);
            setVersionsOf(null);
        }
    }, [open, load]);

    const toggle = (row: model.WorkflowView, enabled: boolean) => {
        const kept = rows;
        setRows((before) =>
            (before ?? []).map((one) => (one.id === row.id ? { ...one, enabled } : one))
        );
        unwrap(
            () => actions.setWorkflowEnabledAction({ object, id: row.id, enabled }),
            t("errors.generic")
        ).catch((caught) => {
            setRows(kept);
            toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
        });
    };

    const remove = async (row: model.WorkflowView) => {
        const ok = await props.confirm({
            title: t("workflows.deleteTitle", { name: row.name }),
            description: t("workflows.deleteBody"),
            confirmLabel: t("workflows.delete"),
            danger: true
        });
        if (!ok) return;
        const kept = rows;
        setRows((before) => (before ?? []).filter((one) => one.id !== row.id));
        unwrap(
            () => actions.deleteWorkflowAction({ object, id: row.id }),
            t("errors.generic")
        ).catch((caught) => {
            setRows(kept);
            toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
        });
    };

    const save = async () => {
        if (!draft) return;
        setSaving(true);
        try {
            const saved = await unwrap(
                () => actions.saveWorkflowAction({ object, workflow: draft }),
                t("errors.generic")
            );
            setNotice(words.savedNotice(saved));
            setDraft(null);
            setVersionsOf(null);
            load();
        } catch (caught) {
            toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
        } finally {
            setSaving(false);
        }
    };

    const edit = (row: model.WorkflowView) => {
        setNotice(null);
        const opened = {
            id: row.id,
            name: row.name,
            trigger: row.trigger,
            actions: row.actions,
            enabled: row.enabled
        };
        setDraft(opened);
        setLoaded(opened);
    };

    const canSave =
        draft !== null &&
        model.workflowInputSchema.safeParse(draft).success &&
        (loaded === null || isDirty(loaded, draft));

    let body: React.ReactNode;
    if (draft) {
        const lead = leadingFilter(draft.actions);
        const rest = lead ? draft.actions.slice(1) : draft.actions;
        const withLead = (next: model.WorkflowAction | null, list: model.WorkflowAction[]) =>
            setDraft({ ...draft, actions: next ? [next, ...list] : list });
        body = (
            <div className="flex max-h-[60vh] min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain">
                <div className="flex min-w-0 flex-wrap items-end gap-3">
                    <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[0.8125rem] font-medium">
                        {t("workflows.name")}
                        <Input
                            value={draft.name}
                            maxLength={model.WORKFLOW_NAME_MAX}
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        />
                    </label>
                    <SegmentedControl<flow.FlowLayout>
                        size="sm"
                        value={layout}
                        onValueChange={chooseLayout}
                        aria-label={t("workflows.layout")}
                        options={[
                            { value: "form", label: t("workflows.layoutForm") },
                            { value: "visual", label: t("workflows.layoutVisual") }
                        ]}
                    />
                </div>
                {layout === "visual" ? (
                    <WorkflowDiagram
                        object={object}
                        trigger={draft.trigger}
                        actions={draft.actions}
                    />
                ) : (
                    <ol className="flex min-w-0 flex-col">
                        <flow.Stage
                            icon={<Zap className="size-4" />}
                            title={t("workflows.trigger")}
                            hint={t("workflows.whenHint")}
                        >
                            <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3">
                                <Select
                                    aria-label={t("workflows.trigger")}
                                    value={draft.trigger.kind}
                                    onValueChange={(kind) => {
                                        const trigger = words.newTrigger(kind as model.TriggerKind);
                                        setDraft({
                                            ...draft,
                                            trigger,
                                            actions: draft.actions.filter((action) =>
                                                words.actionFits(action.kind, trigger)
                                            )
                                        });
                                    }}
                                    options={model.TRIGGER_KINDS.map((kind) => ({
                                        value: kind,
                                        label: t(`workflows.triggers.${kind}`)
                                    }))}
                                />
                                <TriggerFields
                                    object={object}
                                    trigger={draft.trigger}
                                    onChange={(trigger) => setDraft({ ...draft, trigger })}
                                />
                                {draft.id && draft.trigger.kind === "webhook" ? (
                                    <label className="flex items-center gap-2 text-[0.8125rem]">
                                        <Checkbox
                                            checked={Boolean(draft.newHookSecret)}
                                            onChange={() =>
                                                setDraft({
                                                    ...draft,
                                                    newHookSecret: !draft.newHookSecret
                                                })
                                            }
                                        />
                                        {t("workflows.newAddress")}
                                    </label>
                                ) : null}
                            </div>
                        </flow.Stage>
                        <flow.Stage
                            icon={<Filter className="size-4" />}
                            title={t("workflows.if")}
                            hint={
                                words.actionFits("filter", draft.trigger)
                                    ? t("workflows.ifHint")
                                    : t("workflows.ifNoRecord")
                            }
                        >
                            {lead ? (
                                <flow.NodeCard
                                    kind={
                                        <span className="truncate text-[0.8125rem] font-medium">
                                            {t("workflows.actionKinds.filter")}
                                        </span>
                                    }
                                    removeLabel={t("workflows.removeCondition")}
                                    upLabel={t("workflows.moveUp")}
                                    downLabel={t("workflows.moveDown")}
                                    onRemove={() => withLead(null, rest)}
                                >
                                    <div className="min-w-0 sm:col-span-2">
                                        <ActionFields
                                            object={object}
                                            trigger={draft.trigger}
                                            action={lead}
                                            options={options}
                                            onChange={(next) => withLead(next, rest)}
                                        />
                                    </div>
                                </flow.NodeCard>
                            ) : words.actionFits("filter", draft.trigger) &&
                              draft.actions.length < model.MAX_WORKFLOW_ACTIONS ? (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="self-start border-dashed"
                                    onClick={() =>
                                        withLead(words.newAction("filter", options), rest)
                                    }
                                >
                                    <Plus className="size-4 shrink-0" />
                                    {t("workflows.addCondition")}
                                </Button>
                            ) : null}
                        </flow.Stage>
                        <flow.Stage
                            icon={<Play className="size-4" />}
                            title={t("workflows.actions")}
                            hint={t("workflows.thenHint")}
                            last
                        >
                            <ActionList
                                object={object}
                                trigger={draft.trigger}
                                actions={rest}
                                kinds={model.ACTION_KINDS}
                                options={options}
                                onChange={(list) => withLead(lead, list)}
                            />
                        </flow.Stage>
                    </ol>
                )}
            </div>
        );
    } else if (runsOf) {
        body =
            runs === null ? (
                <p className="text-[0.8125rem] text-muted-foreground">{t("list.loading")}</p>
            ) : runs.length === 0 ? (
                <EmptyState icon={<History />} title={t("workflows.noRuns")} />
            ) : (
                <div className="max-h-[60vh] min-h-0 overflow-y-auto overscroll-contain">
                    <rules.RunList label={t("workflows.runsOf", { name: runsOf.name })}>
                        {runs.map((run) => {
                            const expanded = openRun === run.id;
                            return (
                                <rules.RunRow
                                    key={run.id}
                                    expanded={expanded}
                                    onToggle={() => setOpenRun(expanded ? null : run.id)}
                                    outcome={{
                                        text: t(`workflows.runStatus.${run.status}`),
                                        tone: RUN_TONES[run.status]
                                    }}
                                    cause={t(`workflows.triggers.${model.causeKind(run.cause)}`)}
                                    at={<hostUi.relativeTime.RelativeTime iso={run.startedAt} />}
                                    atTitle={format.dateTime(run.startedAt)}
                                >
                                    <span className="text-xs text-muted-foreground">
                                        {format.dateTime(run.startedAt)}
                                        {run.finishedAt
                                            ? ` - ${format.dateTime(run.finishedAt)}`
                                            : ""}
                                    </span>
                                    {run.status === "waiting" && run.resumeAt ? (
                                        <span className="text-xs text-muted-foreground">
                                            {t("workflows.resumesAt", {
                                                when: format.dateTime(run.resumeAt)
                                            })}
                                        </span>
                                    ) : null}
                                    {run.error ? (
                                        <span className="break-words text-xs text-destructive [overflow-wrap:anywhere]">
                                            {run.error}
                                        </span>
                                    ) : null}
                                    {run.recordId ? (
                                        <a
                                            className="self-start text-xs text-primary hover:underline"
                                            href={recordHref(object, run.recordId)}
                                        >
                                            {t("workflows.openRecord")}
                                        </a>
                                    ) : null}
                                </rules.RunRow>
                            );
                        })}
                    </rules.RunList>
                </div>
            );
    } else if (versionsOf) {
        body = (
            <div className="flex max-h-[60vh] min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                <section className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-[0.8125rem] font-medium">{t("workflows.current")}</span>
                    <WorkflowDiagram
                        object={object}
                        trigger={versionsOf.trigger}
                        actions={versionsOf.actions}
                    />
                </section>
                <section className="flex min-w-0 flex-col gap-1">
                    <span className="text-[0.8125rem] font-medium">
                        {t("workflows.savedVersions")}
                    </span>
                    {versions === null ? (
                        <p className="text-[0.8125rem] text-muted-foreground">
                            {t("list.loading")}
                        </p>
                    ) : versions.length === 0 ? (
                        <p className="text-[0.8125rem] text-muted-foreground">
                            {t("workflows.noVersions")}
                        </p>
                    ) : (
                        <ul className="flex min-w-0 flex-col gap-1">
                            {versions.map((version, index) => {
                                const who = savedBy(version.savedById);
                                const shown = openVersion === version.id;
                                return (
                                    <li
                                        key={version.id}
                                        className="flex min-w-0 flex-col gap-2 rounded-lg px-2 py-2 hover:bg-muted/50"
                                    >
                                        <div className="flex min-w-0 items-center gap-2">
                                            <div className="flex min-w-0 flex-1 flex-col">
                                                <span
                                                    className="truncate text-[0.8125rem] font-medium"
                                                    title={version.name}
                                                >
                                                    {version.name}
                                                    {index === 0 ? (
                                                        <span className="ml-2 font-normal text-muted-foreground">
                                                            {t("workflows.latest")}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                <span className="truncate text-[0.75rem] text-muted-foreground">
                                                    {format.dateTime(version.createdAt)}
                                                    {who
                                                        ? ` - ${t("workflows.savedBy", { name: who })}`
                                                        : ""}
                                                </span>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="shrink-0"
                                                aria-expanded={shown}
                                                onClick={() =>
                                                    setOpenVersion(shown ? null : version.id)
                                                }
                                            >
                                                {shown
                                                    ? t("workflows.hideSteps")
                                                    : t("workflows.showSteps")}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="size-8 shrink-0 p-0"
                                                aria-label={t("workflows.editFrom")}
                                                title={t("workflows.editFrom")}
                                                onClick={() => {
                                                    setNotice(null);
                                                    setDraft({
                                                        id: versionsOf.id,
                                                        name: version.name,
                                                        trigger: version.trigger,
                                                        actions: version.actions,
                                                        enabled: versionsOf.enabled
                                                    });
                                                }}
                                            >
                                                <Pencil className="size-4" />
                                            </Button>
                                        </div>
                                        {shown ? (
                                            <WorkflowDiagram
                                                object={object}
                                                trigger={version.trigger}
                                                actions={version.actions}
                                            />
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        );
    } else if (rows === null) {
        body = <p className="text-[0.8125rem] text-muted-foreground">{t("list.loading")}</p>;
    } else if (rows.length === 0) {
        body = <EmptyState icon={<Workflow />} title={t("workflows.empty")} />;
    } else {
        body = (
            <div className="max-h-[60vh] min-h-0 overflow-y-auto overscroll-contain">
                <rules.RuleList
                    label={t("workflows.title", { objects: t(`objects.${object}.plural`) })}
                >
                    {rows.map((row) => (
                        <rules.RuleRow
                            key={row.id}
                            name={row.name}
                            enabled={row.enabled}
                            onToggle={(enabled) => toggle(row, enabled)}
                            toggleLabel={
                                row.enabled
                                    ? t("workflows.turnOff", { name: row.name })
                                    : t("workflows.turnOn", { name: row.name })
                            }
                            open={({ className, children }) => (
                                <button
                                    type="button"
                                    className={className}
                                    title={t("workflows.edit")}
                                    onClick={() => edit(row)}
                                >
                                    {children}
                                </button>
                            )}
                            summary={
                                <>
                                    {words.triggerSummary(row.trigger)} -{" "}
                                    {t("workflows.runs", { count: row.runCount })}
                                </>
                            }
                            last={
                                row.lastError
                                    ? { text: t("workflows.runStatus.failed"), tone: "danger" }
                                    : row.lastRunAt
                                      ? { text: t("workflows.runStatus.done"), tone: "success" }
                                      : null
                            }
                            lastRun={
                                row.lastRunAt ? (
                                    <span title={format.dateTime(row.lastRunAt)}>
                                        <hostUi.relativeTime.RelativeTime iso={row.lastRunAt} />
                                    </span>
                                ) : null
                            }
                            neverRan={t("workflows.neverRan")}
                            detail={
                                row.lastError ? (
                                    <span className="text-destructive">
                                        {t("workflows.failed", { error: row.lastError })}
                                    </span>
                                ) : row.enabled && row.nextRunAt ? (
                                    <span className="text-muted-foreground">
                                        {t("workflows.nextRun", {
                                            when: format.dateTime(row.nextRunAt)
                                        })}
                                    </span>
                                ) : null
                            }
                            actions={
                                <>
                                    <rules.RuleAction
                                        label={t("workflows.showRuns")}
                                        onClick={() => showRuns(row)}
                                    >
                                        <History className="size-4" />
                                    </rules.RuleAction>
                                    <rules.RuleAction
                                        label={t("workflows.showVersions")}
                                        onClick={() => showVersions(row)}
                                    >
                                        <Layers className="size-4" />
                                    </rules.RuleAction>
                                    <rules.RuleAction
                                        label={t("workflows.delete")}
                                        onClick={() => void remove(row)}
                                    >
                                        <Trash2 className="size-4" />
                                    </rules.RuleAction>
                                </>
                            }
                        />
                    ))}
                </rules.RuleList>
            </div>
        );
    }
    return (
        <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {draft
                            ? draft.id
                                ? t("workflows.edit")
                                : t("workflows.new")
                            : runsOf
                              ? t("workflows.runsOf", { name: runsOf.name })
                              : versionsOf
                                ? t("workflows.versionsOf", { name: versionsOf.name })
                                : t("workflows.title", { objects: t(`objects.${object}.plural`) })}
                    </DialogTitle>
                    <DialogDescription>{t("workflows.hint")}</DialogDescription>
                </DialogHeader>
                {notice ? (
                    <div
                        className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted px-3 py-2 text-[0.8125rem]"
                        role="status"
                    >
                        <span>{notice.text}</span>
                        <span className="flex min-w-0 items-center gap-1">
                            <code className="min-w-0 flex-1 truncate" title={notice.copy}>
                                {notice.copy}
                            </code>
                            <CopyButton value={notice.copy} />
                        </span>
                    </div>
                ) : null}
                {body}
                <DialogFooter>
                    {draft ? (
                        <>
                            <Button
                                variant="ghost"
                                disabled={saving}
                                onClick={() => setDraft(null)}
                            >
                                {t("workflows.cancel")}
                            </Button>
                            <Button
                                disabled={saving || !canSave}
                                aria-disabled={saving || !canSave}
                                onClick={() => void save()}
                            >
                                {t("workflows.save")}
                            </Button>
                        </>
                    ) : runsOf || versionsOf ? (
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setRunsOf(null);
                                setVersionsOf(null);
                            }}
                        >
                            {t("workflows.back")}
                        </Button>
                    ) : (
                        <Button
                            disabled={rows !== null && rows.length >= model.MAX_WORKFLOWS}
                            onClick={() => {
                                setNotice(null);
                                setDraft(blank());
                                setLoaded(null);
                            }}
                        >
                            <Plus className="size-4" />
                            {t("workflows.new")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

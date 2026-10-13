"use client";

/**
 * A kind of record's workflows: the list, each one switched on or off where it
 * stands, and the editor for its trigger and actions. What a trigger or action
 * asks for is drawn by `workflow-fields`, so a new kind of either only adds
 * its own fields there.
 */

import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/workflows";
import { hostUi } from "@polaris/app-host/client";
import type { CrmObject } from "../model/objects";
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Workflow, X } from "lucide-react";
import { ActionFields, TriggerFields, useWorkflowWords } from "./workflow-fields";
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    Select,
    Switch,
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

const blank = (): Draft => ({ name: "", trigger: { kind: "created" }, actions: [], enabled: true });

export function WorkflowsDialog(props: WorkflowsDialogProps) {
    const { object, open } = props;
    const t = useCrmT();
    const toast = useToast();
    const words = useWorkflowWords(object);
    const format = hostUi.displayFormat.useDisplayFormat();
    const [rows, setRows] = useState<model.WorkflowView[] | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState<{ text: string; copy: string } | null>(null);
    const [options, setOptions] = useState<model.WorkflowOptions>({ taskLists: [], people: [] });

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
            .then(({ taskLists, people }) => live && setOptions({ taskLists, people }))
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
            load();
        } catch (caught) {
            toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
        } finally {
            setSaving(false);
        }
    };

    const valid = draft !== null && model.workflowInputSchema.safeParse(draft).success;

    let body: React.ReactNode;
    if (draft) {
        const kinds = model.ACTION_KINDS.filter(
            (kind) => words.actionFits(kind, draft.trigger) && words.actionOffered(kind, options)
        );
        body = (
            <div className="flex min-w-0 flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium">
                    {t("workflows.name")}
                    <Input
                        value={draft.name}
                        maxLength={model.WORKFLOW_NAME_MAX}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                </label>
                <div className="flex flex-col gap-1.5">
                    <span className="text-[0.8125rem] font-medium">{t("workflows.trigger")}</span>
                    <Select
                        aria-label={t("workflows.trigger")}
                        value={draft.trigger.kind}
                        onValueChange={(kind) =>
                            setDraft({
                                ...draft,
                                trigger: words.newTrigger(kind as model.TriggerKind),
                                actions: draft.actions.filter((action) =>
                                    words.actionFits(
                                        action.kind,
                                        words.newTrigger(kind as model.TriggerKind)
                                    )
                                )
                            })
                        }
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
                                    setDraft({ ...draft, newHookSecret: !draft.newHookSecret })
                                }
                            />
                            {t("workflows.newAddress")}
                        </label>
                    ) : null}
                </div>
                <div className="flex flex-col gap-2">
                    <span className="text-[0.8125rem] font-medium">{t("workflows.actions")}</span>
                    {draft.actions.length === 0 ? (
                        <p className="text-[0.8125rem] text-muted-foreground">
                            {t("workflows.noActions")}
                        </p>
                    ) : (
                        <ol className="flex flex-col gap-2">
                            {draft.actions.map((action, index) => (
                                <li
                                    key={index}
                                    className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/50 p-3"
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-[0.8125rem] font-medium">
                                            {index + 1}. {t(`workflows.actionKinds.${action.kind}`)}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="size-7 shrink-0 p-0"
                                            aria-label={t("workflows.removeAction")}
                                            title={t("workflows.removeAction")}
                                            onClick={() =>
                                                setDraft({
                                                    ...draft,
                                                    actions: draft.actions.filter(
                                                        (_, at) => at !== index
                                                    )
                                                })
                                            }
                                        >
                                            <X className="size-3.5" />
                                        </Button>
                                    </div>
                                    <ActionFields
                                        object={object}
                                        trigger={draft.trigger}
                                        action={action}
                                        options={options}
                                        onChange={(next) =>
                                            setDraft({
                                                ...draft,
                                                actions: draft.actions.map((one, at) =>
                                                    at === index ? next : one
                                                )
                                            })
                                        }
                                    />
                                </li>
                            ))}
                        </ol>
                    )}
                    {kinds.length > 0 && draft.actions.length < model.MAX_WORKFLOW_ACTIONS ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="self-start">
                                    <Plus className="size-4" />
                                    {t("workflows.addAction")}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {kinds.map((kind) => (
                                    <DropdownMenuItem
                                        key={kind}
                                        onSelect={() =>
                                            setDraft({
                                                ...draft,
                                                actions: [
                                                    ...draft.actions,
                                                    words.newAction(kind, options)
                                                ]
                                            })
                                        }
                                    >
                                        {t(`workflows.actionKinds.${kind}`)}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                </div>
            </div>
        );
    } else if (rows === null) {
        body = <p className="text-[0.8125rem] text-muted-foreground">{t("list.loading")}</p>;
    } else if (rows.length === 0) {
        body = <EmptyState icon={<Workflow />} title={t("workflows.empty")} />;
    } else {
        body = (
            <ul className="flex max-h-[60vh] min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
                {rows.map((row) => (
                    <li
                        key={row.id}
                        className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
                    >
                        <Switch
                            checked={row.enabled}
                            onChange={(enabled) => toggle(row, enabled)}
                            aria-label={t("workflows.enabled")}
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium" title={row.name}>
                                {row.name}
                            </span>
                            <span className="truncate text-[0.75rem] text-muted-foreground">
                                {words.triggerSummary(row.trigger)} -{" "}
                                {t("workflows.runs", { count: row.runCount })}
                                {row.enabled && row.nextRunAt ? (
                                    <>
                                        {" - "}
                                        {t("workflows.nextRun", {
                                            when: format.dateTime(row.nextRunAt)
                                        })}
                                    </>
                                ) : null}
                                {row.lastRunAt ? (
                                    <>
                                        {" - "}
                                        <hostUi.relativeTime.RelativeTime iso={row.lastRunAt} />
                                    </>
                                ) : null}
                            </span>
                            {row.lastError ? (
                                <span className="break-words text-[0.75rem] text-destructive">
                                    {t("workflows.failed", { error: row.lastError })}
                                </span>
                            ) : null}
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="size-8 shrink-0 p-0"
                            aria-label={t("workflows.edit")}
                            title={t("workflows.edit")}
                            onClick={() => {
                                setNotice(null);
                                setDraft({
                                    id: row.id,
                                    name: row.name,
                                    trigger: row.trigger,
                                    actions: row.actions,
                                    enabled: row.enabled
                                });
                            }}
                        >
                            <Pencil className="size-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="size-8 shrink-0 p-0"
                            aria-label={t("workflows.delete")}
                            title={t("workflows.delete")}
                            onClick={() => void remove(row)}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </li>
                ))}
            </ul>
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
                                disabled={saving || !valid}
                                aria-disabled={saving || !valid}
                                onClick={() => void save()}
                            >
                                {t("workflows.save")}
                            </Button>
                        </>
                    ) : (
                        <Button
                            disabled={rows !== null && rows.length >= model.MAX_WORKFLOWS}
                            onClick={() => {
                                setNotice(null);
                                setDraft(blank());
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

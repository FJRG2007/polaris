"use client";

/**
 * Rules and intake forms: the two ways work reaches a list without a person
 * typing it there.
 *
 * A rule reads as one sentence - when this happens, to tasks like this, do that -
 * and is built with the same filter editor a saved view uses, so what a rule
 * will act on is something the reader can already check by looking at a view.
 */

import { useState } from "react";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { FilterBar } from "./filter-bar";
import { runAction } from "@/lib/run-action";
import { optionLabel } from "./option-label";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Avatar } from "@/components/avatar";
import { Plus, Trash2, Zap } from "lucide-react";
import type { PersonRef } from "@/lib/tasks/facts";
import { CopyButton } from "@/components/copy-button";
import type { FormView } from "@/lib/tasks/form-service";
import type { AutomationView } from "@/lib/tasks/automation-service";
import { Button, Card, CardBody, Input, Select, Switch, cn } from "@polaris/ui";
import type { CustomFieldView, StatusView, TagView } from "@/lib/tasks/space-service";

interface RuleContext {
    readonly spaceId: string;
    readonly statuses: readonly StatusView[];
    readonly tags: readonly TagView[];
    readonly fields: readonly CustomFieldView[];
    readonly people: readonly PersonRef[];
    readonly lists: readonly { id: string; name: string }[];
}

/** The ids an action can point at, per action type. */
function targetsFor(
    t: NamespaceTranslator<"tasks">,
    type: core.AutomationActionType,
    context: RuleContext
): { value: string; label: string; icon?: React.ReactNode }[] | null {
    switch (type) {
        case "setStatus":
            return context.statuses.map((status) => ({ value: status.id, label: status.name }));
        case "setPriority":
            return core.TASK_PRIORITIES.map((priority) => ({
                value: priority,
                label: optionLabel(t, "priority", priority)
            }));
        case "addAssignee":
        case "removeAssignee":
        case "addWatcher":
            return context.people.map((person) => ({
                value: person.id,
                label: person.name,
                icon: <Avatar person={person} size={16} />
            }));
        case "addTag":
        case "removeTag":
            return context.tags.map((tag) => ({ value: tag.id, label: tag.name }));
        case "moveToList":
            return context.lists.map((list) => ({ value: list.id, label: list.name }));
        default:
            return null;
    }
}

/** A rule being written or edited. */
interface RuleDraft {
    name: string;
    trigger: core.AutomationTrigger;
    listId: string | null;
    conditions: core.TaskFilter;
    actions: core.AutomationAction[];
}

const BLANK_RULE: RuleDraft = {
    name: "",
    trigger: "task.statusChanged",
    listId: null,
    conditions: core.EMPTY_FILTER,
    actions: [{ type: "setPriority", targetId: "high" }]
};

function RuleEditor({
    draft,
    context,
    onChange,
    onSave,
    onCancel,
    error
}: {
    draft: RuleDraft;
    context: RuleContext;
    onChange: (draft: RuleDraft) => void;
    onSave: () => void;
    onCancel: () => void;
    error: string;
}) {
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3 p-4">
                <Input
                    value={draft.name}
                    placeholder={t("automations.namePlaceholder")}
                    aria-label={t("automations.name")}
                    onChange={(event) => onChange({ ...draft, name: event.target.value })}
                    className="h-8 text-sm"
                />

                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("automations.when")}</span>
                    <Select
                        value={draft.trigger}
                        onValueChange={(trigger) => onChange({ ...draft, trigger: trigger as core.AutomationTrigger })}
                        options={core.AUTOMATION_TRIGGERS.map((trigger) => ({
                            value: trigger,
                            label: optionLabel(t, "automationTrigger", trigger)
                        }))}
                        aria-label={t("automations.trigger")}
                        className="h-8 w-56 text-xs"
                    />
                    <span>{t("automations.in")}</span>
                    <Select
                        value={draft.listId ?? ""}
                        onValueChange={(listId) => onChange({ ...draft, listId: listId || null })}
                        options={[
                            { value: "", label: t("automations.everyList") },
                            ...context.lists.map((list) => ({ value: list.id, label: list.name }))
                        ]}
                        aria-label={t("automations.whichLists")}
                        className="h-8 w-48 text-xs"
                    />
                </div>

                <div>
                    <p className="mb-1 text-xs text-muted-foreground">{t("automations.onlyMatching")}</p>
                    <FilterBar
                        filter={draft.conditions}
                        onChange={(conditions) => onChange({ ...draft, conditions })}
                        context={context}
                    />
                </div>

                <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">{t("automations.then")}</p>
                    {draft.actions.map((action, index) => {
                        const targets = targetsFor(t, action.type, context);
                        return (
                            <div key={index} className="flex flex-wrap items-center gap-2">
                                <Select
                                    value={action.type}
                                    onValueChange={(type) =>
                                        onChange({
                                            ...draft,
                                            actions: draft.actions.map((entry, position) =>
                                                position === index
                                                    ? { type: type as core.AutomationActionType }
                                                    : entry
                                            )
                                        })
                                    }
                                    options={core.AUTOMATION_ACTIONS.map((type) => ({
                                        value: type,
                                        label: optionLabel(t, "automationAction", type)
                                    }))}
                                    aria-label={t("automations.action")}
                                    className="h-8 w-44 text-xs"
                                />

                                {targets && (
                                    <Select
                                        value={action.targetId ?? ""}
                                        onValueChange={(targetId) =>
                                            onChange({
                                                ...draft,
                                                actions: draft.actions.map((entry, position) =>
                                                    position === index ? { ...entry, targetId } : entry
                                                )
                                            })
                                        }
                                        options={targets}
                                        placeholder={t("automations.pickOne")}
                                        aria-label={t("automations.target")}
                                        className="h-8 w-44 text-xs"
                                    />
                                )}

                                {(action.type === "addComment" || action.type === "createSubtask") && (
                                    <Input
                                        value={action.text ?? ""}
                                        placeholder={
                                            action.type === "addComment"
                                                ? t("automations.commentText")
                                                : t("automations.subtaskName")
                                        }
                                        aria-label={t("automations.text")}
                                        onChange={(event) =>
                                            onChange({
                                                ...draft,
                                                actions: draft.actions.map((entry, position) =>
                                                    position === index ? { ...entry, text: event.target.value } : entry
                                                )
                                            })
                                        }
                                        className="h-8 w-56 text-xs"
                                    />
                                )}

                                {action.type === "setDueDate" && (
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <Input
                                            type="number"
                                            value={action.offsetDays ?? 0}
                                            aria-label={t("automations.daysFromNow")}
                                            onChange={(event) =>
                                                onChange({
                                                    ...draft,
                                                    actions: draft.actions.map((entry, position) =>
                                                        position === index
                                                            ? { ...entry, offsetDays: Number(event.target.value) }
                                                            : entry
                                                    )
                                                })
                                            }
                                            className="h-8 w-20 text-xs"
                                        />
                                        {t("automations.daysHint")}
                                    </div>
                                )}

                                <button
                                    type="button"
                                    aria-label={t("automations.removeThisAction")}
                                    title={t("automations.removeAction")}
                                    onClick={() =>
                                        onChange({
                                            ...draft,
                                            actions: draft.actions.filter((_, position) => position !== index)
                                        })
                                    }
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </div>
                        );
                    })}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                            onChange({ ...draft, actions: [...draft.actions, { type: "addTag" }] })
                        }
                    >
                        <Plus className="size-3.5" /> {t("automations.action")}
                    </Button>
                </div>

                {error && <p className="text-xs text-danger">{error}</p>}

                <div className="flex gap-2">
                    <Button size="sm" onClick={onSave} disabled={!draft.name.trim() || draft.actions.length === 0}>
                        {t("automations.saveRule")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        {tc("actions.cancel")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

export function AutomationsPanel({
    automations,
    context
}: {
    automations: readonly AutomationView[];
    context: RuleContext;
}) {
    const t = useTranslations("tasks");
    const [draft, setDraft] = useState<RuleDraft | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [error, setError] = useState("");

    const save = async () => {
        if (!draft) return;
        setError("");
        const payload = { ...draft, spaceId: context.spaceId, enabled: true };
        const result = await runAction(
            () =>
                editingId
                    ? actions.updateAutomationAction(context.spaceId, editingId, payload)
                    : actions.createAutomationAction(payload),
            setError
        );
        if (result?.error) setError(result.error);
        else {
            setDraft(null);
            setEditingId(null);
        }
    };

    return (
        <section className="flex flex-col gap-3">
            <header className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-medium">{t("automations.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("automations.hint")}</p>
                </div>
                {!draft && (
                    <Button size="sm" onClick={() => setDraft(BLANK_RULE)}>
                        <Plus className="size-3.5" /> {t("automations.rule")}
                    </Button>
                )}
            </header>

            {draft && (
                <RuleEditor
                    draft={draft}
                    context={context}
                    error={error}
                    onChange={setDraft}
                    onSave={save}
                    onCancel={() => {
                        setDraft(null);
                        setEditingId(null);
                    }}
                />
            )}

            {automations.length === 0 && !draft && (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    {t("automations.empty")}
                </p>
            )}

            <ul className="flex flex-col gap-2">
                {automations.map((rule) => (
                    <li key={rule.id}>
                        <Card>
                            <CardBody className="flex flex-wrap items-center gap-3 p-3">
                                <Zap className={cn("size-4", rule.enabled ? "text-primary" : "text-muted-foreground")} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{rule.name}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {optionLabel(t, "automationTrigger", rule.trigger)} -{" "}
                                        {rule.actions.map((action) => optionLabel(t, "automationAction", action.type)).join(", ")}
                                        {rule.runCount > 0 ? t("automations.ran", { count: rule.runCount }) : ""}
                                    </p>
                                </div>
                                <Switch
                                    checked={rule.enabled}
                                    aria-label={t("automations.enable", { name: rule.name })}
                                    onChange={async (enabled) => {
                                        await runAction(
                                            () => actions.setAutomationEnabledAction(context.spaceId, rule.id, enabled),
                                            setError
                                        );
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        setEditingId(rule.id);
                                        setDraft({
                                            name: rule.name,
                                            trigger: rule.trigger,
                                            listId: rule.listId,
                                            conditions: rule.conditions,
                                            actions: [...rule.actions]
                                        });
                                    }}
                                    className="rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
                                >
                                    {t("trackers.edit")}
                                </button>
                                <button
                                    type="button"
                                    aria-label={t("automations.deleteNamed", { name: rule.name })}
                                    title={t("automations.deleteRule")}
                                    onClick={async () => {
                                        await runAction(
                                            () => actions.deleteAutomationAction(context.spaceId, rule.id),
                                            setError
                                        );
                                    }}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </CardBody>
                        </Card>
                    </li>
                ))}
            </ul>
        </section>
    );
}

// ---------------------------------------------------------------------------
// Intake forms
// ---------------------------------------------------------------------------

export function FormsPanel({
    forms,
    spaceId,
    lists,
    baseUrl
}: {
    forms: readonly FormView[];
    spaceId: string;
    lists: readonly { id: string; name: string }[];
    /** The address Polaris hands out, so the link shown is the one to send. */
    baseUrl: string;
}) {
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [listId, setListId] = useState(lists[0]?.id ?? "");
    const [error, setError] = useState("");

    return (
        <section className="flex flex-col gap-3">
            <header className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-medium">{t("forms.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("forms.hint")}</p>
                </div>
                {!creating && lists.length > 0 && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-3.5" /> {t("create.kind.form")}
                    </Button>
                )}
            </header>

            {creating && (
                <Card>
                    <CardBody className="flex flex-col gap-2 p-4">
                        <Input
                            value={name}
                            placeholder={t("forms.namePlaceholder")}
                            aria-label={t("forms.name")}
                            onChange={(event) => setName(event.target.value)}
                            className="h-8 text-sm"
                        />
                        <Select
                            value={listId}
                            onValueChange={setListId}
                            options={lists.map((list) => ({ value: list.id, label: list.name }))}
                            aria-label={t("forms.list")}
                            className="h-8 text-xs"
                        />
                        <p className="text-xs text-muted-foreground">
                            {t("forms.startsWith")}
                        </p>
                        {error && <p className="text-xs text-danger">{error}</p>}
                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                disabled={!name.trim() || !listId}
                                onClick={async () => {
                                    setError("");
                                    const result = await runAction(
                                        () =>
                                            actions.createFormAction(spaceId, {
                                                listId,
                                                name: name.trim(),
                                                fields: [
                                                    {
                                                        id: "title",
                                                        label: t("forms.defaultTitle"),
                                                        type: "text",
                                                        required: true,
                                                        options: [],
                                                        mapsTo: "name"
                                                    },
                                                    {
                                                        id: "detail",
                                                        label: t("forms.defaultDetail"),
                                                        type: "longText",
                                                        required: false,
                                                        options: [],
                                                        mapsTo: "description"
                                                    }
                                                ]
                                            }),
                                        setError
                                    );
                                    if (result?.error) setError(result.error);
                                    else {
                                        setCreating(false);
                                        setName("");
                                    }
                                }}
                            >
                                {t("forms.create")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                                {tc("actions.cancel")}
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            )}

            {forms.length === 0 && !creating && (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    {t("forms.empty")}
                </p>
            )}

            <ul className="flex flex-col gap-2">
                {forms.map((form) => {
                    const url = `${baseUrl}/forms/${form.token}`;
                    return (
                        <li key={form.id}>
                            <Card>
                                <CardBody className="flex flex-wrap items-center gap-3 p-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{form.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {t("forms.filesInto", { list: form.listName, count: form.submissionCount })}
                                        </p>
                                    </div>
                                    <code className="hidden max-w-64 truncate rounded bg-muted px-2 py-1 text-[0.6875rem] md:block">
                                        {url}
                                    </code>
                                    <CopyButton value={url} label={t("forms.copyLink")} />
                                    <button
                                        type="button"
                                        aria-label={t("automations.deleteNamed", { name: form.name })}
                                        title={t("forms.delete")}
                                        onClick={async () => {
                                            await runAction(() => actions.deleteFormAction(spaceId, form.id), setError);
                                        }}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </CardBody>
                            </Card>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

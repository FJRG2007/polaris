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
    type: core.AutomationActionType,
    context: RuleContext
): { value: string; label: string; icon?: React.ReactNode }[] | null {
    switch (type) {
        case "setStatus":
            return context.statuses.map((status) => ({ value: status.id, label: status.name }));
        case "setPriority":
            return core.TASK_PRIORITIES.map((priority) => ({
                value: priority,
                label: core.TASK_PRIORITY_LABELS[priority]
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
    return (
        <Card>
            <CardBody className="flex flex-col gap-3 p-4">
                <Input
                    value={draft.name}
                    placeholder="What this rule is for"
                    aria-label="Rule name"
                    onChange={(event) => onChange({ ...draft, name: event.target.value })}
                    className="h-8 text-sm"
                />

                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>When</span>
                    <Select
                        value={draft.trigger}
                        onValueChange={(trigger) => onChange({ ...draft, trigger: trigger as core.AutomationTrigger })}
                        options={core.AUTOMATION_TRIGGERS.map((trigger) => ({
                            value: trigger,
                            label: core.AUTOMATION_TRIGGER_LABELS[trigger]
                        }))}
                        aria-label="Trigger"
                        className="h-8 w-56 text-xs"
                    />
                    <span>in</span>
                    <Select
                        value={draft.listId ?? ""}
                        onValueChange={(listId) => onChange({ ...draft, listId: listId || null })}
                        options={[
                            { value: "", label: "Every list in the space" },
                            ...context.lists.map((list) => ({ value: list.id, label: list.name }))
                        ]}
                        aria-label="Which lists"
                        className="h-8 w-48 text-xs"
                    />
                </div>

                <div>
                    <p className="mb-1 text-xs text-muted-foreground">Only for tasks matching</p>
                    <FilterBar
                        filter={draft.conditions}
                        onChange={(conditions) => onChange({ ...draft, conditions })}
                        context={context}
                    />
                </div>

                <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">Then</p>
                    {draft.actions.map((action, index) => {
                        const targets = targetsFor(action.type, context);
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
                                        label: core.AUTOMATION_ACTION_LABELS[type]
                                    }))}
                                    aria-label="Action"
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
                                        placeholder="Pick one"
                                        aria-label="Target"
                                        className="h-8 w-44 text-xs"
                                    />
                                )}

                                {(action.type === "addComment" || action.type === "createSubtask") && (
                                    <Input
                                        value={action.text ?? ""}
                                        placeholder={action.type === "addComment" ? "Comment text" : "Subtask name"}
                                        aria-label="Text"
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
                                            aria-label="Days from now"
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
                                        days from when the rule runs
                                    </div>
                                )}

                                <button
                                    type="button"
                                    aria-label="Remove this action"
                                    title="Remove action"
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
                        <Plus className="size-3.5" /> Action
                    </Button>
                </div>

                {error && <p className="text-xs text-danger">{error}</p>}

                <div className="flex gap-2">
                    <Button size="sm" onClick={onSave} disabled={!draft.name.trim() || draft.actions.length === 0}>
                        Save rule
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        Cancel
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
                    <h2 className="text-sm font-medium">Automations</h2>
                    <p className="text-xs text-muted-foreground">
                        Rules run once per event. A rule&apos;s own changes never set off another rule.
                    </p>
                </div>
                {!draft && (
                    <Button size="sm" onClick={() => setDraft(BLANK_RULE)}>
                        <Plus className="size-3.5" /> Rule
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
                    No rules yet. A common first one: when a task is completed, remove the &ldquo;in review&rdquo; tag.
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
                                        {core.AUTOMATION_TRIGGER_LABELS[rule.trigger]} -{" "}
                                        {rule.actions.map((action) => core.AUTOMATION_ACTION_LABELS[action.type]).join(", ")}
                                        {rule.runCount > 0 ? ` - ran ${rule.runCount} times` : ""}
                                    </p>
                                </div>
                                <Switch
                                    checked={rule.enabled}
                                    aria-label={`Enable ${rule.name}`}
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
                                    Edit
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Delete ${rule.name}`}
                                    title="Delete rule"
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
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [listId, setListId] = useState(lists[0]?.id ?? "");
    const [error, setError] = useState("");

    return (
        <section className="flex flex-col gap-3">
            <header className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-medium">Intake forms</h2>
                    <p className="text-xs text-muted-foreground">
                        A public page that files what it collects as a task. Anyone with the link can send one.
                    </p>
                </div>
                {!creating && lists.length > 0 && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-3.5" /> Form
                    </Button>
                )}
            </header>

            {creating && (
                <Card>
                    <CardBody className="flex flex-col gap-2 p-4">
                        <Input
                            value={name}
                            placeholder="Form name, e.g. Bug report"
                            aria-label="Form name"
                            onChange={(event) => setName(event.target.value)}
                            className="h-8 text-sm"
                        />
                        <Select
                            value={listId}
                            onValueChange={setListId}
                            options={lists.map((list) => ({ value: list.id, label: list.name }))}
                            aria-label="Which list submissions land in"
                            className="h-8 text-xs"
                        />
                        <p className="text-xs text-muted-foreground">
                            It starts with two questions - a title and a description - which you can change afterwards.
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
                                                        label: "What is it?",
                                                        type: "text",
                                                        required: true,
                                                        options: [],
                                                        mapsTo: "name"
                                                    },
                                                    {
                                                        id: "detail",
                                                        label: "Tell us more",
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
                                Create form
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                                Cancel
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            )}

            {forms.length === 0 && !creating && (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    No forms yet.
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
                                            Files into {form.listName} - {form.submissionCount}{" "}
                                            {form.submissionCount === 1 ? "submission" : "submissions"}
                                        </p>
                                    </div>
                                    <code className="hidden max-w-64 truncate rounded bg-muted px-2 py-1 text-[0.6875rem] md:block">
                                        {url}
                                    </code>
                                    <CopyButton value={url} label="Copy the form link" />
                                    <button
                                        type="button"
                                        aria-label={`Delete ${form.name}`}
                                        title="Delete form"
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

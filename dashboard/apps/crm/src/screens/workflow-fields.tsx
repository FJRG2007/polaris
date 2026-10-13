"use client";

/**
 * What each kind of trigger and action asks for in the workflow editor, and
 * the words the list says about each. One place per kind, so a new trigger or
 * action adds its fields here and nowhere else.
 */

import { useCrmT } from "./i18n";
import { hostUi } from "@polaris/app-host/client";
import { Plus, X } from "lucide-react";
import * as model from "../model/workflows";
import { FilterButton } from "./filter-panel";
import { EMPTY_FILTER } from "../model/filters";
import {
    Button,
    Checkbox,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    Select,
    Textarea
} from "@polaris/ui";
import { fieldLabel, optionLabel, useCustomFields } from "./custom-fields";
import {
    CRM_OBJECTS,
    fieldsOf,
    primaryField,
    type CrmObject,
    type FieldDef
} from "../model/objects";

/** The fields an action may write on a kind of record. A kind other than the
 *  list's is offered its built-in fields only. */
function useWritable(object: CrmObject, target: CrmObject): readonly FieldDef[] {
    const custom = useCustomFields();
    return fieldsOf(target, target === object ? custom : []).filter((field) => !field.readOnly);
}

export interface TriggerFieldsProps {
    readonly object: CrmObject;
    readonly trigger: model.WorkflowTrigger;
    readonly onChange: (trigger: model.WorkflowTrigger) => void;
}

/** The settings of a trigger beyond its kind. */
export function TriggerFields({ object, trigger, onChange }: TriggerFieldsProps) {
    const t = useCrmT();
    const custom = useCustomFields();
    if (trigger.kind === "schedule")
        return <ScheduleFields trigger={trigger} onChange={onChange} />;
    if (trigger.kind === "webhook") {
        return (
            <p className="text-[0.75rem] text-muted-foreground">
                {t("workflows.webhookHint", { example: "{{body.email}}" })}
            </p>
        );
    }
    if (trigger.kind !== "fieldChanged") return null;
    const fields = fieldsOf(object, custom);
    const field = fields.find((one) => one.key === trigger.field);
    return (
        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row">
            <div className="min-w-0 sm:flex-1">
                <Select
                    aria-label={t("workflows.changeField")}
                    value={trigger.field}
                    onValueChange={(key) => onChange({ ...trigger, field: key, to: null })}
                    options={fields.map((one) => ({
                        value: one.key,
                        label: fieldLabel(t, object, one)
                    }))}
                />
            </div>
            <div className="min-w-0 sm:flex-1">
                {field?.kind === "select" || field?.kind === "boolean" ? (
                    <Select
                        aria-label={t("workflows.changeTo")}
                        value={trigger.to ?? ANY}
                        onValueChange={(value) =>
                            onChange({ ...trigger, to: value === ANY ? null : value })
                        }
                        options={[
                            { value: ANY, label: t("workflows.anyValue") },
                            ...(field.kind === "boolean"
                                ? [
                                      { value: "true", label: t("values.yes") },
                                      { value: "false", label: t("values.no") }
                                  ]
                                : (field.options ?? []).map((option) => ({
                                      value: option,
                                      label: optionLabel(t, object, field, option)
                                  })))
                        ]}
                    />
                ) : (
                    <Input
                        aria-label={t("workflows.changeTo")}
                        placeholder={t("workflows.anyValue")}
                        value={trigger.to ?? ""}
                        maxLength={model.ACTION_TEXT_MAX}
                        onChange={(event) =>
                            onChange({ ...trigger, to: event.target.value || null })
                        }
                    />
                )}
            </div>
        </div>
    );
}

/** A schedule: the cron expression, when it would next run, in which zone. */
function ScheduleFields({
    trigger,
    onChange
}: {
    trigger: Extract<model.WorkflowTrigger, { kind: "schedule" }>;
    onChange: (trigger: model.WorkflowTrigger) => void;
}) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const valid = model.isCron(trigger.cron);
    const next = valid ? model.nextScheduledRun(trigger, new Date()) : null;
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <Input
                aria-label={t("workflows.schedule")}
                aria-invalid={trigger.cron !== "" && !valid}
                className="font-mono"
                value={trigger.cron}
                maxLength={120}
                onChange={(event) => onChange({ ...trigger, cron: event.target.value })}
            />
            {trigger.cron !== "" && !valid ? (
                <p className="text-[0.75rem] text-destructive">{t("workflows.badSchedule")}</p>
            ) : (
                <p className="text-[0.75rem] text-muted-foreground">
                    {t("workflows.scheduleHint")}
                </p>
            )}
            <p className="break-words text-[0.75rem] text-muted-foreground">
                {next ? `${t("workflows.nextRun", { when: format.dateTime(next) })} - ` : null}
                {t("workflows.timeZone", { zone: trigger.timeZone })}
            </p>
        </div>
    );
}

/** The "any value" choice of a value select. */
const ANY = "__any";

export interface ActionFieldsProps {
    readonly object: CrmObject;
    readonly trigger: model.WorkflowTrigger;
    readonly action: model.WorkflowAction;
    readonly options: model.WorkflowOptions;
    readonly onChange: (action: model.WorkflowAction) => void;
}

/** The days ahead a task may be set to fall due, offered in the editor. */
const DUE_CHOICES = [0, 1, 2, 3, 5, 7, 14, 30, 60, 90];
const NO_DUE = "none";

/** The settings of one action. */
export function ActionFields({ object, trigger, action, options, onChange }: ActionFieldsProps) {
    const t = useCrmT();
    switch (action.kind) {
        case "createTask": {
            const days = DUE_CHOICES.includes(action.dueInDays ?? -1)
                ? DUE_CHOICES
                : [...DUE_CHOICES, action.dueInDays ?? 0].sort((a, b) => a - b);
            return (
                <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row">
                        <div className="min-w-0 sm:flex-1">
                            <Select
                                aria-label={t("workflows.taskList")}
                                value={action.listId}
                                onValueChange={(listId) => onChange({ ...action, listId })}
                                options={options.taskLists.map((list) => ({
                                    value: list.id,
                                    label: `${list.name} - ${list.spaceName}`
                                }))}
                            />
                        </div>
                        <div className="min-w-0 sm:w-44">
                            <Select
                                aria-label={t("workflows.dueIn")}
                                value={
                                    action.dueInDays === null ? NO_DUE : String(action.dueInDays)
                                }
                                onValueChange={(next) =>
                                    onChange({
                                        ...action,
                                        dueInDays: next === NO_DUE ? null : Number(next)
                                    })
                                }
                                options={[
                                    { value: NO_DUE, label: t("workflows.noDue") },
                                    ...days.map((count) => ({
                                        value: String(count),
                                        label: t("workflows.dueDays", { count })
                                    }))
                                ]}
                            />
                        </div>
                    </div>
                    <Input
                        aria-label={t("workflows.taskName")}
                        placeholder={t("workflows.taskName")}
                        value={action.name}
                        maxLength={model.ACTION_TEXT_MAX}
                        onChange={(event) => onChange({ ...action, name: event.target.value })}
                    />
                    <TemplateHint object={object} />
                </div>
            );
        }
        case "httpRequest": {
            const bad = action.url.trim() !== "" && !model.isHttpAddress(action.url.trim());
            return (
                <div className="flex min-w-0 flex-col gap-1">
                    <Input
                        aria-label={t("workflows.requestUrl")}
                        placeholder="https://"
                        type="url"
                        inputMode="url"
                        value={action.url}
                        maxLength={model.REQUEST_URL_MAX}
                        aria-invalid={bad || undefined}
                        onChange={(event) => onChange({ ...action, url: event.target.value })}
                    />
                    <p
                        className={
                            bad
                                ? "text-[0.75rem] text-destructive"
                                : "text-[0.75rem] text-muted-foreground"
                        }
                    >
                        {bad ? t("workflows.requestBadUrl") : t("workflows.requestHint")}
                    </p>
                </div>
            );
        }
        case "sendEmail":
            return (
                <div className="flex min-w-0 flex-col gap-2">
                    <Input
                        aria-label={t("workflows.emailTo")}
                        placeholder={t("workflows.emailToHint", { example: "{{email}}" })}
                        value={action.to}
                        maxLength={model.EMAIL_TO_MAX}
                        onChange={(event) => onChange({ ...action, to: event.target.value })}
                    />
                    <Input
                        aria-label={t("workflows.emailSubject")}
                        placeholder={t("workflows.emailSubject")}
                        value={action.subject}
                        maxLength={model.EMAIL_SUBJECT_MAX}
                        onChange={(event) => onChange({ ...action, subject: event.target.value })}
                    />
                    <Textarea
                        aria-label={t("workflows.notifyBody")}
                        placeholder={t("workflows.notifyBody")}
                        rows={4}
                        value={action.body}
                        maxLength={model.ACTION_TEXT_MAX}
                        onChange={(event) => onChange({ ...action, body: event.target.value })}
                    />
                    <TemplateHint object={object} />
                </div>
            );
        case "notify":
            return (
                <NotifyFields
                    object={object}
                    trigger={trigger}
                    action={action}
                    options={options}
                    onChange={onChange}
                />
            );
        case "updateRecord":
            return (
                <ValuesEditor
                    object={object}
                    target={object}
                    values={action.values}
                    onChange={(values) => onChange({ ...action, values })}
                />
            );
        case "createRecord":
            return (
                <div className="flex min-w-0 flex-col gap-2">
                    <Select
                        aria-label={t("workflows.recordKind")}
                        value={action.object}
                        onValueChange={(target) =>
                            onChange({
                                ...action,
                                object: target as CrmObject,
                                values: { [primaryField(target as CrmObject).key]: "" }
                            })
                        }
                        options={CRM_OBJECTS.map((one) => ({
                            value: one,
                            label: t(`objects.${one}.plural`)
                        }))}
                    />
                    <ValuesEditor
                        object={object}
                        target={action.object}
                        values={action.values}
                        onChange={(values) => onChange({ ...action, values })}
                    />
                </div>
            );
        case "filter":
            return (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <FilterButton
                        object={object}
                        filter={action.when}
                        people={options.people}
                        onChange={(when) => onChange({ ...action, when })}
                    />
                    <span className="text-[0.75rem] text-muted-foreground">
                        {t("workflows.filterHint")}
                    </span>
                </div>
            );
        case "ifElse":
            return (
                <div className="flex min-w-0 flex-col gap-2">
                    <FilterButton
                        object={object}
                        filter={action.when}
                        people={options.people}
                        onChange={(when) => onChange({ ...action, when })}
                    />
                    <span className="text-[0.75rem] font-medium">{t("workflows.then")}</span>
                    <ActionList
                        object={object}
                        trigger={trigger}
                        actions={action.then}
                        kinds={model.LEAF_KINDS}
                        options={options}
                        onChange={(then) =>
                            onChange({ ...action, then: then as model.LeafAction[] })
                        }
                    />
                    <span className="text-[0.75rem] font-medium">{t("workflows.otherwise")}</span>
                    <ActionList
                        object={object}
                        trigger={trigger}
                        actions={action.otherwise}
                        kinds={model.LEAF_KINDS}
                        options={options}
                        onChange={(otherwise) =>
                            onChange({ ...action, otherwise: otherwise as model.LeafAction[] })
                        }
                    />
                </div>
            );
        case "forEach":
            return (
                <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <FilterButton
                            object={object}
                            filter={action.where}
                            people={options.people}
                            onChange={(where) => onChange({ ...action, where })}
                        />
                        <Select
                            aria-label={t("workflows.foundLimit")}
                            value={String(action.limit)}
                            onValueChange={(limit) => onChange({ ...action, limit: Number(limit) })}
                            options={FOUND_CHOICES.map((count) => ({
                                value: String(count),
                                label: t("workflows.foundUpTo", { count })
                            }))}
                        />
                    </div>
                    <span className="text-[0.75rem] font-medium">
                        {t("workflows.forEachFound")}
                    </span>
                    <ActionList
                        object={object}
                        trigger={{ kind: "manual" }}
                        actions={action.actions}
                        kinds={model.LEAF_KINDS}
                        options={options}
                        onChange={(list) =>
                            onChange({ ...action, actions: list as model.LeafAction[] })
                        }
                    />
                </div>
            );
    }
}

/** How many records a "for each record found" may go through, offered. */
const FOUND_CHOICES = [1, 5, 10, 25, model.MAX_FOUND];

export interface ActionListProps {
    readonly object: CrmObject;
    readonly trigger: model.WorkflowTrigger;
    readonly actions: readonly model.WorkflowAction[];
    /** The kinds the reader may add here. */
    readonly kinds: readonly model.ActionKind[];
    readonly options: model.WorkflowOptions;
    readonly onChange: (actions: model.WorkflowAction[]) => void;
}

/** A list of actions, each with its settings, and the menu that adds one. */
export function ActionList({
    object,
    trigger,
    actions,
    kinds,
    options,
    onChange
}: ActionListProps) {
    const t = useCrmT();
    const words = useWorkflowWords(object);
    const offered = kinds.filter(
        (kind) => words.actionFits(kind, trigger) && words.actionOffered(kind, options)
    );
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {actions.length === 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground">{t("workflows.noActions")}</p>
            ) : (
                <ol className="flex min-w-0 flex-col gap-2">
                    {actions.map((action, index) => (
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
                                        onChange(actions.filter((_, at) => at !== index))
                                    }
                                >
                                    <X className="size-3.5" />
                                </Button>
                            </div>
                            <ActionFields
                                object={object}
                                trigger={trigger}
                                action={action}
                                options={options}
                                onChange={(next) =>
                                    onChange(actions.map((one, at) => (at === index ? next : one)))
                                }
                            />
                        </li>
                    ))}
                </ol>
            )}
            {offered.length > 0 && actions.length < model.MAX_WORKFLOW_ACTIONS ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="self-start">
                            <Plus className="size-4" />
                            {t("workflows.addAction")}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {offered.map((kind) => (
                            <DropdownMenuItem
                                key={kind}
                                onSelect={() =>
                                    onChange([...actions, words.newAction(kind, options)])
                                }
                            >
                                {t(`workflows.actionKinds.${kind}`)}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
        </div>
    );
}

/** Where `{{field}}` fills in a value of the record. */
function TemplateHint({ object }: { object: CrmObject }) {
    const t = useCrmT();
    return (
        <p className="text-[0.75rem] text-muted-foreground">
            {t("workflows.valueHint", { example: `{{${primaryField(object).key}}}` })}
        </p>
    );
}

/** Who a notification goes to, and what it says. */
function NotifyFields({
    object,
    trigger,
    action,
    options,
    onChange
}: {
    object: CrmObject;
    trigger: model.WorkflowTrigger;
    action: Extract<model.WorkflowAction, { kind: "notify" }>;
    options: model.WorkflowOptions;
    onChange: (action: model.WorkflowAction) => void;
}) {
    const t = useCrmT();
    const custom = useCustomFields();
    const members = model.LIVE_RECORD_TRIGGERS.includes(trigger.kind)
        ? fieldsOf(object, custom).filter((field) => field.kind === "member")
        : [];
    const choices = [
        ...members.map((field) => ({
            value: `${model.FIELD_RECIPIENT}${field.key}`,
            label: t("workflows.fieldRecipient", { field: fieldLabel(t, object, field) })
        })),
        ...options.people.map((person) => ({ value: person.id, label: person.name }))
    ];
    const toggle = (value: string, on: boolean) =>
        onChange({
            ...action,
            to: on ? [...action.to, value] : action.to.filter((one) => one !== value)
        });
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <fieldset className="flex min-w-0 flex-col gap-1">
                <legend className="mb-1 text-[0.75rem] font-medium text-muted-foreground">
                    {t("workflows.recipients")}
                </legend>
                <div className="flex max-h-40 min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain">
                    {choices.map((choice) => (
                        <label
                            key={choice.value}
                            className="flex min-w-0 items-center gap-2 text-[0.8125rem]"
                        >
                            <Checkbox
                                checked={action.to.includes(choice.value)}
                                disabled={
                                    !action.to.includes(choice.value) &&
                                    action.to.length >= model.MAX_RECIPIENTS
                                }
                                onChange={(event) => toggle(choice.value, event.target.checked)}
                            />
                            <span className="min-w-0 truncate" title={choice.label}>
                                {choice.label}
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <Input
                aria-label={t("workflows.notifyTitle")}
                placeholder={t("workflows.notifyTitle")}
                value={action.title}
                maxLength={model.NOTIFY_TITLE_MAX}
                onChange={(event) => onChange({ ...action, title: event.target.value })}
            />
            <Textarea
                aria-label={t("workflows.notifyBody")}
                placeholder={t("workflows.notifyBody")}
                rows={2}
                value={action.body}
                maxLength={model.ACTION_TEXT_MAX}
                onChange={(event) => onChange({ ...action, body: event.target.value })}
            />
            <TemplateHint object={object} />
        </div>
    );
}

/** Field values to write: a field and the text to put in it, per line. */
function ValuesEditor({
    object,
    target,
    values,
    onChange
}: {
    object: CrmObject;
    target: CrmObject;
    values: Readonly<Record<string, string>>;
    onChange: (values: Record<string, string>) => void;
}) {
    const t = useCrmT();
    const fields = useWritable(object, target);
    const keys = Object.keys(values);
    const free = fields.filter((field) => !keys.includes(field.key));
    const label = (key: string) => {
        const field = fields.find((one) => one.key === key);
        return field ? fieldLabel(t, target, field) : key;
    };
    const rename = (from: string, to: string) =>
        onChange(
            Object.fromEntries(
                keys.map((key) => (key === from ? [to, values[key]!] : [key, values[key]!]))
            )
        );
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {keys.map((key) => (
                <div
                    key={key}
                    className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center"
                >
                    <div className="sm:w-48 sm:shrink-0">
                        <Select
                            aria-label={t("import.field")}
                            value={key}
                            onValueChange={(next) => rename(key, next)}
                            options={[
                                { value: key, label: label(key) },
                                ...free.map((field) => ({
                                    value: field.key,
                                    label: fieldLabel(t, target, field)
                                }))
                            ]}
                        />
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                        <Input
                            aria-label={t("workflows.value")}
                            className="min-w-0 flex-1"
                            value={values[key]}
                            maxLength={model.ACTION_TEXT_MAX}
                            onChange={(event) => onChange({ ...values, [key]: event.target.value })}
                        />
                        <Button
                            variant="ghost"
                            size="sm"
                            className="size-8 shrink-0 p-0"
                            aria-label={t("workflows.removeValue")}
                            title={t("workflows.removeValue")}
                            disabled={keys.length === 1}
                            onClick={() =>
                                onChange(
                                    Object.fromEntries(
                                        keys
                                            .filter((one) => one !== key)
                                            .map((one) => [one, values[one]!])
                                    )
                                )
                            }
                        >
                            <X className="size-3.5" />
                        </Button>
                    </div>
                </div>
            ))}
            <TemplateHint object={target === object ? object : target} />
            {free.length > 0 && keys.length < model.MAX_ACTION_VALUES ? (
                <Button
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => onChange({ ...values, [free[0]!.key]: "" })}
                >
                    <Plus className="size-4" />
                    {t("workflows.addValue")}
                </Button>
            ) : null}
        </div>
    );
}

/** How the editor makes and describes triggers and actions. */
export function useWorkflowWords(object: CrmObject) {
    const t = useCrmT();
    const custom = useCustomFields();
    return {
        newTrigger(kind: model.TriggerKind): model.WorkflowTrigger {
            if (kind === "schedule") {
                return {
                    kind,
                    cron: "0 9 * * 1",
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
                };
            }
            if (kind === "fieldChanged") {
                return { kind, field: primaryField(object).key, to: null };
            }
            return { kind } as model.WorkflowTrigger;
        },
        /** Whether the editor can offer an action at all, given what the
         *  reader may use. */
        actionOffered(kind: model.ActionKind, options: model.WorkflowOptions): boolean {
            if (kind === "createTask") return options.taskLists.length > 0;
            if (kind === "notify") return options.people.length > 0;
            if (kind === "sendEmail") return options.mail === true;
            return true;
        },
        newAction(kind: model.ActionKind, options: model.WorkflowOptions): model.WorkflowAction {
            switch (kind) {
                case "updateRecord": {
                    const first = fieldsOf(object).find(
                        (field) => !field.readOnly && !field.primary
                    );
                    return { kind, values: { [first?.key ?? primaryField(object).key]: "" } };
                }
                case "createRecord":
                    return { kind, object, values: { [primaryField(object).key]: "" } };
                case "createTask":
                    return {
                        kind,
                        listId: options.taskLists[0]?.id ?? "",
                        name: `{{${primaryField(object).key}}}`,
                        dueInDays: 1
                    };
                case "httpRequest":
                    return { kind, url: "" };
                case "sendEmail":
                    return {
                        kind,
                        to: object === "people" ? "{{email}}" : "",
                        subject: `{{${primaryField(object).key}}}`,
                        body: ""
                    };
                case "notify":
                    return {
                        kind,
                        to: [],
                        title: `{{${primaryField(object).key}}}`,
                        body: ""
                    };
                case "filter":
                    return { kind, when: EMPTY_FILTER };
                case "ifElse":
                    return { kind, when: EMPTY_FILTER, then: [], otherwise: [] };
                case "forEach":
                    return { kind, where: EMPTY_FILTER, limit: 10, actions: [] };
            }
        },
        /** Whether an action can run under a trigger. */
        actionFits(kind: model.ActionKind, trigger: model.WorkflowTrigger): boolean {
            return model.actionFits(kind, trigger.kind);
        },
        triggerSummary(trigger: model.WorkflowTrigger): string {
            if (trigger.kind === "fieldChanged") {
                const field = fieldsOf(object, custom).find((one) => one.key === trigger.field);
                const name = field ? fieldLabel(t, object, field) : trigger.field;
                return trigger.to
                    ? t("workflows.summaryFieldTo", { field: name, value: trigger.to })
                    : t("workflows.summaryField", { field: name });
            }
            if (trigger.kind === "schedule") return `${trigger.cron} (${trigger.timeZone})`;
            return t(`workflows.triggers.${trigger.kind}`);
        },
        /** What to tell the reader once a workflow is saved, beyond the list,
         *  and what they may want to copy from it. */
        savedNotice(saved: model.SavedWorkflow): { text: string; copy: string } | null {
            if (!saved.hookPath) return null;
            const url = `${window.location.origin}${saved.hookPath}`;
            return { text: t("workflows.hookAddress", { name: saved.workflow.name }), copy: url };
        }
    };
}

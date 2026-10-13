"use client";

/**
 * What each kind of trigger and action asks for in the workflow editor, and
 * the words the list says about each. One place per kind, so a new trigger or
 * action adds its fields here and nowhere else.
 */

import { useCrmT } from "./i18n";
import { Plus, X } from "lucide-react";
import * as model from "../model/workflows";
import { Button, Input, Select } from "@polaris/ui";
import { fieldLabel, useCustomFields } from "./custom-fields";
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

/** The settings of a trigger beyond its kind. The record triggers have none. */
export function TriggerFields(_props: TriggerFieldsProps) {
    return null;
}

export interface ActionFieldsProps {
    readonly object: CrmObject;
    readonly trigger: model.WorkflowTrigger;
    readonly action: model.WorkflowAction;
    readonly onChange: (action: model.WorkflowAction) => void;
}

/** The settings of one action. */
export function ActionFields({ object, action, onChange }: ActionFieldsProps) {
    const t = useCrmT();
    switch (action.kind) {
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
    }
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
            <p className="text-[0.75rem] text-muted-foreground">
                {t("workflows.valueHint", { example: `{{${primaryField(object).key}}}` })}
            </p>
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
    return {
        newTrigger(kind: model.TriggerKind): model.WorkflowTrigger {
            return { kind } as model.WorkflowTrigger;
        },
        newAction(kind: model.ActionKind): model.WorkflowAction {
            switch (kind) {
                case "updateRecord": {
                    const first = fieldsOf(object).find(
                        (field) => !field.readOnly && !field.primary
                    );
                    return { kind, values: { [first?.key ?? primaryField(object).key]: "" } };
                }
                case "createRecord":
                    return { kind, object, values: { [primaryField(object).key]: "" } };
            }
        },
        /** Whether an action can run under a trigger. */
        actionFits(kind: model.ActionKind, trigger: model.WorkflowTrigger): boolean {
            return model.actionFits(kind, trigger.kind);
        },
        triggerSummary(trigger: model.WorkflowTrigger): string {
            return t(`workflows.triggers.${trigger.kind}`);
        },
        /** What to tell the reader once a workflow is saved, beyond the list. */
        savedNotice(_saved: model.SavedWorkflow): string | null {
            return null;
        }
    };
}

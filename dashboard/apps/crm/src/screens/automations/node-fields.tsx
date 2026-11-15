"use client";

/**
 * The settings of a CRM trigger, check or step in the central automation
 * editor: the kind of record, then the same fields a workflow's trigger and
 * actions had - drawn by the same components, so a step reads as it did.
 *
 * The task lists, people and channels offered are the signed-in account's;
 * the run asks again as the run-as account.
 */

import { useCrmT } from "../i18n";
import { Select } from "@polaris/ui";
import { useEffect, useState } from "react";
import { messageOf, unwrap } from "../call";
import * as model from "../../model/workflows";
import { EMPTY_FILTER } from "../../model/filters";
import * as nodes from "../../model/automation-nodes";
import { CustomFieldsProvider } from "../custom-fields";
import { automationNodeContextAction } from "../../actions/workflows";
import { CRM_OBJECTS, type CrmObject, type FieldDef } from "../../model/objects";
import { ActionFields, TriggerFields, useWorkflowWords } from "../workflow-fields";

/** What the central editor hands a CRM node's fields. */
export interface CrmNodeFieldsProps {
    readonly node: { readonly id: string; readonly type: string; readonly config?: unknown };
    readonly setConfig: (config: unknown) => void;
    readonly disabled?: boolean;
}

interface NodeContext {
    readonly orgId: string | null;
    readonly custom: FieldDef[];
    readonly options: model.WorkflowOptions;
}

const NO_OPTIONS: model.WorkflowOptions = { taskLists: [], people: [] };

/** The trigger a check or step is read under: any record trigger, so every action is offered. */
const ANY_RECORD: model.WorkflowTrigger = { kind: "updated" };

function objectOf(config: Record<string, unknown>): CrmObject {
    return (CRM_OBJECTS as readonly unknown[]).includes(config.object)
        ? (config.object as CrmObject)
        : "companies";
}

export function CrmNodeFields({ node, setConfig, disabled = false }: CrmNodeFieldsProps) {
    const t = useCrmT();
    const config = (node.config ?? {}) as Record<string, unknown>;
    const object = objectOf(config);
    const [context, setContext] = useState<NodeContext | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        setError("");
        void unwrap(() => automationNodeContextAction({ object }), t("errors.loadFailed")).then(
            (answer) => !cancelled && setContext(answer),
            (caught: unknown) => !cancelled && setError(messageOf(caught))
        );
        return () => {
            cancelled = true;
        };
    }, [object]);

    return (
        <CustomFieldsProvider value={context?.custom ?? []}>
            <div className="flex min-w-0 flex-col gap-3">
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    <span>{t("workflows.recordKind")}</span>
                    <Select
                        aria-label={t("workflows.recordKind")}
                        value={object}
                        disabled={disabled}
                        onValueChange={(next) =>
                            setConfig({ ...config, object: next, orgId: context?.orgId ?? null })
                        }
                        options={CRM_OBJECTS.map((one) => ({
                            value: one,
                            label: t(`objects.${one}.plural`)
                        }))}
                    />
                </label>
                {error ? (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                ) : null}
                <NodeBody
                    node={node}
                    object={object}
                    config={config}
                    context={context}
                    disabled={disabled}
                    setConfig={setConfig}
                />
            </div>
        </CustomFieldsProvider>
    );
}

function NodeBody({
    node,
    object,
    config,
    context,
    disabled,
    setConfig
}: {
    readonly node: CrmNodeFieldsProps["node"];
    readonly object: CrmObject;
    readonly config: Record<string, unknown>;
    readonly context: NodeContext | null;
    readonly disabled: boolean;
    readonly setConfig: (config: unknown) => void;
}) {
    const t = useCrmT();
    const words = useWorkflowWords(object);
    const options = context?.options ?? NO_OPTIONS;
    const orgId = typeof config.orgId === "string" ? config.orgId : (context?.orgId ?? null);
    const base = { orgId, object };
    const kind = nodes.stepKindOf(node.type);

    // A node just added holds nothing yet: start it as a workflow's editor started each kind.
    useEffect(() => {
        if (disabled || !context) return;
        if (node.type === nodes.TRIGGER_NODE_TYPE && !config.trigger)
            setConfig({ ...base, trigger: words.newTrigger("created") });
        else if (node.type === nodes.CONDITION_NODE_TYPE && !config.when)
            setConfig({ ...base, when: EMPTY_FILTER });
        else if (node.type === nodes.WAIT_NODE_TYPE && !config.when)
            setConfig({ ...base, when: EMPTY_FILTER, days: 1, onTimeout: "stop" });
        else if (kind && !config.action) setConfig({ ...base, action: words.newAction(kind, options) });
    }, [node.id, context === null]);

    if (node.type === nodes.TRIGGER_NODE_TYPE) {
        const trigger = model.workflowTriggerSchema.safeParse(config.trigger);
        const current = trigger.success ? trigger.data : words.newTrigger("created");
        // Moved workflows keep a schedule or a webhook address; a new one starts from a record.
        const kinds = model.TRIGGER_KINDS.filter(
            (one) => one === current.kind || (one !== "schedule" && one !== "webhook")
        );
        return (
            <div className="flex min-w-0 flex-col gap-2">
                <Select
                    aria-label={t("workflows.trigger")}
                    value={current.kind}
                    disabled={disabled}
                    onValueChange={(next) =>
                        setConfig({
                            ...base,
                            trigger: words.newTrigger(next as model.TriggerKind)
                        })
                    }
                    options={kinds.map((one) => ({ value: one, label: t(`workflows.triggers.${one}`) }))}
                />
                <TriggerFields
                    object={object}
                    trigger={current}
                    onChange={(next) => !disabled && setConfig({ ...base, trigger: next })}
                />
            </div>
        );
    }
    if (!context) return null;
    if (node.type === nodes.CONDITION_NODE_TYPE) {
        const when = (config.when as model.WorkflowFilter | undefined) ?? EMPTY_FILTER;
        return (
            <ActionFields
                object={object}
                trigger={ANY_RECORD}
                action={{ kind: "filter", when }}
                options={options}
                onChange={(next) =>
                    !disabled && next.kind === "filter" && setConfig({ ...base, when: next.when })
                }
            />
        );
    }
    if (node.type === nodes.WAIT_NODE_TYPE) {
        const action: model.WorkflowAction = {
            kind: "waitFor",
            when: (config.when as model.WorkflowFilter | undefined) ?? EMPTY_FILTER,
            days: typeof config.days === "number" ? config.days : 1,
            onTimeout: config.onTimeout === "continue" ? "continue" : "stop"
        };
        return (
            <ActionFields
                object={object}
                trigger={ANY_RECORD}
                action={action}
                options={options}
                onChange={(next) => {
                    if (disabled || next.kind !== "waitFor") return;
                    const { kind: _kind, ...rest } = next;
                    setConfig({ ...base, ...rest });
                }}
            />
        );
    }
    if (!kind) return null;
    const parsed = model.workflowActionSchema.safeParse(config.action);
    const action =
        parsed.success && parsed.data.kind === kind ? parsed.data : words.newAction(kind, options);
    return (
        <ActionFields
            object={object}
            trigger={ANY_RECORD}
            action={action}
            options={options}
            onChange={(next) => !disabled && setConfig({ ...base, action: next })}
        />
    );
}

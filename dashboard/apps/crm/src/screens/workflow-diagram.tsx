"use client";

/**
 * A workflow drawn as its steps: what sets it off, then each action in order,
 * a branch's two lists side by side and a loop's actions inside it. Read-only.
 */

import { useCrmT } from "./i18n";
import * as model from "../model/workflows";
import type { CrmObject } from "../model/objects";
import { delayLabel, useWorkflowWords } from "./workflow-fields";

export interface WorkflowDiagramProps {
    readonly object: CrmObject;
    readonly trigger: model.WorkflowTrigger;
    readonly actions: readonly model.WorkflowAction[];
}

export function WorkflowDiagram({ object, trigger, actions }: WorkflowDiagramProps) {
    const t = useCrmT();
    const words = useWorkflowWords(object);
    return (
        <ol className="flex min-w-0 flex-col items-stretch" aria-label={t("workflows.steps")}>
            <Step
                title={t("workflows.trigger")}
                detail={words.triggerSummary(trigger)}
                tone="trigger"
            />
            {actions.length === 0 ? (
                <Step title={t("workflows.actions")} detail={t("workflows.noActions")} />
            ) : (
                actions.map((action, index) => <ActionStep key={index} action={action} />)
            )}
        </ol>
    );
}

function ActionStep({ action }: { action: model.WorkflowAction }) {
    const t = useCrmT();
    const title = t(`workflows.actionKinds.${action.kind}`);
    if (action.kind === "ifElse") {
        return (
            <Step title={title}>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                    <Branch label={t("workflows.then")} actions={action.then} />
                    <Branch label={t("workflows.otherwise")} actions={action.otherwise} />
                </div>
            </Step>
        );
    }
    if (action.kind === "forEach") {
        return (
            <Step title={title} detail={t("workflows.foundUpTo", { count: action.limit })}>
                <Branch label={t("workflows.forEachFound")} actions={action.actions} />
            </Step>
        );
    }
    return <Step title={title} detail={leafDetail(t, action)} />;
}

function Branch({ label, actions }: { label: string; actions: readonly model.LeafAction[] }) {
    const t = useCrmT();
    return (
        <div className="flex min-w-0 flex-col gap-1 rounded-md border border-dashed px-2 py-1.5">
            <span className="text-[0.75rem] text-muted-foreground">{label}</span>
            {actions.length === 0 ? (
                <span className="text-[0.75rem] text-muted-foreground">
                    {t("workflows.noActions")}
                </span>
            ) : (
                <ol className="flex min-w-0 flex-col gap-1">
                    {actions.map((action, index) => (
                        <li
                            key={index}
                            className="min-w-0 rounded bg-muted px-2 py-1 text-[0.75rem]"
                        >
                            <span className="font-medium">
                                {t(`workflows.actionKinds.${action.kind}`)}
                            </span>
                            {leafDetail(t, action) ? (
                                <span
                                    className="block truncate text-muted-foreground"
                                    title={leafDetail(t, action)}
                                >
                                    {leafDetail(t, action)}
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

/** One box in the column, joined to the one above it by a short line. */
function Step(props: {
    title: string;
    detail?: string;
    tone?: "trigger";
    children?: React.ReactNode;
}) {
    return (
        <li className="flex min-w-0 flex-col items-stretch [&:not(:first-child)]:before:mx-auto [&:not(:first-child)]:before:block [&:not(:first-child)]:before:h-3 [&:not(:first-child)]:before:w-px [&:not(:first-child)]:before:bg-border [&:not(:first-child)]:before:content-['']">
            <div
                className={
                    props.tone === "trigger"
                        ? "flex min-w-0 flex-col gap-1 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
                        : "flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2"
                }
            >
                <span className="text-[0.8125rem] font-medium">{props.title}</span>
                {props.detail ? (
                    <span
                        className="truncate text-[0.75rem] text-muted-foreground"
                        title={props.detail}
                    >
                        {props.detail}
                    </span>
                ) : null}
                {props.children}
            </div>
        </li>
    );
}

/** The one line that tells one action of its kind from another. */
function leafDetail(t: ReturnType<typeof useCrmT>, action: model.WorkflowAction): string {
    switch (action.kind) {
        case "createTask":
            return action.name;
        case "notify":
            return action.title;
        case "sendEmail":
            return action.subject;
        case "sendChat":
            return action.body;
        case "httpRequest":
            return action.url;
        case "createRecord":
            return t(`objects.${action.object}.plural`);
        case "delay":
            return delayLabel(t, action.minutes);
        case "waitFor":
            return t("workflows.waitForUpTo", { count: action.days });
        case "filter":
            return t("workflows.filterHint");
        default:
            return "";
    }
}

"use client";

/**
 * What each kind of trigger and action asks for in the workflow editor, and
 * the words the list says about each. One place per kind, so a new trigger or
 * action adds its fields here and nowhere else.
 */

import { useCrmT } from "./i18n";
import * as model from "../model/workflows";
import type { CrmObject } from "../model/objects";

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
export function ActionFields(_props: ActionFieldsProps) {
    return null;
}

/** How the editor makes and describes triggers and actions. */
export function useWorkflowWords(_object: CrmObject) {
    const t = useCrmT();
    return {
        newTrigger(kind: model.TriggerKind): model.WorkflowTrigger {
            return { kind } as model.WorkflowTrigger;
        },
        newAction(kind: model.ActionKind): model.WorkflowAction {
            return { kind } as model.WorkflowAction;
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

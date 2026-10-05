"use client";

/**
 * Places' automations on the shared visual editor (`@polaris/ui/automation-canvas`):
 * the diagram, the palette and the narrow-screen list are the design system's;
 * what a device trigger, condition or step is called and how a blank one starts
 * are Places', handed over as the canvas's vocabulary.
 */

import { usePlacesT } from "../use-places-t";
import { useMemo, type ReactNode } from "react";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import type { Path } from "@polaris/ui/automation-graph";
import {
    FlowCanvas,
    type CanvasSelection,
    type FlowCanvasLabels,
    type FlowVocabulary,
    type NodeState
} from "@polaris/ui/automation-canvas";

type Definition = auto.AutomationDefinition;
type Translator = ReturnType<typeof usePlacesT>;

/** The canvas's words, from Places' catalog. Shared with nothing else: the
 *  mail filters editor builds its own from its own. */
export function canvasLabels(t: Translator): FlowCanvasLabels {
    return {
        when: t("automations.editor.when"),
        if: t("automations.editor.if"),
        then: t("automations.editor.then"),
        allGroups: t("automations.editor.allGroups"),
        anyGroup: t("automations.editor.anyGroup"),
        allOf: t("automations.editor.allOf"),
        anyOf: t("automations.editor.anyOf"),
        addTrigger: t("automations.editor.addTrigger"),
        addCondition: t("automations.editor.addCondition"),
        addStep: t("automations.editor.addStep"),
        tooMany: t("automations.errors.tooMany"),
        diagram: t("automations.canvas.diagram"),
        add: t("automations.canvas.add"),
        toGroup: t("automations.canvas.toGroup"),
        newGroup: t("automations.canvas.newGroup"),
        zoomIn: t("automations.canvas.zoomIn"),
        zoomOut: t("automations.canvas.zoomOut"),
        fit: t("automations.canvas.fit"),
        always: t("automations.canvas.always"),
        oneGroup: t("automations.canvas.oneGroup"),
        group: (number) => t("automations.canvas.group", { number }),
        unfinished: t("automations.canvas.unfinished"),
        invalid: t("automations.canvas.invalid"),
        pick: t("automations.canvas.pick"),
        inspector: t("automations.canvas.inspector"),
        close: t("automations.canvas.close"),
        reorderHint: t("automations.canvas.reorderHint"),
        nodeHelp: t("automations.canvas.nodeHelp"),
        nodeHelpReadOnly: t("automations.canvas.nodeHelpReadOnly"),
        moved: t("automations.canvas.moved"),
        handle: t("automations.canvas.handle"),
        edgeHelp: t("automations.canvas.edgeHelp")
    };
}

export interface AutomationCanvasProps {
    definition: Definition;
    readOnly: boolean;
    /** Edit the draft's definition, as the form does. */
    onChange: (change: (current: Definition) => Definition) => void;
    /** How the node at a path stands against the checks the form runs. */
    stateOf: (path: Path) => NodeState;
    lookup: words.DeviceLookup;
    automationName: (id: string) => string | undefined;
    /** The form's own card for what is selected. */
    renderInspector: (selection: CanvasSelection) => ReactNode;
    /** Complaints about a stage as a whole - no trigger, no step - once Save
     *  has been pressed. */
    stageIssues: readonly string[];
}

export function AutomationCanvas({ lookup, automationName, ...props }: AutomationCanvasProps) {
    const t = usePlacesT();
    const vocabulary = useMemo<FlowVocabulary<Definition>>(
        () => ({
            labels: canvasLabels(t),
            triggers: {
                kinds: auto.TRIGGER_KINDS,
                kindText: (kind) => words.triggerKindText(kind, t),
                blank: auto.blankTrigger,
                describe: (trigger) => words.describeTrigger(trigger, lookup, t)
            },
            conditions: {
                kinds: auto.CONDITION_KINDS,
                kindText: (kind) => words.conditionKindText(kind, t),
                blank: auto.blankCondition,
                describe: (condition) => words.describeCondition(condition, lookup, t)
            },
            steps: {
                kinds: auto.STEP_KINDS,
                kindText: (kind) => words.stepKindText(kind, t),
                blank: auto.blankStep,
                describe: (step) => words.describeStep(step, lookup, automationName, t)
            },
            limits: {
                triggers: auto.LIMITS.triggers,
                groups: auto.LIMITS.groups,
                conditionsPerGroup: auto.LIMITS.conditionsPerGroup,
                steps: auto.LIMITS.steps
            },
            newId: auto.nodeIdOf
        }),
        [t, lookup, automationName]
    );
    return <FlowCanvas {...props} vocabulary={vocabulary} />;
}

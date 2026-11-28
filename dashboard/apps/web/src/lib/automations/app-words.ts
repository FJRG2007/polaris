/**
 * The words a run screen needs for the steps and triggers installed apps
 * declare in their manifests, in the reader's language, read from the
 * catalogue this dashboard holds - so a run names them without the editor
 * having been opened first. Only the ones its graph uses are sent.
 *
 * Server-only.
 */

import type * as core from "@polaris/core";
import type { AppStepView } from "./app-steps";
import type { AppEventWords } from "@/app/(app)/automations/app-step-words";
import { heldRuntimeAppViews } from "@/lib/apps/runtime-catalog";

export interface AppWords {
    readonly steps: readonly AppStepView[];
    readonly events: readonly AppEventWords[];
}

export function appWordsFor(graph: core.AutomationGraph | null, locale: string): AppWords {
    const types = new Set<string>();
    const names = new Set<string>();
    for (const node of graph?.nodes ?? []) {
        types.add(node.type);
        const name = node.type === "core.onEvent" ? (node.config as { name?: unknown } | null)?.name : null;
        if (typeof name === "string") names.add(name);
    }
    const steps: AppStepView[] = [];
    const events: AppEventWords[] = [];
    for (const view of heldRuntimeAppViews(locale)) {
        for (const step of view.automationSteps ?? [])
            if (types.has(step.type) && step.type.startsWith(`${view.id}.`))
                steps.push({
                    type: step.type,
                    app: view.id,
                    appName: view.name,
                    label: step.label,
                    description: step.description,
                    fields: step.fields,
                    output: Object.keys(step.output)
                });
        for (const event of view.events ?? [])
            if (names.has(event.name) && event.name.startsWith(`${view.id}.`))
                events.push({ name: event.name, label: event.label });
    }
    return { steps, events };
}

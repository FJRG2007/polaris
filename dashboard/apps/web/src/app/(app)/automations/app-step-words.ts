/**
 * The words of the steps and events installed apps declare in their manifests:
 * an app's step or trigger is named in the editor, the run screens and the
 * version list by what its manifest says, in the reader's language, without a
 * key in the dashboard's own catalogs.
 *
 * Filled by whatever the server sent with the screen (an automation's detail,
 * a run), and otherwise read from the manifests this browser registered at
 * load (`RuntimeAppsRegistrar`), so a run opened straight from a link names
 * them too.
 */

import * as core from "@polaris/core";
import type { AppStepView } from "@/lib/automations/app-steps";

/** What an app's event is called, by its name. */
export interface AppEventWords {
    readonly name: string;
    readonly label: string;
}

const known = new Map<string, AppStepView>();
const events = new Map<string, string>();

/** Keep the steps a detail brought; later details replace them type by type. */
export function rememberAppSteps(steps: readonly AppStepView[] | undefined): void {
    for (const step of steps ?? []) known.set(step.type, step);
}

/** Keep the event names a detail or a run brought. */
export function rememberAppEvents(words: readonly AppEventWords[] | undefined): void {
    for (const event of words ?? []) events.set(event.name, event.label);
}

/** One step by its type, or null for a type no manifest here declares. */
export function appStepView(type: string): AppStepView | null {
    const remembered = known.get(type);
    if (remembered) return remembered;
    const step = core.appStep(type);
    if (!step) return null;
    return {
        type: step.type,
        app: step.app,
        appName: step.appName,
        label: step.label,
        description: step.description,
        fields: step.fields,
        output: Object.keys(step.output)
    };
}

/** What an app's own event is called, or null for a built-in or unknown name. */
export function appEventLabel(name: string): string | null {
    return events.get(name) ?? core.registeredAppEventLabel(name);
}

/**
 * The words of the steps installed apps declare in their manifests, as the
 * open automation's detail brought them: an app's step is named in the editor,
 * the run screens and the version list by what its manifest says, in the
 * reader's language, without a key in the dashboard's own catalogs.
 */

import type { AppStepView } from "@/lib/automations/app-steps";

const known = new Map<string, AppStepView>();

/** Keep the steps a detail brought; later details replace them type by type. */
export function rememberAppSteps(steps: readonly AppStepView[] | undefined): void {
    for (const step of steps ?? []) known.set(step.type, step);
}

/** One remembered step, or null for a type no detail brought. */
export function appStepView(type: string): AppStepView | null {
    return known.get(type) ?? null;
}

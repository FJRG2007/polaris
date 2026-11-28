/**
 * The automation steps installed apps declare in their manifests, as engine
 * nodes and as the editor sees them.
 *
 * The app's bundle only does the work (`AppExtension.automationSteps`): its
 * settings are checked here against the declared fields before it is asked,
 * the run-as account must hold the step's permission - one of the app's own,
 * the same check its screens make - and its answer must match the declared
 * output before a later step can read it. A refusal the app gives is shown as
 * the app said it; anything it throws is logged and said without internals.
 */

import * as core from "@polaris/core";
import type { SessionUser } from "@/lib/session";
import type { AppStepHandler } from "@/lib/app-extensions/types";
import { StepError, StepRefusal, type ServerNode } from "./types";

type Handlers = () => Promise<Readonly<Record<string, AppStepHandler>>>;

/** What the editor needs of one step: its words, its fields and where it is filed. */
export interface AppStepView {
    readonly type: string;
    readonly app: string;
    readonly appName: string;
    readonly label: string;
    readonly description: string;
    readonly fields: readonly core.AppStepField[];
    readonly output: readonly string[];
}

function stepNode(step: core.RegisteredAppStep, handlers: Handlers): ServerNode {
    return {
        type: step.type,
        meta: { role: "action", ports: [], idempotent: false } as never,
        config: core.appStepConfigSchema(step),
        run: async (config, context, io) => {
            const input = config as Record<string, unknown>;
            io.recordInput(input);
            const [{ actingUser }, { sessionCan }] = await Promise.all([
                import("@/lib/mcp/acting-user"),
                import("@/lib/session")
            ]);
            const user = await actingUser(io.actor.id);
            if (!user) throw new StepRefusal("runAsGone");
            if (!(await sessionCan(user, step.permission as core.Permission)))
                throw new StepRefusal("appStepForbidden");
            const handler = (await handlers().catch(() => ({}) as Record<string, AppStepHandler>))[step.type];
            if (!handler) throw new StepError("appMissing");
            let answer: Awaited<ReturnType<AppStepHandler>>;
            try {
                answer = await handler(input, {
                    actorId: io.actor.id,
                    automationId: context.automation.id,
                    trigger: context.trigger
                });
            } catch (caught) {
                console.error(`polaris: the ${step.app} step ${step.type} failed:`, caught);
                throw new StepError("appStepFailed");
            }
            if (answer.refused) throw new StepError("appStepRefused", { said: answer.refused.slice(0, 300) });
            const output = core.parseAppStepOutput(step, answer.output ?? {});
            if (!output) {
                console.error(`polaris: the ${step.app} step ${step.type} answered off its declared output`);
                throw new StepError("appStepAnswer");
            }
            return { output };
        }
    };
}

/** The nodes one installed app's manifest steps run as; none without its handlers. */
export function manifestStepNodes(app: string, handlers: Handlers | undefined): ServerNode[] {
    if (!handlers) return [];
    return core
        .appSteps()
        .filter((step) => step.app === app)
        .map((step) => stepNode(step, handlers));
}

/**
 * The steps this account may add, of the apps installed here: each behind its
 * permission, so a step its runner could never run is not offered.
 */
export async function appStepViews(user: SessionUser, installed: (app: string) => Promise<boolean>): Promise<AppStepView[]> {
    const { sessionCan } = await import("@/lib/session");
    const views = await Promise.all(
        core.appSteps().map(async (step): Promise<AppStepView | null> => {
            if (!(await installed(step.app).catch(() => false))) return null;
            if (!(await sessionCan(user, step.permission as core.Permission).catch(() => false))) return null;
            return {
                type: step.type,
                app: step.app,
                appName: step.appName,
                label: step.label,
                description: step.description,
                fields: step.fields,
                output: Object.keys(step.output)
            };
        })
    );
    return views.filter((view): view is AppStepView => view !== null);
}

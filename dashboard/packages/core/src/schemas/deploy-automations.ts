/**
 * A deploy project's automations: when something happens, do these things.
 *
 * A rule has one trigger - a schedule, a call to its own webhook, or an event
 * the project already reports (a deploy finishing, a domain going down or
 * coming back) - and an ordered list of actions on the project's services. The
 * shapes are here so the form and the server check the same thing.
 */

import { z } from "zod";
import { cronExpression } from "../cron.js";
import { AUTOMATIC_TIME_ZONE, isTimeZone } from "./display.js";

export const DEPLOY_AUTOMATION_TRIGGERS = ["schedule", "webhook", "event"] as const;
export type DeployAutomationTrigger = (typeof DEPLOY_AUTOMATION_TRIGGERS)[number];

/** The project events a rule can follow - the ones its alerts already raise. */
export const DEPLOY_AUTOMATION_EVENTS = [
    "deploy.succeeded",
    "deploy.failed",
    "domain.down",
    "domain.up"
] as const;
export type DeployAutomationEvent = (typeof DEPLOY_AUTOMATION_EVENTS)[number];

/** Events that name the service they happened to, so a rule can follow one. */
export const SERVICE_SCOPED_EVENTS: readonly DeployAutomationEvent[] = ["deploy.succeeded", "deploy.failed"];

export const DEPLOY_AUTOMATION_ACTIONS = ["redeploy", "restart", "command", "notify"] as const;
export type DeployAutomationActionType = (typeof DEPLOY_AUTOMATION_ACTIONS)[number];

/** At most this many actions in one rule. */
export const DEPLOY_AUTOMATION_ACTION_LIMIT = 10;

/** At most this many rules in one project. */
export const DEPLOY_AUTOMATION_LIMIT = 50;

/** An event rule waits this long after a run before the next event can start
 *  it again, so a flapping domain or a rule that answers its own deploy cannot
 *  run without end. */
export const DEPLOY_AUTOMATION_EVENT_COOLDOWN_MS = 5 * 60 * 1000;

const NUL = String.fromCharCode(0);

export const deployAutomationActionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("redeploy"), applicationId: z.string().uuid("Pick a service") }),
    z.object({ type: z.literal("restart"), applicationId: z.string().uuid("Pick a service") }),
    z.object({
        type: z.literal("command"),
        applicationId: z.string().uuid("Pick a service"),
        command: z
            .string()
            .trim()
            .min(1, "A command is required")
            .max(4000, "Keep the command under 4000 characters")
            .refine((value) => !value.includes(NUL), "The command cannot contain a NUL character"),
        timeoutSeconds: z.number().int().min(10, "At least 10 seconds").max(3600, "At most an hour").default(300)
    }),
    z.object({
        type: z.literal("notify"),
        message: z.string().trim().min(1, "Write the message").max(300, "Keep the message under 300 characters")
    })
]);

export type DeployAutomationAction = z.infer<typeof deployAutomationActionSchema>;

export const deployAutomationInputSchema = z
    .object({
        id: z.string().uuid().optional(),
        projectId: z.string().uuid(),
        name: z.string().trim().min(1, "A name is required").max(64, "Keep the name under 64 characters"),
        enabled: z.boolean().default(true),
        trigger: z.enum(DEPLOY_AUTOMATION_TRIGGERS),
        schedule: z.string().trim().max(128).optional(),
        timezone: z
            .string()
            .trim()
            .max(64)
            .default("UTC")
            .refine(
                (value) => value !== AUTOMATIC_TIME_ZONE && isTimeZone(value),
                "That is not a time zone this server knows"
            ),
        event: z.enum(DEPLOY_AUTOMATION_EVENTS).optional(),
        eventApplicationId: z.string().uuid().nullable().optional(),
        actions: z
            .array(deployAutomationActionSchema)
            .min(1, "Add at least one action")
            .max(DEPLOY_AUTOMATION_ACTION_LIMIT, `At most ${DEPLOY_AUTOMATION_ACTION_LIMIT} actions`)
    })
    .superRefine((value, ctx) => {
        if (value.trigger === "schedule") {
            const parsed = cronExpression.safeParse(value.schedule ?? "");
            if (!parsed.success)
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["schedule"],
                    message: parsed.error.issues[0]?.message ?? "That is not a schedule"
                });
        }
        if (value.trigger === "event") {
            if (!value.event)
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["event"], message: "Pick an event" });
            else if (value.eventApplicationId && !SERVICE_SCOPED_EVENTS.includes(value.event))
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["eventApplicationId"],
                    message: "That event is not about one service"
                });
        }
    });

export type DeployAutomationInput = z.infer<typeof deployAutomationInputSchema>;

/** The stored action list, read back. A row older than a change to these shapes
 *  keeps the actions that still read and drops the rest, rather than failing. */
export function readAutomationActions(stored: string): DeployAutomationAction[] {
    let raw: unknown;
    try {
        raw = JSON.parse(stored);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const actions: DeployAutomationAction[] = [];
    for (const entry of raw) {
        const parsed = deployAutomationActionSchema.safeParse(entry);
        if (parsed.success) actions.push(parsed.data);
    }
    return actions;
}

/** Whether an event reaches a rule: the same event, the same service when the
 *  rule names one, and not inside the cool-off after its last run. */
export function automationHears(
    rule: {
        readonly enabled: boolean;
        readonly trigger: string;
        readonly event: string | null;
        readonly eventApplicationId: string | null;
        readonly lastRunAt: Date | null;
    },
    event: { readonly event: string; readonly applicationId: string | null },
    now: Date
): boolean {
    if (!rule.enabled || rule.trigger !== "event" || rule.event !== event.event) return false;
    if (rule.eventApplicationId && rule.eventApplicationId !== event.applicationId) return false;
    if (rule.lastRunAt && now.getTime() - rule.lastRunAt.getTime() < DEPLOY_AUTOMATION_EVENT_COOLDOWN_MS)
        return false;
    return true;
}

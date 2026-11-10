/**
 * The shape of a Telemetry alert rule, as the form and the server both check
 * it. Its own module so the dialog validates with the same schema the action
 * does without importing the database.
 */

import { z } from "zod";
import * as core from "@polaris/core";

export const ALERT_TRIGGERS = ["new", "frequency", "regression"] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

/** The notification catalogue event each trigger sends. */
export const ALERT_EVENTS: Readonly<Record<AlertTrigger, string>> = {
    new: "telemetry.newIssue",
    frequency: "telemetry.issueSpike",
    regression: "telemetry.regression"
};

/** How many rules one project may have, which bounds what every event reads. */
export const MAX_RULES = 50;
/** How many people a rule may name; the project's members come on top. */
export const MAX_RECIPIENTS = 20;
/** How many people one firing reaches at most. */
export const MAX_NOTIFIED = 200;
export const MAX_THRESHOLD = 100_000;
/** A week, in minutes: the longest window and the longest throttle. */
export const MAX_MINUTES = 7 * 24 * 60;

/** The form, as the dialog sends it. Normalized before it is checked: names
 *  trimmed, an empty environment is none, and a trigger that has no window
 *  stores none. */
export const alertRuleSchema = z
    .object({
        name: z.string().trim().min(1).max(80),
        enabled: z.boolean().default(true),
        trigger: z.enum(ALERT_TRIGGERS),
        threshold: z.number().int().min(0).max(MAX_THRESHOLD).default(0),
        windowMinutes: z.number().int().min(0).max(MAX_MINUTES).default(0),
        levels: z.array(z.enum(core.TELEMETRY_LEVELS)).max(core.TELEMETRY_LEVELS.length).default([]),
        environment: z
            .string()
            .trim()
            .max(100)
            .nullish()
            .transform((value) => value || null),
        recipients: z.array(z.string().uuid()).max(MAX_RECIPIENTS).default([]),
        notifyMembers: z.boolean().default(true),
        throttleMinutes: z.number().int().min(1).max(MAX_MINUTES).default(60)
    })
    .superRefine((rule, context) => {
        if (rule.trigger === "frequency") {
            if (rule.threshold < 1) {
                context.addIssue({ code: "custom", path: ["threshold"], message: "threshold" });
            }
            if (rule.windowMinutes < 1) {
                context.addIssue({ code: "custom", path: ["windowMinutes"], message: "window" });
            }
        }
        if (!rule.notifyMembers && rule.recipients.length === 0) {
            context.addIssue({ code: "custom", path: ["recipients"], message: "nobody" });
        }
    })
    .transform((rule) => ({
        ...rule,
        levels: [...new Set(rule.levels)],
        recipients: [...new Set(rule.recipients)],
        threshold: rule.trigger === "frequency" ? rule.threshold : 0,
        windowMinutes: rule.trigger === "frequency" ? rule.windowMinutes : 0
    }));
export type AlertRuleInput = z.infer<typeof alertRuleSchema>;

export const saveRuleSchema = z.object({
    projectId: z.string().uuid(),
    ruleId: z.string().uuid().nullish(),
    rule: alertRuleSchema
});

export const ruleRefSchema = z.object({ projectId: z.string().uuid(), ruleId: z.string().uuid() });

export const toggleRuleSchema = ruleRefSchema.extend({ enabled: z.boolean() });

export const firesPageSchema = z.object({
    projectId: z.string().uuid(),
    cursor: z.string().uuid().nullish()
});

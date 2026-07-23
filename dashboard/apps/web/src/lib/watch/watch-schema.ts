/**
 * Watch alarm input, shared by the create form and the server action. A metric
 * alarm (cpu/memory) needs a threshold percent; a reachability alarm
 * (service/http) does not.
 */

import { z } from "zod";

export const ALARM_TARGET_TYPES = ["application", "domain"] as const;
export const ALARM_METRICS = ["cpu", "memory", "service", "http"] as const;

export const alarmInputSchema = z
    .object({
        name: z.string().trim().min(1).max(80),
        targetType: z.enum(ALARM_TARGET_TYPES),
        targetId: z.string().uuid(),
        metric: z.enum(ALARM_METRICS),
        operator: z.enum(["gt", "lt"]).default("gt"),
        /** Percent threshold for cpu/memory; ignored for reachability alarms. */
        threshold: z.number().min(0).max(100000).optional(),
        forPeriods: z.number().int().min(1).max(10).default(2),
        /** Optional messaging channel + peer to also alert. */
        notifyChannelId: z.string().uuid().optional(),
        notifyPeerId: z.string().trim().min(1).max(256).optional()
    })
    .superRefine((value, ctx) => {
        if ((value.metric === "cpu" || value.metric === "memory") && value.threshold === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["threshold"],
                message: "A threshold percent is required for this metric"
            });
        }
        if ((value.metric === "service" || value.metric === "http") && value.targetType === "domain" && value.metric !== "http") {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metric"], message: "Domains use the http reachability metric" });
        }
    });

export type AlarmInput = z.infer<typeof alarmInputSchema>;

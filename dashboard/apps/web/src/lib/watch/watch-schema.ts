/**
 * Watch alarm input, shared by the create form and the server action. A metric
 * alarm (cpu, memory, disk, network) needs a threshold in its unit; a
 * reachability alarm (service, http) does not. Which metrics a target can take
 * comes from `alarm-metrics`.
 */

import { z } from "zod";
import { ALARM_METRICS, ALARM_TARGET_TYPES, alarmUnit, metricsFor } from "./alarm-metrics";

export { ALARM_METRICS, ALARM_TARGET_TYPES } from "./alarm-metrics";

export const alarmInputSchema = z
    .object({
        name: z.string().trim().min(1).max(80),
        targetType: z.enum(ALARM_TARGET_TYPES),
        targetId: z.string().uuid(),
        metric: z.enum(ALARM_METRICS),
        operator: z.enum(["gt", "lt"]).default("gt"),
        /** In the metric's unit (see `alarmUnit`); ignored for reachability alarms. */
        threshold: z.number().min(0).max(100000).optional(),
        forPeriods: z.number().int().min(1).max(10).default(2),
        /** Optional messaging channel + peer to also alert. */
        notifyChannelId: z.string().uuid().optional(),
        notifyPeerId: z.string().trim().min(1).max(256).optional()
    })
    .superRefine((value, ctx) => {
        if (!metricsFor(value.targetType).includes(value.metric)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["metric"],
                message:
                    value.targetType === "domain"
                        ? "Domains use the http reachability metric"
                        : "That metric cannot be watched on this target"
            });
            return;
        }
        const unit = alarmUnit(value.metric, value.targetType);
        if (unit === null) return;
        if (value.threshold === undefined || Number.isNaN(value.threshold)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["threshold"],
                message: `A threshold in ${unit} is required for this metric`
            });
            return;
        }
        if (unit === "%" && value.threshold > 100) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["threshold"],
                message: "A percentage threshold is at most 100"
            });
        }
    });

export type AlarmInput = z.infer<typeof alarmInputSchema>;

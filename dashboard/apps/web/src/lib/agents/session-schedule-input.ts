/**
 * What a scheduled session is saved from, and how the screen shows one: the
 * part of `session-schedules.ts` a client component may import.
 */

import { z } from "zod";
import * as core from "@polaris/core";

/** Longest prompt a schedule keeps: an instruction, not a document. */
export const SESSION_SCHEDULE_PROMPT_MAX = 8000;

/** How many schedules one repository may keep. */
export const SESSION_SCHEDULES_PER_REPO = 20;

export const SESSION_SCHEDULE_RUN_STATUSES = ["started", "queued", "skipped", "failed"] as const;
export type SessionScheduleRunStatus = (typeof SESSION_SCHEDULE_RUN_STATUSES)[number];

/** What a schedule is saved from. */
export const sessionScheduleInputSchema = z.object({
    id: z.string().uuid().optional(),
    repoId: z.string().uuid(),
    cli: core.agentCliIdSchema,
    schedule: core.cronExpression,
    timezone: z
        .string()
        .trim()
        .max(64)
        .default("UTC")
        .refine(
            (value) => value !== core.AUTOMATIC_TIME_ZONE && core.isTimeZone(value),
            "That is not a time zone this server knows"
        ),
    prompt: z
        .string()
        .trim()
        .min(1, "A prompt is required")
        .max(SESSION_SCHEDULE_PROMPT_MAX)
        .refine((value) => !value.includes(String.fromCharCode(0)), "The prompt cannot contain a NUL character"),
    enabled: z.boolean().default(true)
});
export type SessionScheduleInput = z.infer<typeof sessionScheduleInputSchema>;

/** One firing as the screen shows it. */
export interface SessionScheduleRunView {
    readonly id: string;
    readonly status: SessionScheduleRunStatus;
    readonly sessionId: string | null;
    readonly error: string | null;
    readonly at: string;
}

/** A schedule as the screen shows it. */
export interface SessionScheduleView {
    readonly id: string;
    readonly cli: string;
    readonly schedule: string;
    readonly scheduleText: string;
    readonly timezone: string;
    readonly prompt: string;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly lastRunAt: string | null;
    readonly runs: readonly SessionScheduleRunView[];
}

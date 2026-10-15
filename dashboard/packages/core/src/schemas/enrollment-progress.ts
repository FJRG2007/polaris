/**
 * What happened while a machine was being added, step by step.
 *
 * An enrollment used to be one of four words - pending, claimed, failed, expired -
 * which told the operator watching the dialog nothing until the very end, and at
 * the end only the last thing that went wrong. Every stage of the exchange now
 * appends an event here, and the dialog draws the steps and their log from it as
 * they arrive.
 *
 * Events carry codes, never sentences: the dialog says them in the reader's
 * language, and an event names nothing a machine-facing endpoint could be made to
 * put on somebody's screen verbatim. The one free-text field, `detail`, is only
 * ever written by Polaris itself.
 *
 * The column is schemaless and older than any one version of this list, so it is
 * read with `readEnrollmentProgress`, which keeps what it understands and drops
 * the rest rather than failing the whole dialog over one entry.
 */

import { z } from "zod";
import { ENROLLMENT_REFUSAL_REASONS } from "./enrollment.js";

/** The stages, in the order a machine goes through them. `setup` only exists for
 *  a server Polaris prepares for deployments as soon as it joins. */
export const ENROLLMENT_STEPS = [
    "command",
    "fetched",
    "checked",
    "connect",
    "registered",
    "setup"
] as const;
export type EnrollmentStep = (typeof ENROLLMENT_STEPS)[number];

export const ENROLLMENT_EVENT_STATES = ["active", "done", "failed"] as const;
export type EnrollmentEventState = (typeof ENROLLMENT_EVENT_STATES)[number];

/**
 * Every line the log can show. The ones that end a step badly double as the key
 * for what to do about it.
 */
export const ENROLLMENT_LOG_CODES = [
    "created",
    "scriptFetched",
    "refused",
    "machineReported",
    "trying",
    "unreachable",
    "keyRefused",
    "wrongMachine",
    "connectFailed",
    "noAddress",
    "noHostKey",
    "connected",
    "registered",
    "setupQueued",
    "setupDone",
    "setupFailed",
    "setupStalled"
] as const;
export type EnrollmentLogCode = (typeof ENROLLMENT_LOG_CODES)[number];

/** What the machine said about itself when it claimed. */
export const enrollmentFactsSchema = z.object({
    platform: z.string().max(32),
    arch: z.string().max(32),
    os: z.string().max(200).optional(),
    docker: z.boolean(),
    root: z.boolean()
});
export type EnrollmentFacts = z.infer<typeof enrollmentFactsSchema>;

export const enrollmentEventSchema = z.object({
    step: z.enum(ENROLLMENT_STEPS),
    state: z.enum(ENROLLMENT_EVENT_STATES),
    code: z.enum(ENROLLMENT_LOG_CODES),
    at: z.string().max(40),
    address: z.string().max(255).optional(),
    reason: z.enum(ENROLLMENT_REFUSAL_REASONS).optional(),
    facts: enrollmentFactsSchema.optional(),
    detail: z.string().max(500).optional()
});
export type EnrollmentEvent = z.infer<typeof enrollmentEventSchema>;

/** The most events one enrollment keeps. A command is fetched and claimed a
 *  handful of times at most; this only bounds a machine that keeps retrying, and
 *  past it the oldest lines go so the latest one is always written. */
export const ENROLLMENT_PROGRESS_LIMIT = 100;

/** How long the setup after a claim may stay quiet before the dialog stops
 *  waiting on it. The outcome is written from the same process that ran it, so a
 *  restart in the middle leaves nothing to write it. */
export const ENROLLMENT_SETUP_DEADLINE_MS = 30 * 60 * 1000;

/** The stored progress, keeping each entry that still parses. */
export function readEnrollmentProgress(value: unknown): EnrollmentEvent[] {
    if (!Array.isArray(value)) return [];
    const events: EnrollmentEvent[] = [];
    for (const entry of value.slice(-ENROLLMENT_PROGRESS_LIMIT)) {
        const parsed = enrollmentEventSchema.safeParse(entry);
        if (parsed.success) events.push(parsed.data);
    }
    return events;
}

export type EnrollmentStepStatus = "waiting" | "active" | "done" | "failed";

export interface EnrollmentStepView {
    step: EnrollmentStep;
    status: EnrollmentStepStatus;
    /** This step's own log, oldest first. */
    events: EnrollmentEvent[];
    /** The event that failed it, when it did. */
    failure: EnrollmentEvent | null;
}

/**
 * The steps to draw, each with its status and log.
 *
 * A step's status is its LAST event's, because a machine that refused and was
 * then re-run has a failed event followed by a good one, and the good one is the
 * truth. A step nothing has happened to yet waits, unless a later one has
 * already moved, which means its lines were the oldest and have been dropped.
 * `setup` is only listed once something says it applies to this machine.
 */
export function enrollmentTimeline(events: readonly EnrollmentEvent[]): EnrollmentStepView[] {
    const hasSetup = events.some((event) => event.step === "setup");
    const reached = Math.max(-1, ...events.map((event) => ENROLLMENT_STEPS.indexOf(event.step)));
    return ENROLLMENT_STEPS.filter((step) => step !== "setup" || hasSetup).map((step, index) => {
        const own = events.filter((event) => event.step === step);
        const last = own.at(-1);
        const status: EnrollmentStepStatus = last
            ? last.state
            : index < reached
              ? "done"
              : "waiting";
        return { step, status, events: own, failure: status === "failed" ? (last ?? null) : null };
    });
}

/** Whether there is still something to watch after the server has been
 *  registered: its setup has been queued and has not finished either way. */
export function enrollmentStillRunning(events: readonly EnrollmentEvent[]): boolean {
    const setup = events.filter((event) => event.step === "setup").at(-1);
    return setup?.state === "active";
}

/** The log with a setup that has been quiet past its deadline closed as
 *  stalled, so nothing waits on an outcome no one is left to write. */
export function settleStalledSetup(events: EnrollmentEvent[], now: Date): EnrollmentEvent[] {
    const setup = events.filter((event) => event.step === "setup").at(-1);
    if (setup?.state !== "active") return events;
    const since = new Date(setup.at).getTime();
    if (Number.isFinite(since) && now.getTime() - since < ENROLLMENT_SETUP_DEADLINE_MS)
        return events;
    return [
        ...events,
        { step: "setup", state: "failed", code: "setupStalled", at: now.toISOString() }
    ];
}

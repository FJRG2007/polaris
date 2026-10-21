/**
 * The central automations graph: what an automation is, as stored, and the pure
 * rules every reader of it shares - the editor in the browser, the engine on the
 * server and the tests.
 *
 * A graph is a DAG of typed nodes joined by edges from a named output port to a
 * node. Triggers are nodes nothing points at. Each automation also has a Finally
 * lane: a second, separate flow that runs once after the main one ends, whatever
 * way it ended, so "always do Z at the end" is one place in the editor instead of
 * a wire from every node that can fail.
 *
 * Nothing in here evaluates code. A reference is a dotted path inside `{{ }}`,
 * looked up in the run's context and nothing else.
 */

import { z } from "zod";
import { nextCronRun, parseCron } from "./cron.js";
import { durationSchema, durationSeconds } from "./automation-schema.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const KB = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every bound the engine enforces, in one place so the numbers are read, not guessed. */
export const AUTOMATION_LIMITS = {
    nodes: 200,
    edges: 400,
    perShelf: 500,
    nameLength: 120,
    descriptionLength: 1000,
    stepsPerRun: 1000,
    eventPayloadBytes: 256 * KB,
    stepDataBytes: 64 * KB,
    runDataBytes: 2 * 1024 * KB,
    stepActiveMs: 60_000,
    httpTimeoutMs: 30_000,
    httpResponseBytes: 1024 * KB,
    httpRedirects: 5,
    longestWaitMs: 30 * DAY_MS,
    runLifetimeMs: 35 * DAY_MS,
    depth: 4,
    conditionDepth: 4,
    maxRunsCeiling: 50,
    rateLimitCeiling: 500,
    /** How long a run is held by the process stepping it before another may take it. */
    leaseMs: 2 * 60_000,
    /** How late a schedule may fire after a restart before its occurrence is skipped. */
    catchUpMs: 10 * 60_000,
    keepRuns: 100,
    keepRunsDays: 30,
    keepTestRuns: 20,
    eventKeepDays: 7,
    secretsPerShelf: 200,
    secretLength: 4096,
    textLength: 4000,
    notes: 100,
    noteLength: 2000,
    /** A pinned sample, the same ceiling as a stored step output. */
    pinBytes: 64 * KB,
    /** Versions listed in the history; every one is kept. */
    versionsListed: 50,
    runsPage: 50,
    /** Items one For each walks, and passes one Repeat makes. */
    loopItems: 1000,
    repeatPasses: 100,
    loopBatch: 100,
    /** Outputs a Choose may have, and lanes an At the same time. */
    switchCases: 10,
    parallelLanes: 8,
    joinInputs: 20,
    /** Retry on fail: tries counted with the first, and the longest wait between two. */
    retryTries: 5,
    retryWaitSeconds: 3600,
    /** Inputs a called automation declares, and values an Answer or Announce carries. */
    callInputs: 20,
    /** Trigger combinators: how far apart the members may fire. */
    combineWindowSeconds: 30 * 24 * 60 * 60,
    /** Automation events one shelf may announce in ten minutes. */
    announceRate: 200,
    /** Try blocks and loops inside one another. */
    scopeDepth: 8,
    /** Wait for a condition: the shortest and longest gap between two checks on the clock. */
    conditionRecheckMinSeconds: 60,
    conditionRecheckMaxSeconds: 24 * 60 * 60,
    /** Waiting conditions one automation event checks again. */
    conditionWaitsPerEvent: 200
} as const;

/** The event every live run sends when it ends, whatever the outcome. */
export const AUTOMATION_FINISHED_EVENT = "automation.finished";
/** Event names under this prefix are sent by Polaris itself; Announce may not use them. */
export const RESERVED_EVENT_PREFIX = "automation.";

// ---------------------------------------------------------------------------
// Statuses and modes
// ---------------------------------------------------------------------------

export const AUTOMATION_MODES = ["single", "restart", "queued", "parallel"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
/** What a new automation starts as. */
export const DEFAULT_AUTOMATION_MODE: AutomationMode = "single";
export const DEFAULT_MAX_RUNS = 10;
export const DEFAULT_RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 10 * 60_000;

export const RUN_STATUSES = [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "stopped",
    "cancelled",
    "refused",
    "limited",
    "skipped",
    "timedOut"
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** A run that still holds a place: it counts against the mode and the queue. */
export const ACTIVE_RUN_STATUSES = ["running", "waiting"] as const satisfies readonly RunStatus[];
export const FINISHED_RUN_STATUSES = [
    "succeeded",
    "failed",
    "stopped",
    "cancelled",
    "refused",
    "limited",
    "skipped",
    "timedOut"
] as const satisfies readonly RunStatus[];

/** How a run that had started can end: what "automation.finished" carries as its outcome. */
export const FINISHED_EVENT_OUTCOMES = [
    "succeeded",
    "failed",
    "stopped",
    "cancelled",
    "timedOut"
] as const satisfies readonly RunStatus[];

/**
 * Which endings of another automation an "automation.finished" trigger or wait
 * takes; empty takes every one. Ignored for any other event name.
 */
const finishedOutcomes = z
    .array(z.enum(FINISHED_EVENT_OUTCOMES))
    .max(FINISHED_EVENT_OUTCOMES.length)
    .default([]);

/** Whether an event, by name and payload, is one a trigger or wait with these outcomes takes. */
export function takesOutcome(
    name: string,
    outcomes: readonly string[] | undefined,
    payload: Record<string, unknown>
): boolean {
    if (name !== AUTOMATION_FINISHED_EVENT || !outcomes?.length) return true;
    return outcomes.includes(String(payload.outcome));
}

export function runFinished(status: string): boolean {
    return (FINISHED_RUN_STATUSES as readonly string[]).includes(status);
}

export const STEP_STATUSES = [
    "ready",
    "running",
    "waiting",
    "ok",
    "failed",
    "skipped",
    "refused",
    "timedOut",
    "interrupted",
    /** A failed try that was tried again. */
    "retried"
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const FINALLY_STATES = ["none", "pending", "done", "failed"] as const;
export type FinallyState = (typeof FINALLY_STATES)[number];

/** The iteration a Finally lane step carries, so its rows never collide with the main flow's. */
export const FINALLY_ITERATION = "f";
export const MAIN_ITERATION = "0";

export type Admission = "start" | "queue" | "skip" | "limit" | "restart";

/**
 * What happens to a new firing, given what the automation is already doing.
 *
 * The rate limit is checked first and in every mode: it is the guard against an
 * automation that triggers itself, and a mode must not be a way around it.
 */
export function admitRun(input: {
    mode: AutomationMode;
    maxRuns: number;
    rateLimit: number;
    /** Runs running or waiting now. */
    active: number;
    /** Runs queued behind them. */
    queued: number;
    /** Runs started in the last `RATE_WINDOW_MS`. */
    recent: number;
}): Admission {
    if (input.recent >= input.rateLimit) return "limit";
    switch (input.mode) {
        case "single":
            return input.active > 0 ? "skip" : "start";
        case "restart":
            return input.active > 0 ? "restart" : "start";
        case "queued":
            if (input.active === 0 && input.queued === 0) return "start";
            return input.queued < input.maxRuns ? "queue" : "skip";
        case "parallel":
            return input.active < input.maxRuns ? "start" : "skip";
    }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const REFERENCE = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;
const WHOLE_REFERENCE = /^\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** One value out of the context by a dotted path, or undefined. Own properties only. */
export function resolvePath(context: unknown, path: string): unknown {
    let at: unknown = context;
    for (const segment of path.split(".")) {
        if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
        if (at === null || typeof at !== "object") return undefined;
        if (!Object.prototype.hasOwnProperty.call(at, segment)) return undefined;
        at = (at as Record<string, unknown>)[segment];
    }
    return at;
}

function asText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
}

/** A text field with its references filled in as text. */
export function interpolate(text: string, context: unknown): string {
    return text.replace(REFERENCE, (_, path: string) => asText(resolvePath(context, path)));
}

/** A typed field: one whole reference keeps the value's own type; anything else is text. */
export function referenceValue(text: string, context: unknown): unknown {
    const whole = WHOLE_REFERENCE.exec(text.trim());
    if (whole) return resolvePath(context, whole[1]!);
    return interpolate(text, context);
}

/** Every path a text refers to, for the editor's "this step gives no such value". */
export function automationReferencesIn(text: string): string[] {
    return [...text.matchAll(REFERENCE)].map((match) => match[1]!);
}

/** Replace every reference to a path with its value inserted as JSON, never as concatenated text. */
export function jsonWithReferences(value: unknown, context: unknown): unknown {
    if (typeof value === "string") return referenceValue(value, context);
    if (Array.isArray(value)) return value.map((item) => jsonWithReferences(item, context));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (FORBIDDEN_SEGMENTS.has(key)) continue;
            out[key] = jsonWithReferences(item, context);
        }
        return out;
    }
    return value;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const COMPARE_OPERATORS = [
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "notContains",
    "empty",
    "notEmpty"
] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];
/** Operators that take no right-hand value. */
export const UNARY_OPERATORS: readonly CompareOperator[] = ["empty", "notEmpty"];

const text = (max: number = AUTOMATION_LIMITS.textLength) => z.string().max(max);

export const compareLeafSchema = z.object({
    kind: z.literal("compare"),
    left: text(500),
    op: z.enum(COMPARE_OPERATORS),
    right: text(500).default("")
});
export type CompareLeaf = z.infer<typeof compareLeafSchema>;

/** Holds when the run was started by one of these trigger nodes. */
export const triggeredByLeafSchema = z.object({
    kind: z.literal("triggeredBy"),
    triggers: z.array(z.string().min(1).max(64)).max(20).default([])
});
export type TriggeredByLeaf = z.infer<typeof triggeredByLeafSchema>;

export interface ConditionGroup {
    kind: "group";
    join: "all" | "any";
    negate?: boolean;
    items: ConditionNode[];
}
export type ConditionNode = CompareLeaf | TriggeredByLeaf | ConditionGroup;

export const conditionGroupSchema: z.ZodType<ConditionGroup, z.ZodTypeDef, unknown> = z.lazy(() =>
    z.object({
        kind: z.literal("group"),
        join: z.enum(["all", "any"]),
        negate: z.boolean().optional(),
        items: z
            .array(z.union([compareLeafSchema, triggeredByLeafSchema, conditionGroupSchema]))
            .max(20)
    })
) as z.ZodType<ConditionGroup, z.ZodTypeDef, unknown>;

function conditionDepth(node: ConditionNode): number {
    if (node.kind !== "group") return 0;
    return 1 + Math.max(0, ...node.items.map(conditionDepth));
}

/** A condition tree no deeper than the editor can draw. */
export const conditionTreeSchema = conditionGroupSchema.refine(
    (tree) => conditionDepth(tree) <= AUTOMATION_LIMITS.conditionDepth,
    { message: "conditionTooDeep" }
);

function asNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function isEmpty(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
}

export function checkCompare(leaf: CompareLeaf, context: unknown): boolean {
    const left = referenceValue(leaf.left, context);
    if (leaf.op === "empty") return isEmpty(left);
    if (leaf.op === "notEmpty") return !isEmpty(left);
    const right = referenceValue(leaf.right, context);
    const ln = asNumber(left);
    const rn = asNumber(right);
    switch (leaf.op) {
        case "eq":
            return ln !== null && rn !== null ? ln === rn : asText(left) === asText(right);
        case "ne":
            return ln !== null && rn !== null ? ln !== rn : asText(left) !== asText(right);
        case "gt":
            return ln !== null && rn !== null && ln > rn;
        case "gte":
            return ln !== null && rn !== null && ln >= rn;
        case "lt":
            return ln !== null && rn !== null && ln < rn;
        case "lte":
            return ln !== null && rn !== null && ln <= rn;
        case "contains":
            return Array.isArray(left)
                ? left.some((item) => asText(item) === asText(right))
                : asText(left).toLowerCase().includes(asText(right).toLowerCase());
        case "notContains":
            return Array.isArray(left)
                ? !left.some((item) => asText(item) === asText(right))
                : !asText(left).toLowerCase().includes(asText(right).toLowerCase());
    }
}

/** An empty group holds: "only if nothing" is no gate at all. */
export function checkCondition(node: ConditionNode, context: unknown): boolean {
    if (node.kind === "compare") return checkCompare(node, context);
    if (node.kind === "triggeredBy") {
        const id = resolvePath(context, "trigger.id");
        return typeof id === "string" && node.triggers.includes(id);
    }
    const results = node.items.map((item) => checkCondition(item, context));
    const held =
        node.join === "all"
            ? results.every(Boolean)
            : results.length === 0 || results.some(Boolean);
    return node.negate ? !held : held;
}

// ---------------------------------------------------------------------------
// Core node types
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export const SECRET_KINDS = ["url", "token", "basic", "header"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const CHAT_PRESETS = ["slack", "discord", "teams"] as const;
export type ChatPreset = (typeof CHAT_PRESETS)[number];
export const MESSAGE_LEVELS = ["info", "success", "warning", "danger"] as const;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "clockTime");
const secretRef = z.string().uuid();
const pairs = z.array(z.object({ name: text(200).min(1), value: text(2000) })).max(30);

export const scheduleConfigSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("every"),
        amount: z.number().int().min(1).max(10_000),
        unit: z.enum(["minutes", "hours", "days"])
    }),
    z.object({
        kind: z.literal("daily"),
        times: z.array(clock).min(1).max(12),
        /** 0 = Sunday. Empty is every day. */
        days: z.array(z.number().int().min(0).max(6)).max(7).default([])
    }),
    z.object({
        kind: z.literal("cron"),
        expression: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .refine((value) => {
                try {
                    parseCron(value);
                    return true;
                } catch {
                    return false;
                }
            }, "cronInvalid")
    })
]);
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;

export const httpConfigSchema = z
    .object({
        method: z.enum(HTTP_METHODS).default("POST"),
        /** The address, with references; or empty when a URL secret holds it. */
        url: text(2000).default(""),
        urlSecretId: secretRef.nullable().default(null),
        auth: z
            .discriminatedUnion("kind", [
                z.object({ kind: z.literal("none") }),
                z.object({ kind: z.literal("bearer"), secretId: secretRef }),
                z.object({ kind: z.literal("basic"), secretId: secretRef }),
                z.object({
                    kind: z.literal("header"),
                    secretId: secretRef,
                    header: text(100).min(1)
                })
            ])
            .default({ kind: "none" }),
        query: pairs.default([]),
        headers: pairs.default([]),
        body: z
            .discriminatedUnion("kind", [
                z.object({ kind: z.literal("none") }),
                /** JSON text; references inside string values are inserted as JSON values. */
                z.object({ kind: z.literal("json"), json: text(AUTOMATION_LIMITS.textLength * 4) }),
                z.object({ kind: z.literal("form"), fields: pairs }),
                z.object({ kind: z.literal("text"), text: text(AUTOMATION_LIMITS.textLength * 4) })
            ])
            .default({ kind: "none" }),
        timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(AUTOMATION_LIMITS.httpTimeoutMs / 1000)
            .default(15),
        /** Treat an answer outside 2xx as success rather than failing the step. */
        acceptAnyStatus: z.boolean().default(false)
    })
    .refine((config) => config.url.trim() !== "" || config.urlSecretId !== null, {
        message: "urlRequired",
        path: ["url"]
    })
    .refine((config) => config.body.kind !== "json" || validJsonTemplate(config.body.json), {
        message: "jsonInvalid",
        path: ["body"]
    });
export type HttpConfig = z.infer<typeof httpConfigSchema>;

function validJsonTemplate(source: string): boolean {
    try {
        JSON.parse(source);
        return true;
    } catch {
        return false;
    }
}

export const chatPresetConfigSchema = z.object({
    /** A URL secret holding the incoming-webhook address. */
    secretId: secretRef,
    title: text(256).min(1),
    text: text(AUTOMATION_LIMITS.textLength).default(""),
    link: text(2000).default(""),
    level: z.enum(MESSAGE_LEVELS).default("info")
});

export const waitConfigSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("duration"),
        duration: durationSchema.refine(
            (value) => durationSeconds(value) * 1000 <= AUTOMATION_LIMITS.longestWaitMs,
            "waitTooLong"
        )
    }),
    /** The next time the automation's clock shows this time (on one of these days). */
    z.object({
        kind: z.literal("until"),
        time: clock,
        days: z.array(z.number().int().min(0).max(6)).max(7).default([])
    })
]);

/** A name an automation event goes by: lowercase words joined by dots, dashes or underscores. */
export const eventName = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "eventNameInvalid");

/** Named values with references, for Answer, Announce and a call's inputs. */
const valuePairs = z
    .array(
        z.object({
            name: z
                .string()
                .trim()
                .min(1)
                .max(64)
                .regex(/^[A-Za-z_][\w-]*$/, "valueNameInvalid"),
            value: text(2000).default("")
        })
    )
    .max(AUTOMATION_LIMITS.callInputs)
    .default([]);

export const CALL_INPUT_KINDS = ["text", "number", "boolean", "json"] as const;

export const calledConfigSchema = z.object({
    inputs: z
        .array(
            z.object({
                name: z
                    .string()
                    .trim()
                    .min(1)
                    .max(64)
                    .regex(/^[A-Za-z_][\w-]*$/, "valueNameInvalid"),
                kind: z.enum(CALL_INPUT_KINDS).default("text"),
                required: z.boolean().default(false)
            })
        )
        .max(AUTOMATION_LIMITS.callInputs)
        .default([])
});
export type CalledConfig = z.infer<typeof calledConfigSchema>;

export const switchConfigSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("rules"),
        cases: z
            .array(z.object({ label: text(60).default(""), condition: conditionTreeSchema }))
            .min(1)
            .max(AUTOMATION_LIMITS.switchCases),
        /** Leave by every case that holds, rather than the first. */
        every: z.boolean().default(false),
        fallback: z.boolean().default(true)
    }),
    z.object({
        kind: z.literal("value"),
        value: text(500).min(1),
        cases: z
            .array(z.object({ label: text(60).default(""), equals: text(500) }))
            .min(1)
            .max(AUTOMATION_LIMITS.switchCases),
        ignoreCase: z.boolean().default(true),
        fallback: z.boolean().default(true)
    })
]);
export type SwitchConfig = z.infer<typeof switchConfigSchema>;

export const JOIN_WAITS = ["all", "any", "count"] as const;
export const JOIN_OUTPUTS = ["byInput", "append", "keep"] as const;

export const joinConfigSchema = z.object({
    /** All inputs that can still arrive, the first one, or at least `count` of them. */
    wait: z.enum(JOIN_WAITS).default("all"),
    count: z.number().int().min(1).max(AUTOMATION_LIMITS.joinInputs).default(2),
    /** Each input under its node id, every input in a list, or one input's data only. */
    output: z.enum(JOIN_OUTPUTS).default("byInput"),
    keep: z.string().max(64).nullable().default(null)
});
export type JoinConfig = z.infer<typeof joinConfigSchema>;

/** A wait no shorter than a second and no longer than the longest wait. */
const waitTimeout = durationSchema.refine(
    (value) =>
        durationSeconds(value) >= 1 &&
        durationSeconds(value) * 1000 <= AUTOMATION_LIMITS.longestWaitMs,
    "waitTooLong"
);

export const waitConditionConfigSchema = z.object({
    condition: conditionTreeSchema,
    timeout: waitTimeout,
    /** How often the clock checks it again, besides every automation event on the shelf. */
    every: durationSchema
        .refine(
            (value) =>
                durationSeconds(value) >= AUTOMATION_LIMITS.conditionRecheckMinSeconds &&
                durationSeconds(value) <= AUTOMATION_LIMITS.conditionRecheckMaxSeconds,
            "recheckOutOfRange"
        )
        .default({ amount: 5, unit: "minutes" })
});
export type WaitConditionConfig = z.infer<typeof waitConditionConfigSchema>;

export const repeatConfigSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("times"),
        count: z.number().int().min(1).max(AUTOMATION_LIMITS.repeatPasses)
    }),
    /** Checked before each pass; stops when it holds, or after `max` passes. */
    z.object({
        kind: z.literal("until"),
        condition: conditionTreeSchema,
        max: z.number().int().min(1).max(AUTOMATION_LIMITS.repeatPasses).default(10)
    })
]);
export type RepeatConfig = z.infer<typeof repeatConfigSchema>;

/**
 * Where a "tell somebody" step delivers it: the bell, the account's own
 * notification destinations (a phone number, a Telegram or Slack hook), email,
 * and a chat channel through one of its webhooks - never as the person. Left
 * out, the bell alone, which is what every step saved before this existed did.
 *
 * enigma: an outbound HTTP request with headers and auth is not a channel here.
 * feat/webhooks-in-automations moves outbound webhooks into Automations; it adds
 * itself as one more key of this object, delivered by `deliverAutomationNotice`.
 */
export const noticeDeliverySchema = z
    .object({
        bell: z.boolean().default(true),
        email: z.boolean().default(false),
        /** Ids of the account's own notification destinations. */
        destinations: z.array(z.string().uuid()).max(10).default([]),
        /** A channel webhook, and which secret it had when it was chosen. */
        chat: z
            .object({
                webhookId: z.string().uuid(),
                stamp: z.string().regex(/^[0-9a-f]{16}$/)
            })
            .nullable()
            .default(null),
        /** Webhooks of Deploy projects the account runs - the endpoints Watch alerts leave through. */
        projectWebhooks: z.array(z.string().uuid()).max(10).default([]),
        /** A connected messaging channel of the account, and who on it is told. */
        messaging: z
            .object({
                channelId: z.string().uuid(),
                peerId: z.string().trim().min(1).max(256)
            })
            .nullable()
            .default(null)
    })
    .refine(
        (delivery) =>
            delivery.bell ||
            delivery.email ||
            delivery.destinations.length > 0 ||
            delivery.chat !== null ||
            delivery.projectWebhooks.length > 0 ||
            delivery.messaging !== null,
        "noticeNoChannel"
    );
export type NoticeDelivery = z.infer<typeof noticeDeliverySchema>;

/** What a step with no delivery set does: the bell, as it always did. */
export const DEFAULT_NOTICE_DELIVERY: NoticeDelivery = {
    bell: true,
    email: false,
    destinations: [],
    chat: null,
    projectWebhooks: [],
    messaging: null
};

/** How a threshold trigger compares a reading with its value. */
export const THRESHOLD_COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
export type ThresholdComparator = (typeof THRESHOLD_COMPARATORS)[number];

/**
 * "When a reading crosses a threshold": a polled reading (`source`, such as
 * `host.cpu` or `ups.charge`, of one `subjectId`) judged against `value`. It
 * fires on the transition into alarm once `streak` samples in a row breach,
 * and on the way back when `recovery` is on - never on every sample.
 */
export const thresholdConfigSchema = z.object({
    source: z
        .string()
        .max(80)
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, "thresholdSource"),
    subjectId: z.string().uuid("thresholdSubject"),
    comparator: z.enum(THRESHOLD_COMPARATORS).default("gt"),
    value: z.number().finite(),
    streak: z.number().int().min(1).max(60).default(3),
    recovery: z.boolean().default(false)
});
export type ThresholdConfig = z.infer<typeof thresholdConfigSchema>;

/** Every node type core contributes, with the config each one takes. */
export const CORE_NODE_CONFIGS = {
    "core.manual": z.object({}).strict(),
    "core.schedule": scheduleConfigSchema,
    "core.webhook": z.object({
        method: z.enum(["POST", "GET", "any"]).default("POST"),
        /** Bumped by "New address": the old address stops working. */
        rotation: z.number().int().min(0).max(1_000_000).default(0)
    }),
    "core.if": z.object({ condition: conditionTreeSchema }),
    "core.wait": waitConfigSchema,
    "core.notify": z.object({
        title: text(200).min(1),
        body: text(AUTOMATION_LIMITS.textLength).default(""),
        delivery: noticeDeliverySchema.optional()
    }),
    "core.http": httpConfigSchema,
    "core.chat": chatPresetConfigSchema.extend({ preset: z.enum(CHAT_PRESETS) }),
    "core.called": calledConfigSchema,
    "core.onEvent": z.object({ name: eventName, outcomes: finishedOutcomes }),
    "core.failed": z.object({
        /** Empty: any other automation on this shelf. */
        automations: z.array(z.string().uuid()).max(50).default([])
    }),
    "core.switch": switchConfigSchema,
    "core.parallel": z.object({
        lanes: z.number().int().min(2).max(AUTOMATION_LIMITS.parallelLanes).default(2)
    }),
    "core.join": joinConfigSchema,
    "core.forEach": z.object({
        /** A whole reference to a list, such as {{steps.http1.body.items}}. */
        items: text(500).min(1),
        /** Items handed to one pass of the loop; 1 walks them one by one. */
        batch: z.number().int().min(1).max(AUTOMATION_LIMITS.loopBatch).default(1)
    }),
    "core.repeat": repeatConfigSchema,
    "core.stop": z.object({
        as: z.enum(["succeeded", "failed"]).default("succeeded"),
        reason: text(200).default("")
    }),
    "core.waitEvent": z.object({
        name: eventName,
        timeout: waitTimeout,
        /** Checked against the event as `event.*`; the wait goes on when it does not hold. */
        filter: conditionTreeSchema.optional(),
        outcomes: finishedOutcomes
    }),
    "core.run": z.object({
        automationId: z.string().uuid(),
        inputs: valuePairs,
        /** Wait for it to finish and take its answer; off: start it and carry on. */
        wait: z.boolean().default(true)
    }),
    "core.answer": z.object({ outputs: valuePairs }),
    /** Named values worked out once, read by later steps as {{steps.<id>.values.<name>}}. */
    "core.set": z.object({ values: valuePairs }),
    /**
     * A message posted into a space channel through one of its webhooks, under
     * the webhook's name - never as a person, and never into a direct message or
     * a group. `stamp` is which secret the webhook had when it was chosen.
     */
    "core.message": z.object({
        webhookId: z.string().uuid(),
        stamp: z.string().regex(/^[0-9a-f]{16}$/),
        body: text(AUTOMATION_LIMITS.textLength).min(1)
    }),
    "core.announce": z.object({
        name: eventName.refine(
            (value) => !value.startsWith(RESERVED_EVENT_PREFIX),
            "eventNameReserved"
        ),
        payload: valuePairs
    }),
    "core.try": z.object({
        /** A run whose On error path completes does not end as failed. */
        recover: z.boolean().default(false)
    }),
    "core.waitCondition": waitConditionConfigSchema,
    "core.threshold": thresholdConfigSchema
} as const;
export type CoreNodeType = keyof typeof CORE_NODE_CONFIGS;
export const CORE_NODE_TYPES = Object.keys(CORE_NODE_CONFIGS) as CoreNodeType[];

/** "flow" nodes steer tokens (Choose, At the same time, Join, loops, Stop) and do nothing outside the run. */
export type NodeRole = "trigger" | "condition" | "action" | "flow";

export interface CoreNodeMeta {
    readonly role: NodeRole;
    /** Output ports besides "next"; for a condition or a flow node with `own`, all of them. */
    readonly ports: readonly string[];
    /** The node leaves only by its own ports, never by "next". */
    readonly own?: boolean;
    /** Safe to run again after a crash part-way through it. */
    readonly idempotent: boolean;
}

export const CORE_NODE_META: Readonly<Record<CoreNodeType, CoreNodeMeta>> = {
    "core.manual": { role: "trigger", ports: [], idempotent: true },
    "core.schedule": { role: "trigger", ports: [], idempotent: true },
    "core.webhook": { role: "trigger", ports: [], idempotent: true },
    "core.if": { role: "condition", ports: ["then", "else"], idempotent: true },
    "core.wait": { role: "action", ports: [], idempotent: true },
    "core.notify": { role: "action", ports: [], idempotent: false },
    "core.http": { role: "action", ports: [], idempotent: false },
    "core.chat": { role: "action", ports: [], idempotent: false },
    "core.called": { role: "trigger", ports: [], idempotent: true },
    "core.onEvent": { role: "trigger", ports: [], idempotent: true },
    "core.failed": { role: "trigger", ports: [], idempotent: true },
    // Ports of Choose and At the same time follow their config: see nodePorts.
    "core.switch": { role: "flow", ports: [], own: true, idempotent: true },
    "core.parallel": { role: "flow", ports: [], own: true, idempotent: true },
    "core.join": { role: "flow", ports: [], idempotent: true },
    "core.forEach": { role: "flow", ports: ["each", "done"], own: true, idempotent: true },
    "core.repeat": { role: "flow", ports: ["each", "done"], own: true, idempotent: true },
    "core.stop": { role: "flow", ports: [], own: true, idempotent: true },
    "core.waitEvent": { role: "action", ports: ["timeout"], idempotent: true },
    // The child run's firing key is unique per step, so starting it again finds the same run.
    "core.run": { role: "action", ports: [], idempotent: true },
    "core.answer": { role: "action", ports: [], idempotent: true },
    "core.set": { role: "action", ports: [], idempotent: true },
    "core.message": { role: "action", ports: [], idempotent: false },
    // The event's dedupe key is the step's idempotency key.
    "core.announce": { role: "action", ports: [], idempotent: true },
    "core.try": {
        role: "flow",
        ports: ["body", "then", "catch", "always"],
        own: true,
        idempotent: true
    },
    "core.waitCondition": { role: "action", ports: ["timeout"], idempotent: true },
    "core.threshold": { role: "trigger", ports: [], idempotent: true }
};

/** Loop nodes: their "each" port starts a body that runs once per item or pass. */
export const LOOP_NODE_TYPES = ["core.forEach", "core.repeat"] as const;
export function isLoopNode(type: string): boolean {
    return (LOOP_NODE_TYPES as readonly string[]).includes(type);
}

/** Scope nodes: a loop or a Try, whose body port starts steps that run inside it. */
export function isScopeNode(type: string): boolean {
    return isLoopNode(type) || type === "core.try";
}

/** The port a scope node's body starts from: "each" for a loop, "body" for a Try. */
export function bodyPort(type: string): string | null {
    return isLoopNode(type) ? "each" : type === "core.try" ? "body" : null;
}

/** Node types that may take the "error" port: everything that can fail on its own. */
export function canTakeErrorPort(type: string): boolean {
    const role = nodeRole(type);
    return role === "action" || (role === null && type.length > 0);
}

/** The ports of a Choose, from its config: one per case, then "otherwise" when it has one. */
export function switchPorts(config: unknown): string[] {
    const parsed = switchConfigSchema.safeParse(config);
    if (!parsed.success) return ["otherwise"];
    const cases = parsed.data.cases.map((_, index) => `case${index + 1}`);
    return parsed.data.fallback ? [...cases, "otherwise"] : cases;
}

/**
 * Where each output port of a node goes when its settings change, so the wires
 * and nested steps behind it follow: a Choose case keeps its own when cases
 * are added or removed around it (matched by the case itself, since an edit
 * replaces only the case it touches), every other port by its name. A port
 * that no longer exists maps to null.
 */
export function portMoves(
    before: { readonly type: string; readonly config?: unknown; readonly onError?: string },
    after: { readonly type: string; readonly config?: unknown; readonly onError?: string }
): Map<string, string | null> {
    const next = new Set(nodePorts(after.type, after));
    const oldCases = (before.config as { cases?: unknown[] } | undefined)?.cases ?? [];
    const newCases = (after.config as { cases?: unknown[] } | undefined)?.cases ?? [];
    const moves = new Map<string, string | null>();
    for (const port of nodePorts(before.type, before)) {
        const choice = /^case(\d+)$/.exec(port);
        if (choice && oldCases.length !== newCases.length) {
            const at = newCases.indexOf(oldCases[Number(choice[1]) - 1]);
            const moved = at >= 0 ? `case${at + 1}` : null;
            moves.set(port, moved && next.has(moved) ? moved : null);
        } else moves.set(port, next.has(port) ? port : null);
    }
    return moves;
}

export function parallelPorts(config: unknown): string[] {
    const parsed = CORE_NODE_CONFIGS["core.parallel"].safeParse(config);
    const lanes = parsed.success ? parsed.data.lanes : 2;
    return Array.from({ length: lanes }, (_, index) => `lane${index + 1}`);
}

export function isCoreNodeType(type: string): type is CoreNodeType {
    return Object.prototype.hasOwnProperty.call(CORE_NODE_CONFIGS, type);
}

/** The roles an app's node type may have, named in its type. */
export const APP_NODE_ROLES = ["trigger", "condition", "action"] as const;
export type AppNodeRole = (typeof APP_NODE_ROLES)[number];

/**
 * An app's node type names its role: `<app>.<role>.<name>`, e.g.
 * `places.trigger.change`. Read from the type alone, so a graph holding a node
 * of an app that is not installed keeps its ports and its place in the run.
 */
export function appNodeRole(type: string): AppNodeRole | null {
    const parts = type.split(".");
    if (parts.length < 3 || parts[0] === "core" || !parts[0] || !parts[2]) return null;
    return (APP_NODE_ROLES as readonly string[]).includes(parts[1]!)
        ? (parts[1] as AppNodeRole)
        : null;
}

/** The app an app's node type belongs to, or null for core's own. */
export function nodeTypeApp(type: string): string | null {
    return appNodeRole(type) ? type.split(".")[0]! : null;
}

/**
 * The ports a node may be wired from. A condition and an `own` flow node have
 * only their own; everything else has "next". Given the node, the ports its
 * config adds (Choose cases, parallel lanes) and its error port are included.
 */
export function nodePorts(
    type: string,
    node?: { readonly config?: unknown; readonly onError?: string }
): readonly string[] {
    const errorPort = node?.onError === "port" && canTakeErrorPort(type) ? ["error"] : [];
    if (!isCoreNodeType(type))
        return appNodeRole(type) === "condition"
            ? ["then", "else", ...errorPort]
            : ["next", ...errorPort];
    const meta = CORE_NODE_META[type];
    if (type === "core.switch") return switchPorts(node?.config);
    if (type === "core.parallel") return parallelPorts(node?.config);
    const own = meta.role === "condition" || meta.own ? meta.ports : ["next", ...meta.ports];
    return [...own, ...errorPort];
}

/** The port a node leaves by when it is switched off or carries on after a failure. */
export function passPort(type: string, node?: { readonly config?: unknown }): string | null {
    if (type === "core.stop") return null;
    if (isLoopNode(type)) return "done";
    // A switched-off Try skips its body: nothing failed.
    if (type === "core.try") return "then,always";
    return nodePorts(type, { config: node?.config })[0] ?? null;
}

export function nodeRole(type: string): NodeRole | null {
    return isCoreNodeType(type) ? CORE_NODE_META[type].role : appNodeRole(type);
}

/** The next time a schedule is due after `after`, in the automation's time zone. */
export function nextScheduleDue(
    config: ScheduleConfig,
    after: Date,
    timeZone: string
): Date | null {
    if (config.kind === "every") {
        const unit =
            config.unit === "minutes" ? 60_000 : config.unit === "hours" ? 3_600_000 : DAY_MS;
        return new Date(after.getTime() + config.amount * unit);
    }
    if (config.kind === "cron") return nextCronRun(parseCron(config.expression), after, timeZone);
    return nextDailyDue(config.times, config.days, after, timeZone);
}

/** The soonest of several clock times on some weekdays, through the cron reader so DST is handled once. */
export function nextDailyDue(
    times: readonly string[],
    days: readonly number[],
    after: Date,
    timeZone: string
): Date | null {
    const weekdays = days.length === 0 ? "*" : [...new Set(days)].sort().join(",");
    let soonest: Date | null = null;
    for (const time of times) {
        const [hour, minute] = time.split(":").map(Number);
        const next = nextCronRun(parseCron(`${minute} ${hour} * * ${weekdays}`), after, timeZone);
        if (next && (!soonest || next < soonest)) soonest = next;
    }
    return soonest;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

const nodeId = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/);

export const graphNodeSchema = z.object({
    id: nodeId,
    type: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z][\w-]*(\.[\w-]+)+$/),
    typeVersion: z.number().int().min(1).max(1000).default(1),
    /** Validated against the node type's own schema separately: an app's node may be unavailable here. */
    config: z.unknown().default({}),
    alias: z.string().trim().max(80).optional(),
    note: z.string().trim().max(250).optional(),
    enabled: z.boolean().optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
    /** Stop the run, carry on by the first port, or leave by the "error" port. */
    onError: z.enum(["stop", "continue", "port"]).optional(),
    /** Try again on a failure, `tries` times in all, waiting between tries. */
    retry: z
        .object({
            tries: z.number().int().min(2).max(AUTOMATION_LIMITS.retryTries),
            waitSeconds: z.number().int().min(1).max(AUTOMATION_LIMITS.retryWaitSeconds),
            backoff: z.enum(["fixed", "double"]).default("fixed")
        })
        .optional(),
    /** A sample output used instead of running the node, in test runs of the draft only. Never published. */
    pinned: z.unknown().optional()
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphNoteSchema = z.object({
    id: nodeId,
    text: z.string().max(AUTOMATION_LIMITS.noteLength).default(""),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    size: z
        .object({
            width: z.number().finite().min(120).max(1200),
            height: z.number().finite().min(60).max(1200)
        })
        .default({ width: 220, height: 120 })
});
export type GraphNote = z.infer<typeof graphNoteSchema>;

export const graphEdgeSchema = z.object({
    from: z.object({ node: nodeId, port: z.string().min(1).max(40) }),
    to: z.object({ node: nodeId })
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

const windowSeconds = z
    .number()
    .int()
    .min(1)
    .max(AUTOMATION_LIMITS.combineWindowSeconds)
    .default(300);

export const whenSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("any") }),
    z.object({ kind: z.literal("all"), windowSeconds }),
    z.object({ kind: z.literal("count"), count: z.number().int().min(1).max(20), windowSeconds })
]);
export type WhenConfig = z.infer<typeof whenSchema>;

/** How many members must fire inside the window for a combined start, or 1 for "any". */
export function combineNeeds(when: WhenConfig, members: number): number {
    if (when.kind === "any") return 1;
    if (when.kind === "all") return Math.max(1, members);
    return Math.max(1, Math.min(when.count, members));
}

/** Retry wait before try number `next` (2 = the first retry), in milliseconds. */
export function retryDelayMs(
    retry: { readonly waitSeconds: number; readonly backoff: "fixed" | "double" },
    next: number
): number {
    const factor = retry.backoff === "double" ? 2 ** Math.max(0, next - 2) : 1;
    return Math.min(retry.waitSeconds * factor, AUTOMATION_LIMITS.retryWaitSeconds) * 1000;
}

export const automationGraphSchema = z.object({
    schema: z.literal(1).default(1),
    timeZone: z.string().min(1).max(64).default("UTC"),
    nodes: z.array(graphNodeSchema).max(AUTOMATION_LIMITS.nodes).default([]),
    edges: z.array(graphEdgeSchema).max(AUTOMATION_LIMITS.edges).default([]),
    finally: z
        .object({
            entry: nodeId.nullable().default(null),
            /** Also run the lane when somebody cancels the run. Off: a cancel is a decision to stop. */
            onCancel: z.boolean().default(false)
        })
        .default({ entry: null, onCancel: false }),
    /** Sticky notes on the canvas: words for the reader, never run. */
    notes: z.array(graphNoteSchema).max(AUTOMATION_LIMITS.notes).default([]),
    /** How the triggers combine: any one starts a run, or all / at least N within a window. */
    when: whenSchema.default({ kind: "any" })
});
export type AutomationGraph = z.infer<typeof automationGraphSchema>;

export function emptyGraph(timeZone = "UTC"): AutomationGraph {
    return {
        schema: 1,
        timeZone,
        nodes: [],
        edges: [],
        finally: { entry: null, onCancel: false },
        notes: [],
        when: { kind: "any" }
    };
}

export type GraphProblem =
    | { code: "duplicateNode"; node: string }
    | { code: "unknownEdgeNode"; node: string }
    | { code: "unknownPort"; node: string; port: string }
    | { code: "intoTrigger"; node: string }
    | { code: "cycle"; node: string }
    | { code: "finallyEntry"; node: string }
    | { code: "finallyShared"; node: string }
    | { code: "badConfig"; node: string; issue: string }
    | { code: "pinTooLarge"; node: string }
    | { code: "pinNotAllowed"; node: string }
    | { code: "loopBodyLeaks"; node: string }
    | { code: "tryBodyLeaks"; node: string }
    | { code: "scopeTooDeep"; node: string }
    | { code: "callCycle"; node: string }
    | { code: "noTrigger" };

/** Nodes reachable from `start` along edges, `start` included. */
export function reachableFrom(graph: AutomationGraph, start: string): Set<string> {
    const out = new Map<string, string[]>();
    for (const edge of graph.edges)
        out.set(edge.from.node, [...(out.get(edge.from.node) ?? []), edge.to.node]);
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
        const at = stack.pop()!;
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...(out.get(at) ?? []));
    }
    return seen;
}

function bodyLeaks(graph: AutomationGraph, scopes: (type: string) => boolean): string[] {
    const leaks: string[] = [];
    for (const scope of graph.nodes) {
        if (!scopes(scope.type)) continue;
        const port = bodyPort(scope.type);
        const body = loopBody(graph, scope.id);
        for (const edge of graph.edges)
            if (
                body.has(edge.to.node) &&
                !body.has(edge.from.node) &&
                !(edge.from.node === scope.id && edge.from.port === port)
            )
                leaks.push(edge.to.node);
    }
    return leaks;
}

/** The nodes of a loop body that something outside the body leads into, besides the loop's "each". */
export function loopBodyLeaks(graph: AutomationGraph): string[] {
    return bodyLeaks(graph, isLoopNode);
}

/** The same for a Try: its body is entered only by its "body" port. */
export function tryBodyLeaks(graph: AutomationGraph): string[] {
    return bodyLeaks(graph, (type) => type === "core.try");
}

/** The nodes a scope's body port reaches: what runs once per item, or inside the Try. */
export function loopBody(graph: AutomationGraph, loopId: string): Set<string> {
    const node = graph.nodes.find((entry) => entry.id === loopId);
    const port = (node && bodyPort(node.type)) ?? "each";
    const body = new Set<string>();
    for (const start of successors(graph, loopId, port))
        for (const id of reachableFrom(graph, start)) body.add(id);
    return body;
}

/**
 * Scope nodes nested deeper than the limit: a Try or loop inside the body of
 * another counts one level more. Call on an acyclic graph.
 */
export function scopesTooDeep(graph: AutomationGraph): string[] {
    const scopes = graph.nodes.filter((node) => isScopeNode(node.type));
    const bodies = new Map(scopes.map((scope) => [scope.id, loopBody(graph, scope.id)]));
    const depth = new Map<string, number>();
    const measure = (id: string): number => {
        const known = depth.get(id);
        if (known !== undefined) return known;
        let deepest = 0;
        for (const inner of bodies.get(id) ?? [])
            if (inner !== id && bodies.has(inner)) deepest = Math.max(deepest, measure(inner));
        depth.set(id, deepest + 1);
        return deepest + 1;
    };
    return scopes
        .filter((scope) => measure(scope.id) > AUTOMATION_LIMITS.scopeDepth)
        .map((scope) => scope.id);
}

export function triggerNodes(graph: AutomationGraph): GraphNode[] {
    return graph.nodes.filter((node) => nodeRole(node.type) === "trigger");
}

/** The nodes of the Finally lane. */
export function finallyNodes(graph: AutomationGraph): Set<string> {
    return graph.finally.entry ? reachableFrom(graph, graph.finally.entry) : new Set();
}

/** Successors of one node through one port, in edge order. */
export function successors(graph: AutomationGraph, node: string, port: string): string[] {
    return graph.edges
        .filter((edge) => edge.from.node === node && edge.from.port === port)
        .map((edge) => edge.to.node);
}

/**
 * Everything wrong with a graph that would make it run differently from how it
 * reads. `forPublish` adds what a draft may lack but a live version may not.
 */
export function graphProblems(
    graph: AutomationGraph,
    options: { forPublish?: boolean } = {}
): GraphProblem[] {
    const problems: GraphProblem[] = [];
    const byId = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
        if (byId.has(node.id)) problems.push({ code: "duplicateNode", node: node.id });
        byId.set(node.id, node);
        if (isCoreNodeType(node.type)) {
            const parsed = CORE_NODE_CONFIGS[node.type].safeParse(node.config);
            if (!parsed.success)
                problems.push({
                    code: "badConfig",
                    node: node.id,
                    issue: parsed.error.issues[0]?.message ?? "invalid"
                });
        }
        if (node.pinned !== undefined) {
            if (nodeRole(node.type) === "condition")
                problems.push({ code: "pinNotAllowed", node: node.id });
            else if (nodeRole(node.type) === "flow")
                problems.push({ code: "pinNotAllowed", node: node.id });
            else if (byteLength(JSON.stringify(node.pinned) ?? "null") > AUTOMATION_LIMITS.pinBytes)
                problems.push({ code: "pinTooLarge", node: node.id });
        }
    }
    for (const edge of graph.edges) {
        const from = byId.get(edge.from.node);
        const to = byId.get(edge.to.node);
        if (!from) problems.push({ code: "unknownEdgeNode", node: edge.from.node });
        if (!to) problems.push({ code: "unknownEdgeNode", node: edge.to.node });
        if (from && !nodePorts(from.type, from).includes(edge.from.port))
            problems.push({ code: "unknownPort", node: from.id, port: edge.from.port });
        if (to && nodeRole(to.type) === "trigger")
            problems.push({ code: "intoTrigger", node: to.id });
    }
    // Kahn's algorithm: whatever is left with an inbound edge sits on a cycle.
    const inbound = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));
    for (const edge of graph.edges)
        if (inbound.has(edge.to.node)) inbound.set(edge.to.node, inbound.get(edge.to.node)! + 1);
    const queue = [...inbound].filter(([, count]) => count === 0).map(([id]) => id);
    while (queue.length) {
        const at = queue.shift()!;
        for (const edge of graph.edges) {
            if (edge.from.node !== at || !inbound.has(edge.to.node)) continue;
            const left = inbound.get(edge.to.node)! - 1;
            inbound.set(edge.to.node, left);
            if (left === 0) queue.push(edge.to.node);
        }
    }
    const cyclic = [...inbound].find(([, count]) => count > 0);
    if (cyclic) problems.push({ code: "cycle", node: cyclic[0] });

    const entry = graph.finally.entry;
    if (entry) {
        const node = byId.get(entry);
        if (!node || nodeRole(node.type) === "trigger")
            problems.push({ code: "finallyEntry", node: entry });
        else if (!cyclic) {
            const lane = finallyNodes(graph);
            const main = new Set<string>();
            for (const trigger of triggerNodes(graph))
                for (const id of reachableFrom(graph, trigger.id)) main.add(id);
            for (const id of lane)
                if (main.has(id)) problems.push({ code: "finallyShared", node: id });
            for (const edge of graph.edges)
                if (lane.has(edge.to.node) && edge.to.node !== entry && !lane.has(edge.from.node))
                    problems.push({ code: "finallyShared", node: edge.to.node });
            for (const edge of graph.edges)
                if (edge.to.node === entry) problems.push({ code: "finallyShared", node: entry });
        }
    }
    if (!cyclic) {
        for (const node of loopBodyLeaks(graph)) problems.push({ code: "loopBodyLeaks", node });
        for (const node of tryBodyLeaks(graph)) problems.push({ code: "tryBodyLeaks", node });
        for (const node of scopesTooDeep(graph)) problems.push({ code: "scopeTooDeep", node });
    }
    if (options.forPublish && triggerNodes(graph).length === 0)
        problems.push({ code: "noTrigger" });
    return problems;
}

// ---------------------------------------------------------------------------
// The list view
// ---------------------------------------------------------------------------

/**
 * One row of the list view: a node; for an If, what it does either way; for a
 * Choose or At the same time, one list per port; for a loop, its body.
 */
export interface ListStep {
    node: GraphNode;
    then?: ListStep[];
    else?: ListStep[];
    branches?: ListStep[][];
    body?: ListStep[];
    /** A Try's On error and Always paths; its Then path is what follows it in the list. */
    onError?: ListStep[];
    always?: ListStep[];
}

/** Node types the list view draws with one nested list per output port. */
const BRANCHING = new Set(["core.switch", "core.parallel"]);

/** A new list row for a node, with the empty nested lists its type draws. */
export function listStepFor(node: GraphNode): ListStep {
    if (node.type === "core.if") return { node, then: [], else: [] };
    if (BRANCHING.has(node.type))
        return { node, branches: nodePorts(node.type, node).map(() => []) };
    if (isLoopNode(node.type)) return { node, body: [] };
    if (node.type === "core.try") return { node, body: [], onError: [], always: [] };
    return { node };
}

export interface ListFlow {
    timeZone: string;
    triggers: GraphNode[];
    steps: ListStep[];
    finally: ListStep[];
    finallyOnCancel: boolean;
    /** How the triggers combine; any one starts a run when absent. */
    when?: WhenConfig;
}

function chain(
    steps: readonly ListStep[],
    after: string | null,
    nodes: GraphNode[],
    edges: GraphEdge[]
): string | null {
    // Built back to front so each step knows the node it continues into.
    let next = after;
    for (let index = steps.length - 1; index >= 0; index--) {
        const step = steps[index]!;
        nodes.push(step.node);
        if (step.node.type === "core.if") {
            const thenStart = chain(step.then ?? [], next, nodes, edges);
            const elseStart = chain(step.else ?? [], next, nodes, edges);
            if (thenStart)
                edges.push({ from: { node: step.node.id, port: "then" }, to: { node: thenStart } });
            if (elseStart)
                edges.push({ from: { node: step.node.id, port: "else" }, to: { node: elseStart } });
        } else if (BRANCHING.has(step.node.type)) {
            const ports = nodePorts(step.node.type, step.node);
            ports.forEach((port, at) => {
                const start = chain(step.branches?.[at] ?? [], next, nodes, edges);
                if (start) edges.push({ from: { node: step.node.id, port }, to: { node: start } });
            });
        } else if (isLoopNode(step.node.type)) {
            const start = chain(step.body ?? [], null, nodes, edges);
            if (start)
                edges.push({ from: { node: step.node.id, port: "each" }, to: { node: start } });
            if (next)
                edges.push({ from: { node: step.node.id, port: "done" }, to: { node: next } });
        } else if (step.node.type === "core.try") {
            const lists = [
                ["body", step.body],
                ["catch", step.onError],
                ["always", step.always]
            ] as const;
            for (const [port, list] of lists) {
                const start = chain(list ?? [], null, nodes, edges);
                if (start) edges.push({ from: { node: step.node.id, port }, to: { node: start } });
            }
            if (next)
                edges.push({ from: { node: step.node.id, port: "then" }, to: { node: next } });
        } else if (step.node.type === "core.stop") {
            // A Stop ends the run: nothing follows it.
        } else if (next) {
            edges.push({ from: { node: step.node.id, port: "next" }, to: { node: next } });
        }
        next = step.node.id;
    }
    return next;
}

/** The graph a list view describes. Pure, so the editor and the tests build the same one. */
export function graphFromList(flow: ListFlow): AutomationGraph {
    const nodes: GraphNode[] = [...flow.triggers];
    const edges: GraphEdge[] = [];
    const first = chain(flow.steps, null, nodes, edges);
    if (first)
        for (const trigger of flow.triggers)
            edges.push({ from: { node: trigger.id, port: "next" }, to: { node: first } });
    const entry = chain(flow.finally, null, nodes, edges);
    return {
        schema: 1,
        timeZone: flow.timeZone,
        nodes,
        edges,
        finally: { entry, onCancel: flow.finallyOnCancel },
        notes: [],
        when: flow.when ?? { kind: "any" }
    };
}

function edgeKey(edge: GraphEdge): string {
    return `${edge.from.node}:${edge.from.port}>${edge.to.node}`;
}

function sameGraphShape(a: AutomationGraph, b: AutomationGraph): boolean {
    const keys = (graph: AutomationGraph) => graph.edges.map(edgeKey).sort().join("|");
    const ids = (graph: AutomationGraph) =>
        graph.nodes
            .map((node) => node.id)
            .sort()
            .join("|");
    return (
        keys(a) === keys(b) &&
        ids(a) === ids(b) &&
        (a.finally.entry ?? "") === (b.finally.entry ?? "")
    );
}

/** The node where every branch meets again, or null when they run off the end. */
function meetingOf(graph: AutomationGraph, starts: readonly (string | undefined)[]): string | null {
    const present = starts.filter((start): start is string => Boolean(start));
    if (present.length < 2) return null;
    let at: string | null = present[0]!;
    for (const other of present.slice(1)) {
        if (!at) return null;
        const met = meeting(graph, at, other);
        // The meeting of the branches so far with the next one, measured from each start.
        at = met;
    }
    if (!at) return null;
    // Every branch must reach it.
    return present.every((start) => reachableFrom(graph, start).has(at!)) ? at : null;
}

/** The node where both branches of an If meet again, or null when they both run off the end. */
function meeting(
    graph: AutomationGraph,
    left: string | undefined,
    right: string | undefined
): string | null {
    if (!left || !right) return null;
    const distances = (start: string) => {
        const seen = new Map<string, number>([[start, 0]]);
        const queue = [start];
        while (queue.length) {
            const at = queue.shift()!;
            for (const edge of graph.edges)
                if (edge.from.node === at && !seen.has(edge.to.node)) {
                    seen.set(edge.to.node, seen.get(at)! + 1);
                    queue.push(edge.to.node);
                }
        }
        return seen;
    };
    const a = distances(left);
    const b = distances(right);
    let best: { id: string; cost: number } | null = null;
    for (const [id, da] of a) {
        const db = b.get(id);
        if (db === undefined) continue;
        const cost = Math.max(da, db);
        if (!best || cost < best.cost) best = { id, cost };
    }
    return best?.id ?? null;
}

function walk(
    graph: AutomationGraph,
    start: string | undefined,
    stop: string | null,
    budget: { left: number }
): ListStep[] | null {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const steps: ListStep[] = [];
    let at = start;
    while (at && at !== stop) {
        if (--budget.left < 0) return null;
        const node = byId.get(at);
        if (!node) return null;
        if (node.type === "core.if") {
            const thenStart = successors(graph, at, "then")[0];
            const elseStart = successors(graph, at, "else")[0];
            const join = meeting(graph, thenStart, elseStart) ?? stop;
            const thenSteps = walk(graph, thenStart, join, budget);
            const elseSteps = walk(graph, elseStart, join, budget);
            if (!thenSteps || !elseSteps) return null;
            steps.push({ node, then: thenSteps, else: elseSteps });
            at = join ?? undefined;
            if (at === stop) break;
        } else if (BRANCHING.has(node.type)) {
            const starts = nodePorts(node.type, node).map(
                (port) => successors(graph, at!, port)[0]
            );
            const join = meetingOf(graph, starts) ?? stop;
            const branches: ListStep[][] = [];
            for (const start of starts) {
                const branch = walk(graph, start, join, budget);
                if (!branch) return null;
                branches.push(branch);
            }
            steps.push({ node, branches });
            at = join ?? undefined;
            if (at === stop) break;
        } else if (isLoopNode(node.type)) {
            const body = walk(graph, successors(graph, at, "each")[0], null, budget);
            if (!body) return null;
            steps.push({ node, body });
            at = successors(graph, at, "done")[0];
        } else if (node.type === "core.try") {
            const body = walk(graph, successors(graph, at, "body")[0], null, budget);
            const onError = walk(graph, successors(graph, at, "catch")[0], null, budget);
            const always = walk(graph, successors(graph, at, "always")[0], null, budget);
            if (!body || !onError || !always) return null;
            steps.push({ node, body, onError, always });
            at = successors(graph, at, "then")[0];
        } else {
            steps.push({ node });
            at = successors(graph, at, "next")[0];
        }
    }
    return steps;
}

/**
 * The list view of a graph, or null when the graph is not one the list can draw
 * (a free merge, a branch that skips the join). Checked by rebuilding the graph
 * from the list and comparing, so a list that would save a different graph is
 * never offered.
 */
export function listFromGraph(graph: AutomationGraph): ListFlow | null {
    const triggers = triggerNodes(graph);
    const firsts = new Set(triggers.flatMap((trigger) => successors(graph, trigger.id, "next")));
    if (firsts.size > 1) return null;
    const budget = { left: graph.nodes.length * 4 + 4 };
    const steps = walk(graph, [...firsts][0], null, budget);
    const lane = walk(graph, graph.finally.entry ?? undefined, null, budget);
    if (!steps || !lane) return null;
    const flow: ListFlow = {
        timeZone: graph.timeZone,
        triggers,
        steps,
        finally: lane,
        finallyOnCancel: graph.finally.onCancel,
        when: graph.when
    };
    return sameGraphShape(graphFromList(flow), graph) ? flow : null;
}

// ---------------------------------------------------------------------------
// Stored data
// ---------------------------------------------------------------------------

export const TRUNCATED_MARKER = "__polarisTruncated";

/** A value cut to fit a stored column, marked so a reader knows it is not whole. */
export function capStored(value: unknown, maxBytes: number): unknown {
    if (value === undefined) return null;
    const json = JSON.stringify(value) ?? "null";
    if (byteLength(json) <= maxBytes) return value;
    return {
        [TRUNCATED_MARKER]: true,
        bytes: byteLength(json),
        preview: json.slice(0, Math.floor(maxBytes / 4))
    };
}

export function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

/** Every string equal to or containing one of `secrets`, masked, through the whole value. */
export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
    const live = secrets.filter((secret) => secret.length >= 4);
    if (live.length === 0) return value;
    const mask = (text: string) =>
        live.reduce((out, secret) => out.split(secret).join("[secret]"), text);
    const walkValue = (item: unknown): unknown => {
        if (typeof item === "string") return mask(item);
        if (Array.isArray(item)) return item.map(walkValue);
        if (item && typeof item === "object")
            return Object.fromEntries(
                Object.entries(item).map(([key, inner]) => [mask(key), walkValue(inner)])
            );
        return item;
    };
    return walkValue(value);
}

/** Masks a URL down to what identifies it: scheme, host and the last few characters. */
export function maskSecretUrl(value: string): string {
    try {
        const url = new URL(value);
        const tail = value.slice(-4);
        return `${url.protocol}//${url.host}/...${tail}`;
    } catch {
        return maskToken(value);
    }
}

export function maskToken(value: string): string {
    return value.length <= 8 ? "..." : `...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Inputs from the screens
// ---------------------------------------------------------------------------

/** The one normalizer the form and the server action share. */
export function normalizeAutomationName(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

export const automationCreateSchema = z.object({
    name: z
        .string()
        .transform(normalizeAutomationName)
        .pipe(z.string().min(1, "nameRequired").max(AUTOMATION_LIMITS.nameLength)),
    description: z.string().trim().max(AUTOMATION_LIMITS.descriptionLength).default(""),
    /** Null for the personal shelf. */
    orgId: z.string().uuid().nullable().default(null)
});

export const automationSettingsSchema = z
    .object({
        name: automationCreateSchema.shape.name,
        description: automationCreateSchema.shape.description,
        mode: z.enum(AUTOMATION_MODES),
        maxRuns: z.number().int().min(1).max(AUTOMATION_LIMITS.maxRunsCeiling),
        rateLimit: z.number().int().min(1).max(AUTOMATION_LIMITS.rateLimitCeiling)
    })
    .strict();

export const secretCreateSchema = z
    .object({
        name: z
            .string()
            .transform(normalizeAutomationName)
            .pipe(z.string().min(1, "nameRequired").max(80)),
        kind: z.enum(SECRET_KINDS),
        value: z.string().trim().min(1, "valueRequired").max(AUTOMATION_LIMITS.secretLength),
        orgId: z.string().uuid().nullable().default(null)
    })
    .superRefine((input, ctx) => {
        if (input.kind === "url") {
            let ok = false;
            try {
                const url = new URL(input.value);
                ok = url.protocol === "https:" || url.protocol === "http:";
            } catch {
                ok = false;
            }
            if (!ok) ctx.addIssue({ code: "custom", message: "urlInvalid", path: ["value"] });
        }
        if (input.kind === "basic" && !input.value.includes(":"))
            ctx.addIssue({ code: "custom", message: "basicInvalid", path: ["value"] });
    });

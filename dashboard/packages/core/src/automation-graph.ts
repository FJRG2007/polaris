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
    runsPage: 50
} as const;

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
    "interrupted"
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

export interface ConditionGroup {
    kind: "group";
    join: "all" | "any";
    negate?: boolean;
    items: ConditionNode[];
}
export type ConditionNode = CompareLeaf | ConditionGroup;

export const conditionGroupSchema: z.ZodType<ConditionGroup, z.ZodTypeDef, unknown> = z.lazy(() =>
    z.object({
        kind: z.literal("group"),
        join: z.enum(["all", "any"]),
        negate: z.boolean().optional(),
        items: z.array(z.union([compareLeafSchema, conditionGroupSchema])).max(20)
    })
) as z.ZodType<ConditionGroup, z.ZodTypeDef, unknown>;

function conditionDepth(node: ConditionNode): number {
    if (node.kind === "compare") return 0;
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
        body: text(AUTOMATION_LIMITS.textLength).default("")
    }),
    "core.http": httpConfigSchema,
    "core.chat": chatPresetConfigSchema.extend({ preset: z.enum(CHAT_PRESETS) })
} as const;
export type CoreNodeType = keyof typeof CORE_NODE_CONFIGS;
export const CORE_NODE_TYPES = Object.keys(CORE_NODE_CONFIGS) as CoreNodeType[];

export type NodeRole = "trigger" | "condition" | "action";

export interface CoreNodeMeta {
    readonly role: NodeRole;
    /** Output ports besides "next". */
    readonly ports: readonly string[];
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
    "core.chat": { role: "action", ports: [], idempotent: false }
};

export function isCoreNodeType(type: string): type is CoreNodeType {
    return Object.prototype.hasOwnProperty.call(CORE_NODE_CONFIGS, type);
}

/** The ports a node may be wired from. A condition has only its own; everything else has "next". */
export function nodePorts(type: string): readonly string[] {
    if (!isCoreNodeType(type)) return ["next"];
    const meta = CORE_NODE_META[type];
    return meta.role === "condition" ? meta.ports : ["next", ...meta.ports];
}

export function nodeRole(type: string): NodeRole | null {
    return isCoreNodeType(type) ? CORE_NODE_META[type].role : null;
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
    onError: z.enum(["stop", "continue"]).optional(),
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
    notes: z.array(graphNoteSchema).max(AUTOMATION_LIMITS.notes).default([])
});
export type AutomationGraph = z.infer<typeof automationGraphSchema>;

export function emptyGraph(timeZone = "UTC"): AutomationGraph {
    return {
        schema: 1,
        timeZone,
        nodes: [],
        edges: [],
        finally: { entry: null, onCancel: false },
        notes: []
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
            else if (byteLength(JSON.stringify(node.pinned) ?? "null") > AUTOMATION_LIMITS.pinBytes)
                problems.push({ code: "pinTooLarge", node: node.id });
        }
    }
    for (const edge of graph.edges) {
        const from = byId.get(edge.from.node);
        const to = byId.get(edge.to.node);
        if (!from) problems.push({ code: "unknownEdgeNode", node: edge.from.node });
        if (!to) problems.push({ code: "unknownEdgeNode", node: edge.to.node });
        if (from && !nodePorts(from.type).includes(edge.from.port))
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
    if (options.forPublish && triggerNodes(graph).length === 0)
        problems.push({ code: "noTrigger" });
    return problems;
}

// ---------------------------------------------------------------------------
// The list view
// ---------------------------------------------------------------------------

/** One row of the list view: a node, and for an If, what it does either way. */
export interface ListStep {
    node: GraphNode;
    then?: ListStep[];
    else?: ListStep[];
}

export interface ListFlow {
    timeZone: string;
    triggers: GraphNode[];
    steps: ListStep[];
    finally: ListStep[];
    finallyOnCancel: boolean;
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
        notes: []
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
        finallyOnCancel: graph.finally.onCancel
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

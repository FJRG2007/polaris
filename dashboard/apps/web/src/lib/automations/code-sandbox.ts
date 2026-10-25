/**
 * Runs the JavaScript of a Code step: in QuickJS compiled to WebAssembly, a
 * fresh engine instance per run, never in this process's own JavaScript.
 *
 * The boundary is the WebAssembly instance. The code inside it has the
 * language and nothing else: no `require`, no `import`, no `process`, no
 * network, no files, no environment. The only thing the host hands in is the
 * items as one JSON string, and the only things it takes back are strings: the
 * result, serialized inside the sandbox by its own `JSON.stringify`, and the
 * console lines. No object of the person's ever reaches this side, so nothing
 * they wrote can run here (a getter, a `toJSON`) or reach this process's
 * prototypes.
 *
 * The engine runs on a worker thread with an empty environment, so a run
 * never holds this process's event loop. Limits are layered: QuickJS's own
 * interrupt handler ends the run at its deadline (checked as the bytecode
 * runs, so `while (true) {}` stops), its memory and stack limits bound the
 * heap, and the thread itself is terminated at the deadline plus a short
 * grace - a single native call that runs long (an allocation failing at the
 * memory limit takes seconds) cannot outlive it.
 *
 * Why not node:vm, a Function or a child process: none of them is a boundary
 * against code that wants out - `vm` hands back host objects through
 * `constructor.constructor`, and a child process runs with this one's
 * privileges. Hosted tools isolate with a process or a microVM per run; the
 * limited edition has no daemon to start one, and a wasm engine needs none.
 */

import { z } from "zod";
import { join } from "node:path";
import * as core from "@polaris/core";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { CODE_WORKER_SOURCE } from "./code-sandbox-worker";

const L = core.AUTOMATION_LIMITS;
/** Where a line number in an error points: the person's code, not the wrapper. */
const FILE = "code.js";
const LOG_LINE_LENGTH = 500;
const MAX_DEPTH = 64;
/** The thread past its deadline: QuickJS stops it first; this is the floor under that. */
const GRACE_MS = 250;
/** Starting the thread and the engine, before the code's own clock starts. */
const BOOT_MS = 10_000;

export interface CodeLimits {
    readonly timeMs: number;
    readonly memoryBytes: number;
    readonly outputBytes: number;
}

export const CODE_LIMITS: CodeLimits = {
    timeMs: L.codeTimeMs,
    memoryBytes: L.codeMemoryBytes,
    outputBytes: L.stepDataBytes
};

/** What went wrong, in words the node can show: `line` is in the person's code. */
export type CodeFailureKind = "syntax" | "runtime" | "timeout" | "memory" | "output" | "input";

export type CodeResult =
    | { readonly ok: true; readonly items: unknown[]; readonly logs: string[] }
    | {
          readonly ok: false;
          readonly kind: CodeFailureKind;
          readonly message: string;
          readonly line: number | null;
          readonly logs: string[];
      };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const jsonValue: z.ZodType<Json> = z.lazy(() =>
    z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
        z.null(),
        z.array(jsonValue),
        z.record(z.string(), jsonValue)
    ])
);
/** What the code must give back: a list of JSON values, one per item. */
export const codeOutputSchema = z.array(jsonValue);

/** A value nested deeper than the step can store, or one carrying `__proto__`: refused, not repaired. */
function unsafeShape(value: unknown, depth = 0): "tooDeep" | "protoKey" | null {
    if (depth > MAX_DEPTH) return "tooDeep";
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = unsafeShape(entry, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
            if (key === "__proto__") return "protoKey";
            const found = unsafeShape((value as Record<string, unknown>)[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

/** The person's code is the body of an async function; it starts on line 1, so line numbers match. */
function wrap(source: string): string {
    return `(async function (items, $input) {${source}\n}).call(undefined, globalThis.items, globalThis.$input)`;
}

/** The first line of the person's code an error's stack names. */
function lineOf(stack: string): number | null {
    const match = /code\.js:(\d+)/.exec(stack);
    return match ? Number(match[1]) : null;
}

function failure(
    kind: CodeFailureKind,
    message: string,
    logs: string[],
    line: number | null = null
): CodeResult {
    return { ok: false, kind, message: message.slice(0, LOG_LINE_LENGTH), line, logs };
}

const errorShape = z.object({ name: z.string(), message: z.string(), stack: z.string() });
const logsShape = z.array(z.string().max(LOG_LINE_LENGTH + 10)).max(L.codeLogLines);
/** What the thread may answer; anything else is treated as a crash. */
const replySchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("done"), text: z.string().nullable(), logs: logsShape }),
    z.object({ type: z.literal("pending"), logs: logsShape }),
    z.object({
        type: z.literal("threw"),
        error: errorShape,
        interrupted: z.boolean(),
        logs: logsShape
    }),
    z.object({
        type: z.literal("crashed"),
        message: z.string(),
        interrupted: z.boolean(),
        logs: logsShape
    })
]);
type Reply = z.infer<typeof replySchema>;

const STACK = /stack overflow|call stack size/i;

function fromThrown(
    error: z.infer<typeof errorShape>,
    interrupted: boolean,
    logs: string[]
): CodeResult {
    const { name, message } = error;
    if (interrupted && /interrupted/i.test(message)) return failure("timeout", message, logs);
    if (/out of memory/i.test(message)) return failure("memory", message, logs);
    if (STACK.test(message)) return failure("memory", message, logs, lineOf(error.stack));
    return failure(
        name === "SyntaxError" ? "syntax" : "runtime",
        name && name !== "Error" ? `${name}: ${message}` : message || "The code failed.",
        logs,
        lineOf(error.stack)
    );
}

/** The thread's answer, read: the result is checked here, never trusted. */
function settle(reply: Reply, limits: CodeLimits): CodeResult {
    const logs = reply.logs;
    if (reply.type === "pending")
        return failure("runtime", "The code waits for something that never finishes.", logs);
    if (reply.type === "threw") return fromThrown(reply.error, reply.interrupted, logs);
    if (reply.type === "crashed") {
        if (reply.interrupted) return failure("timeout", reply.message, logs);
        const memory = /memory/i.test(reply.message) || STACK.test(reply.message);
        return failure(memory ? "memory" : "runtime", reply.message, logs);
    }
    if (reply.text === null)
        return failure("runtime", "The code must return the items for the next step.", logs);
    if (core.byteLength(reply.text) > limits.outputBytes)
        return failure("output", "The code returned more than a step can keep.", logs);
    let parsed: unknown;
    try {
        parsed = JSON.parse(reply.text);
    } catch {
        return failure("output", "The code returned something that is not JSON.", logs);
    }
    const shape = unsafeShape(parsed);
    if (shape === "protoKey")
        return failure("output", "A returned item uses the key __proto__.", logs);
    if (shape === "tooDeep")
        return failure("output", "A returned item is nested too deeply.", logs);
    const checked = codeOutputSchema.safeParse(parsed);
    if (!checked.success)
        return failure("output", "The code returned something that is not JSON.", logs);
    return { ok: true, items: checked.data, logs };
}

let enginePaths: { core: string; variant: string } | null = null;

/** The engine's two packages, as absolute paths for the thread to load. */
function engine(): { core: string; variant: string } {
    if (enginePaths) return enginePaths;
    const resolve = createRequire(join(process.cwd(), "package.json")).resolve;
    enginePaths = {
        core: resolve("quickjs-emscripten-core"),
        variant: resolve("@jitl/quickjs-singlefile-cjs-release-sync")
    };
    return enginePaths;
}

/**
 * Run `source` over `items`. Never throws for anything the code does: every
 * outcome, the thread being killed included, is a `CodeResult`.
 */
export async function runCode(
    source: string,
    items: unknown[],
    limits: CodeLimits = CODE_LIMITS
): Promise<CodeResult> {
    let input: string;
    try {
        input = JSON.stringify(items);
    } catch {
        return failure("input", "The items could not be read as JSON.", []);
    }
    if (core.byteLength(input) > L.eventPayloadBytes * 4)
        return failure("input", "The items are too large for a Code step.", []);
    let paths: { core: string; variant: string };
    try {
        paths = engine();
    } catch (caught) {
        console.error("polaris: the Code step's engine is not installed:", caught);
        return failure("runtime", "The Code step is not available on this server.", []);
    }
    return new Promise<CodeResult>((resolve) => {
        const worker = new Worker(CODE_WORKER_SOURCE, {
            eval: true,
            env: {},
            argv: [],
            execArgv: [],
            stdout: true,
            stderr: true,
            workerData: {
                ...paths,
                code: wrap(source),
                file: FILE,
                input,
                timeMs: limits.timeMs,
                memoryBytes: limits.memoryBytes,
                stackBytes: L.codeStackBytes,
                logLines: L.codeLogLines,
                logLength: LOG_LINE_LENGTH
            },
            resourceLimits: {
                maxOldGenerationSizeMb: 64 + Math.ceil(limits.memoryBytes / (1024 * 1024)),
                maxYoungGenerationSizeMb: 16,
                stackSizeMb: 4
            }
        });
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (result: CodeResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            void worker.terminate();
            resolve(result);
        };
        timer = setTimeout(
            () => finish(failure("timeout", "The Code step did not start in time.", [])),
            BOOT_MS
        );
        worker.on("message", (message: unknown) => {
            if ((message as { type?: unknown } | null)?.type === "ready") {
                clearTimeout(timer);
                timer = setTimeout(
                    () => finish(failure("timeout", "The code ran past its time limit.", [])),
                    limits.timeMs + GRACE_MS
                );
                return;
            }
            const reply = replySchema.safeParse(message);
            finish(
                reply.success
                    ? settle(reply.data, limits)
                    : failure("runtime", "The Code step gave an answer it should not.", [])
            );
        });
        worker.on("error", (caught: Error & { code?: string }) => {
            const memory = caught.code === "ERR_WORKER_OUT_OF_MEMORY";
            finish(
                failure(
                    memory ? "memory" : "runtime",
                    memory ? "The code ran out of memory." : caught.message,
                    []
                )
            );
        });
        worker.on("exit", () =>
            finish(failure("runtime", "The Code step stopped without an answer.", []))
        );
    });
}

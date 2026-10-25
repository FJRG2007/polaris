/**
 * Code: JavaScript the person wrote, run over the items of the step before it
 * (or of a list they name), returning the items for the next step.
 *
 * It runs in `code-sandbox.ts` and nowhere else: no network, no files, no
 * secrets, a time and a memory limit per run. The run-as account is checked
 * by the engine as for every step, and each account may start only so many
 * Code runs a minute, whichever automations they come from.
 *
 * A failure is stored as `codeSyntax`, `codeRuntime` (with `:<line>` when the
 * engine named one), `codeTimeout`, `codeMemory`, `codeOutput` or `codeInput`;
 * the step's output keeps the message, the line and the console lines.
 */

import * as core from "@polaris/core";
import { StepError, type RunContext, type ServerNode } from "../types";

type CodeConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.code"]["parse"]>;

const L = core.AUTOMATION_LIMITS;

/** A step's output as items: a list as it is, `{ items: [...] }` (Code, Join) unwrapped, nothing as none. */
export function asItems(value: unknown): unknown[] {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") {
        const items = (value as Record<string, unknown>).items;
        if (Array.isArray(items)) return items;
    }
    return [value];
}

/** What the code runs over: the list `items` names, else the output of the first step wired in that has one. */
export function codeInput(
    config: CodeConfig,
    context: RunContext,
    incoming: readonly string[]
): unknown[] {
    if (config.items.trim()) return asItems(core.referenceValue(config.items, context));
    for (const id of incoming)
        if (Object.hasOwn(context.steps, id)) return asItems(context.steps[id]);
    return [];
}

const CODES = {
    syntax: "codeSyntax",
    runtime: "codeRuntime",
    timeout: "codeTimeout",
    memory: "codeMemory",
    output: "codeOutput",
    input: "codeInput"
} as const;

export const codeNode: ServerNode<CodeConfig> = {
    type: "core.code",
    meta: core.CORE_NODE_META["core.code"],
    config: core.CORE_NODE_CONFIGS["core.code"],
    timeoutMs: 15_000,
    run: async (config, context, io) => {
        const [{ runCode }, { rateLimit }] = await Promise.all([
            import("../code-sandbox"),
            import("@/lib/rate-limit-service")
        ]);
        const items = codeInput(config, context, io.incoming ?? []);
        io.recordInput({ count: items.length });
        const allowed = await rateLimit(`automation-code:${io.actor.id}`, L.codeRunsPerMinute, 60_000);
        if (!allowed.ok) throw new StepError("codeLimited");
        const result = await runCode(config.code, items);
        if (!result.ok) {
            const code = CODES[result.kind];
            throw new StepError(
                result.line !== null && (result.kind === "syntax" || result.kind === "runtime")
                    ? `${code}:${result.line}`
                    : code,
                { error: { message: result.message, line: result.line }, logs: result.logs }
            );
        }
        return { output: { items: result.items, count: result.items.length, logs: result.logs } };
    }
};

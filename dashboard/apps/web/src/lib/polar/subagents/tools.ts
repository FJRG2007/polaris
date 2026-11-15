/**
 * The tools a subagent is given: always a subset of what the turn that
 * started it was offered, which is already narrowed to the person's access,
 * the switches they turned off and the web switch. Nothing is added here.
 *
 * A child has nobody watching it to approve a step, so a tool the parent would
 * have asked about runs only when the person's standing grants already approve
 * it; otherwise the call answers that it needs the person, and the subagent
 * reports that back. The read-only `explore` type is not given those tools at
 * all.
 */

import type { ToolSet } from "ai";
import { TASK_TOOL } from "@/lib/polar/subagents/shared";

/** An approval as the parent's `toolApproval` holds it. */
export type ApprovalRule =
    | string
    | ((input: unknown, options: { messages: readonly unknown[] }) => unknown);

export interface ToolScope {
    /** Leave out every tool that could change something. */
    readOnly: boolean;
    /** Names to leave out on top (a custom agent with the web off). */
    without: ReadonlySet<string>;
    /** Whether this child may start subagents of its own. */
    mayDelegate: boolean;
}

/** Tools that act in the person's name with no approval of their own. */
const ACTING = new Set(["polar_remember", "polar_forget", "browser"]);

/** The names a child may use, out of the parent's. */
export function scopedToolNames(
    parent: ToolSet,
    approval: Readonly<Record<string, ApprovalRule>>,
    scope: ToolScope
): string[] {
    return Object.keys(parent).filter((name) => {
        if (name === TASK_TOOL) return scope.mayDelegate;
        if (scope.without.has(name)) return false;
        if (scope.readOnly && (name in approval || ACTING.has(name))) return false;
        return true;
    });
}

export interface StepEvents {
    onStart: (tool: string) => void;
    onEnd: (tool: string, ok: boolean) => void;
    /** The child's messages so far, for an approval rule that reads them. */
    messages: () => readonly unknown[];
}

export const NEEDS_PERSON =
    "This step needs the person's approval, which a subagent cannot ask for. Do not retry it; say in your summary that it is left for the person.";

async function approved(rule: ApprovalRule | undefined, input: unknown, messages: readonly unknown[]) {
    if (rule === undefined) return true;
    const verdict = typeof rule === "function" ? await rule(input, { messages }) : rule;
    const kind =
        verdict && typeof verdict === "object" ? (verdict as { type?: unknown }).type : verdict;
    return kind === undefined || kind === "approved" || kind === "not-applicable";
}

/**
 * The child's tool set: the scoped names, each wrapped so its steps reach the
 * card and an approval it would need is checked against the standing grants.
 */
export function scopedTools(
    parent: ToolSet,
    approval: Readonly<Record<string, ApprovalRule>>,
    scope: ToolScope,
    events: StepEvents
): ToolSet {
    const result: ToolSet = {};
    for (const name of scopedToolNames(parent, approval, scope)) {
        const original = parent[name];
        if (!original) continue;
        const execute = (original as { execute?: (...args: unknown[]) => unknown }).execute;
        if (typeof execute !== "function") continue;
        result[name] = {
            ...original,
            execute: async (input: unknown, options: unknown) => {
                if (!(await approved(approval[name], input, events.messages()))) {
                    events.onEnd(name, false);
                    return { ok: false, text: NEEDS_PERSON };
                }
                events.onStart(name);
                try {
                    let output: unknown = await execute.call(original, input, options);
                    // A tool that streams its progress answers with its last value.
                    if (output && typeof output === "object" && Symbol.asyncIterator in output) {
                        let last: unknown = undefined;
                        for await (const value of output as AsyncIterable<unknown>) last = value;
                        output = last;
                    }
                    events.onEnd(name, (output as { ok?: unknown } | null)?.ok !== false);
                    return output;
                } catch (error) {
                    events.onEnd(name, false);
                    throw error;
                }
            }
        } as ToolSet[string];
    }
    return result;
}

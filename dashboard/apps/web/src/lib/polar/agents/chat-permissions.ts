/**
 * An agent's permissions in a Polar chat turn (`permissions.ts`).
 *
 * The action is the tool's own name, so a rule names `tasks_create` or
 * `web_fetch` the way the settings list shows it; the resource is what the
 * call works on, as far as the input says it (a URL, a command, a path, a
 * query), else empty, which only "*" matches. Then, as in OpenCode:
 *
 * - a tool denied whole (`toolDisabled`) is not offered to the model at all;
 * - a call a rule denies is refused before it runs, with a sentence the model
 *   can pass on;
 * - a call a rule allows runs without the approval card, and one a rule asks
 *   about shows it, read-only tools included.
 *
 * A call no rule matches keeps Polar's own rule (write tools ask unless a
 * grant covers them), rather than OpenCode's "ask everything": an agent with
 * no rules behaves exactly as Polar does.
 *
 * Server-side, but pure: no I/O.
 */

import type { ToolSet } from "ai";
import { matchingRule, toolDisabled, type PermissionRuleset } from "@/lib/polar/agents/permissions";

type Verdict = "approved" | "user-approval";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each approval takes its own options
type Approval = (input: unknown, options: any) => Verdict | Promise<Verdict>;

const RESOURCE_KEYS = ["url", "command", "path", "filePath", "file_path", "query", "name", "id"] as const;

/** What a call works on, from its input. */
export function callResource(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    for (const key of RESOURCE_KEYS) {
        if (typeof record[key] === "string") return (record[key] as string).slice(0, 2000);
    }
    return "";
}

export function deniedText(name: string): string {
    return `This agent's permissions do not allow ${name} here. Say so, and carry on without it.`;
}

/** The tools a turn offers under an agent's rules. */
export function withAgentRules<T extends ToolSet>(tools: T, rules: PermissionRuleset): T {
    if (rules.length === 0) return tools;
    const out: ToolSet = {};
    for (const [name, entry] of Object.entries(tools)) {
        if (toolDisabled(name, rules)) continue;
        const run = entry.execute;
        out[name] = (run
            ? {
                  ...entry,
                  execute: (input: unknown, options: never) =>
                      matchingRule(name, callResource(input), rules)?.effect === "deny"
                          ? { ok: false, text: deniedText(name) }
                          : run(input as never, options)
              }
            : entry) as ToolSet[string];
    }
    return out as T;
}

/** The approval rules of a turn under an agent's rules, for every tool named. */
export function agentApproval(
    approval: Partial<Record<string, Approval>>,
    names: readonly string[],
    rules: PermissionRuleset
): Partial<Record<string, Approval>> {
    if (rules.length === 0) return approval;
    const out: Partial<Record<string, Approval>> = { ...approval };
    for (const name of names) {
        const own = approval[name];
        out[name] = async (input, options) => {
            const rule = matchingRule(name, callResource(input), rules);
            // A denied call is refused where it runs; no card for it.
            if (rule?.effect === "allow" || rule?.effect === "deny") return "approved";
            if (rule?.effect === "ask") return "user-approval";
            return own ? own(input, options) : "approved";
        };
    }
    return out;
}

/**
 * An agent's permissions: allow, ask or deny, per tool and per pattern, ported
 * from OpenCode (`packages/core/src/permission.ts`, `util/wildcard.ts` and the
 * v1 config's `permission` object, `v1/config/permission.ts`).
 *
 * A rule is an action (the tool, such as `shell`, `edit`, `read`, `webfetch`, or
 * one of Polaris's own tool names), a resource pattern (the command, the path,
 * the URL, or what the call acts on) and an effect. Both are wildcards: `*` is
 * any run, `?` one character, and a pattern ending in " *" also matches the bare
 * command (`git status *` matches `git status`). The last rule that matches
 * wins, so the order rules are written in is the policy.
 *
 * Written the way OpenCode's config writes it:
 *
 *     { "edit": "ask", "bash": { "*": "ask", "git status *": "allow" } }
 *
 * and the deprecated `tools: { write: false }` reads as `edit: deny`, as there.
 *
 * Client-safe and pure.
 */

import { z } from "zod";

export const PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const;
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number];

/** Rules one agent keeps; bounds every read and every evaluation. */
export const PERMISSION_RULES_MAX = 200;
const PATTERN_MAX = 500;

export const permissionRuleSchema = z.object({
    action: z.string().trim().min(1).max(64),
    resource: z.string().max(PATTERN_MAX),
    effect: z.enum(PERMISSION_EFFECTS)
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export const permissionRulesSchema = z.array(permissionRuleSchema).max(PERMISSION_RULES_MAX);
export type PermissionRuleset = readonly PermissionRule[];

/** OpenCode's actions that take no pattern. */
const ACTION_ONLY = new Set(["question", "websearch", "doom_loop"]);

const effectSchema = z.enum(PERMISSION_EFFECTS);

/** OpenCode's `permission` config: one effect for everything, or per tool an
 *  effect or patterns to effects. Key order is kept, since it is the policy. */
export const permissionConfigSchema = z
    .union([
        effectSchema,
        z.record(
            z.string().trim().min(1).max(64),
            z.union([effectSchema, z.record(z.string().max(PATTERN_MAX), effectSchema)])
        )
    ])
    .superRefine((value, ctx) => {
        if (typeof value === "string") return;
        for (const [key, rule] of Object.entries(value)) {
            if (ACTION_ONLY.has(key) && typeof rule !== "string") {
                ctx.addIssue({ code: "custom", message: `${key} takes ask, allow or deny`, path: [key] });
            }
        }
    });
export type PermissionConfig = z.infer<typeof permissionConfigSchema>;

/** OpenCode's deprecated `tools` map: a tool switched off is denied. */
export const toolSwitchesSchema = z.record(z.string().trim().min(1).max(64), z.boolean());

/** OpenCode's `Wildcard.match`, character for character: case-insensitive
 *  only where OpenCode's is, on Windows; Polaris's machines are Linux. */
export function wildcardMatch(input: string, pattern: string): boolean {
    const normalized = input.replaceAll("\\", "/");
    let escaped = pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    return new RegExp(`^${escaped}$`, "s").test(normalized);
}

/** OpenCode's v1 to v2 action names, so a file written for either matches. */
export function normalizeAction(action: string): string {
    if (action === "write" || action === "patch" || action === "apply_patch") return "edit";
    if (action === "task") return "subagent";
    if (action === "bash") return "shell";
    return action;
}

/** The last rule that matches, or null when none does. */
export function matchingRule(
    action: string,
    resource: string,
    ...rulesets: PermissionRuleset[]
): PermissionRule | null {
    const rules = rulesets.flat();
    for (let index = rules.length - 1; index >= 0; index--) {
        const rule = rules[index]!;
        if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) return rule;
    }
    return null;
}

/** OpenCode's `evaluate`: the last match, and "ask" when nothing matches. */
export function evaluatePermission(
    action: string,
    resource: string,
    ...rulesets: PermissionRuleset[]
): PermissionEffect {
    return matchingRule(action, resource, ...rulesets)?.effect ?? "ask";
}

/** Whether a tool is off whole: the last rule naming it is a deny on "*".
 *  OpenCode leaves such a tool out of what the model is offered. */
export function toolDisabled(action: string, rules: PermissionRuleset): boolean {
    const rule = [...rules].reverse().find((entry) => wildcardMatch(action, entry.action));
    return rule?.resource === "*" && rule.effect === "deny";
}

/** A `permission` config (and any `tools` switches before it) as rules, in
 *  the order written; null when it does not read. */
export function rulesFromConfig(
    permission: unknown,
    tools: unknown = undefined
): PermissionRule[] | null {
    const config = permissionConfigSchema.optional().safeParse(permission ?? undefined);
    const switches = toolSwitchesSchema.optional().safeParse(tools ?? undefined);
    if (!config.success || !switches.success) return null;
    const read: PermissionConfig = config.data ?? {};
    const off = switches.data ?? {};
    // As OpenCode's v1 normalize: a Map keeps each key's first position.
    const merged = new Map<string, PermissionEffect | Record<string, PermissionEffect>>();
    for (const [tool, enabled] of Object.entries(off)) {
        merged.set(tool === "write" || tool === "patch" ? "edit" : tool, enabled ? "allow" : "deny");
    }
    const entries = typeof read === "string" ? [["*", read] as const] : Object.entries(read);
    for (const [key, rule] of entries) merged.set(key, rule);
    const rules: PermissionRule[] = [];
    for (const [key, rule] of merged) {
        const action = normalizeAction(key);
        if (typeof rule === "string") rules.push({ action, resource: "*", effect: rule });
        else {
            for (const [resource, effect] of Object.entries(rule)) {
                rules.push({ action, resource, effect });
            }
        }
    }
    const bounded = permissionRulesSchema.safeParse(rules);
    return bounded.success ? bounded.data : null;
}

/** Rules back as an OpenCode `permission` object, for the editor and for
 *  OpenCode itself. Rules of one action stay together, as the object can only
 *  say it that way; within an action their order is kept. */
export function configFromRules(rules: PermissionRuleset): Record<string, PermissionEffect | Record<string, PermissionEffect>> {
    const out: Record<string, PermissionEffect | Record<string, PermissionEffect>> = {};
    for (const rule of rules) {
        const current = out[rule.action];
        if (rule.resource === "*" && current === undefined) {
            out[rule.action] = rule.effect;
            continue;
        }
        const patterns = typeof current === "string" ? { "*": current } : (current ?? {});
        // A later rule for the same pattern wins, and is moved last, as it
        // would be read.
        delete patterns[rule.resource];
        patterns[rule.resource] = rule.effect;
        out[rule.action] = patterns;
    }
    return out;
}

/** Stored rules, read whole: what no longer reads is left out. */
export function rulesOf(raw: unknown): PermissionRule[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, PERMISSION_RULES_MAX).flatMap((entry) => {
        const parsed = permissionRuleSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

/** A Claude Code tool call as an OpenCode action and resource. */
export function claudeCallResource(
    tool: string,
    input: Record<string, unknown> | null
): { action: string; resource: string } {
    const text = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : "");
    switch (tool) {
        case "Bash":
            return { action: "shell", resource: text("command") };
        case "Edit":
        case "MultiEdit":
        case "Write":
            return { action: "edit", resource: text("file_path") };
        case "NotebookEdit":
            return { action: "edit", resource: text("notebook_path") };
        case "Read":
            return { action: "read", resource: text("file_path") };
        case "Grep":
            return { action: "grep", resource: text("pattern") };
        case "Glob":
            return { action: "glob", resource: text("pattern") };
        case "WebFetch":
            return { action: "webfetch", resource: text("url") };
        case "WebSearch":
            return { action: "websearch", resource: text("query") };
        case "Task":
        case "Agent":
            return { action: "subagent", resource: text("subagent_type") };
        default:
            // An MCP tool keeps its own name, so a rule can name it.
            return { action: tool, resource: "*" };
    }
}

/** What Claude Code's settings can say of the rules (`permissions.allow`,
 *  `ask`, `deny`). Claude ranks deny over ask over allow rather than taking
 *  the last match, so only rules no later rule overrides are carried; the
 *  rest are settled when Claude asks (`decidePermissionHook`). */
export function claudePermissionSettings(rules: PermissionRuleset): {
    allow: string[];
    ask: string[];
    deny: string[];
} {
    const out = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
    const tools: Record<string, string[]> = {
        shell: ["Bash"],
        edit: ["Edit", "Write", "NotebookEdit"],
        read: ["Read"],
        grep: ["Grep"],
        glob: ["Glob"],
        webfetch: ["WebFetch"],
        websearch: ["WebSearch"],
        subagent: ["Task"]
    };
    rules.forEach((rule, index) => {
        const later = rules.slice(index + 1);
        // Overridden by something after it: Claude could not keep the order.
        if (later.some((next) => wildcardMatch(rule.action, next.action) || wildcardMatch(next.action, rule.action))) return;
        const names = tools[rule.action];
        if (!names) return;
        for (const name of names) {
            let entry = name;
            if (rule.resource !== "*") {
                if (name === "Bash") entry = `Bash(${rule.resource.replace(/ \*$/, ":*")})`;
                else if (name === "WebFetch") continue;
                else entry = `${name}(${rule.resource})`;
            }
            out[rule.effect].push(entry);
        }
    });
    return out;
}

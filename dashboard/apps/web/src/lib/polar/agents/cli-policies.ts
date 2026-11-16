/**
 * An agent's permission rules (`permissions.ts`) as the policy files Codex and
 * Gemini CLI read from their home, so allow, ask and deny hold in those
 * sessions as they do in Claude Code's and OpenCode's.
 *
 * Codex: a Starlark `.rules` file in `~/.codex/rules/` of `prefix_rule(pattern,
 * decision)` lines, decision `allow`, `prompt` or `forbidden`. It gates shell
 * commands only, a pattern is a run of exact leading argv words, and when several
 * rules match the most restrictive wins (forbidden > prompt > allow), not the last
 * (https://learn.chatgpt.com/docs/agent-configuration/rules,
 * `codex-rs/core/src/exec_policy.rs`). A file that fails to parse is dropped
 * whole, so every string is written as a JSON literal, which Starlark reads.
 *
 * Gemini CLI: a TOML file in `~/.gemini/policies/` of `[[rule]]` tables with
 * `toolName`, `argsPattern` (a regex over the call's JSON arguments) or
 * `commandRegex` (the same, after `"command":"`), `decision` `allow`, `deny` or
 * `ask_user`, and `priority` 0-999; the highest priority that matches decides,
 * and the user tier outranks the default one that allows everything in yolo
 * mode (`docs/reference/policy-engine.md`, `packages/core/src/policy/utils.ts`,
 * `policy/policies/yolo.toml`, tool names in
 * `packages/core/src/tools/definitions/base-declarations.ts`). Priorities rise
 * with the rule's position, which is exactly the last-match order.
 *
 * Where a rule cannot be said, the file says something stricter (a deny or an
 * ask over more than the rule named) or leaves the rule to the tool's own
 * defaults, and `gaps` reports which, so the editor can show it.
 *
 * Client-safe and pure.
 */

import { wildcardMatch, type PermissionEffect, type PermissionRule, type PermissionRuleset } from "./permissions";

export const POLICY_CLIS = ["codex", "gemini"] as const;
export type PolicyCli = (typeof POLICY_CLIS)[number];

/** How a rule fares in a tool: stricter than written, or not applied there. */
export interface PolicyGap {
    readonly cli: PolicyCli;
    readonly index: number;
    readonly kind: "stricter" | "unenforced";
}

export interface PolicyFile {
    /** Relative to the agent's home. */
    readonly path: string;
    readonly contents: string;
}

/** Where each tool reads it; fixed, so the boot can refuse any other path. */
export const POLICY_PATHS: Record<PolicyCli, string> = {
    codex: ".codex/rules/polaris.rules",
    gemini: ".gemini/policies/polaris.toml"
};

/** Polaris's actions each tool has an equivalent for. Rules naming anything
 *  else (Polaris's own tools, MCP tools) have nothing there to hold. */
const KNOWN_ACTIONS = ["shell", "edit", "read", "list", "grep", "glob", "webfetch", "websearch", "subagent"];

const RANK: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 };

/** The known actions a rule's action pattern covers. */
function actionsOf(rule: PermissionRule): string[] {
    return KNOWN_ACTIONS.filter((action) => wildcardMatch(action, rule.action));
}

// Shell syntax, wildcards, control characters and surrogates: none is a plain
// argv word, and a string Starlark might not read drops the whole file.
const SHELL_SPECIAL = /[*?"'\\$`;|&<>()\u0000-\u001f\u007f\ud800-\udfff]/;

/**
 * A shell pattern as leading argv words. `exact` when the words then anything
 * is what the pattern means (`git status *`, matching `git status` too); a
 * pattern with a wildcard or shell syntax further in keeps only the words
 * before it, which covers more.
 */
export function shellPrefix(resource: string): { words: string[]; exact: boolean } {
    const trimmed = resource.trim();
    const wildcardTail = / \*$/.test(trimmed);
    const words = (wildcardTail ? trimmed.slice(0, -2) : trimmed).split(/\s+/).filter(Boolean);
    const at = words.findIndex((word) => SHELL_SPECIAL.test(word));
    if (at === -1) return { words, exact: wildcardTail && words.length > 0 };
    return { words: words.slice(0, at), exact: false };
}

/** Whether two prefixes can match one command: one starts the other. */
function prefixesMeet(a: readonly string[], b: readonly string[]): boolean {
    const shorter = a.length < b.length ? a : b;
    const longer = shorter === a ? b : a;
    return shorter.every((word, index) => longer[index] === word);
}

/** Codex's `.rules` file for the rules, null when nothing in it applies. */
export function codexPolicy(rules: PermissionRuleset): { file: PolicyFile | null; gaps: PolicyGap[] } {
    const gaps: PolicyGap[] = [];
    const gap = (index: number, kind: PolicyGap["kind"]) => gaps.push({ cli: "codex", index, kind });
    const shell = rules.map((rule) => (actionsOf(rule).includes("shell") ? shellPrefix(rule.resource) : null));
    const lines: string[] = [];
    rules.forEach((rule, index) => {
        const covers = actionsOf(rule);
        if (covers.length === 0) return;
        const prefix = shell[index];
        // Codex's rules see commands only: the rest of what this names is
        // left to its sandbox and approval settings.
        const partial = covers.some((action) => action !== "shell");
        if (!prefix) return gap(index, "unenforced");
        const meets = (other: number) => {
            const next = shell[other];
            return next !== null && next !== undefined && prefixesMeet(prefix.words, next.words);
        };
        const later = rules.map((_, at) => at).filter((at) => at > index && meets(at));
        if (rule.effect === "allow") {
            // An allow said over more than written, or one a later stricter
            // rule Codex cannot hold would have overridden, is left out.
            const undercut = later.some((at) => RANK[rules[at]!.effect] > 0 && !held(rules[at]!, shell[at]!));
            if (!prefix.exact || prefix.words.length === 0 || undercut) return gap(index, "unenforced");
        } else if (prefix.words.length === 0) {
            return gap(index, "unenforced");
        }
        const decision = rule.effect === "allow" ? "allow" : rule.effect === "ask" ? "prompt" : "forbidden";
        const pattern = prefix.words.map((word) => JSON.stringify(word)).join(", ");
        const reason =
            rule.effect === "allow"
                ? ""
                : `, justification = "This agent's rules in Polaris ${rule.effect === "ask" ? "ask first" : "deny it"}"`;
        lines.push(`prefix_rule(pattern = [${pattern}], decision = "${decision}"${reason})`);
        // Most restrictive wins in Codex, so a later, looser rule over the
        // same commands does not loosen this one there.
        const loosened = later.some((at) => RANK[rules[at]!.effect] < RANK[rule.effect]);
        if (partial) gap(index, "unenforced");
        else if (!prefix.exact || loosened) gap(index, "stricter");
    });
    if (lines.length === 0) return { file: null, gaps };
    return {
        file: {
            path: POLICY_PATHS.codex,
            contents: ["# Written by Polaris from this agent's permission rules, on every start.", ...lines, ""].join("\n")
        },
        gaps
    };
}

/** Whether Codex can hold a deny or ask at all: it needs a first word. */
function held(rule: PermissionRule, prefix: { words: string[] }): boolean {
    return rule.effect !== "allow" && prefix.words.length > 0;
}

/** What a JSON string's content matches for one of OpenCode's wildcards:
 *  `*` and `?` never cross the string's closing quote. */
const JSON_CHAR = String.raw`(?:[^"\\]|\\.)`;

/** A wildcard as a regex over the same text JSON-encoded, ending at its quote. */
export function wildcardJsonRegex(pattern: string): string {
    const wildcardTail = pattern.endsWith(" *");
    const body = wildcardTail ? pattern.slice(0, -2) : pattern;
    let out = "";
    for (const char of body) {
        if (char === "*") out += `${JSON_CHAR}*`;
        else if (char === "?") out += JSON_CHAR;
        else out += JSON.stringify(char).slice(1, -1).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
    if (wildcardTail) out += `(?: ${JSON_CHAR}*)?`;
    return `${out}"`;
}

/** Gemini's tools per action and the argument a pattern is matched against;
 *  null where no one argument is what the rule names. */
const GEMINI_TOOLS: Record<string, { tools: string[]; key: string | null }[]> = {
    shell: [{ tools: ["run_shell_command"], key: "command" }],
    edit: [{ tools: ["write_file", "replace"], key: "file_path" }],
    read: [
        { tools: ["read_file"], key: "file_path" },
        { tools: ["read_many_files"], key: null }
    ],
    list: [{ tools: ["list_directory"], key: "dir_path" }],
    grep: [{ tools: ["grep_search"], key: "pattern" }],
    glob: [{ tools: ["glob"], key: "pattern" }],
    webfetch: [{ tools: ["web_fetch"], key: null }],
    websearch: [{ tools: ["google_web_search"], key: "query" }],
    subagent: [{ tools: ["invoke_agent"], key: null }]
};

/** The first priority Polaris writes; a rule's is this plus its position, so
 *  200 rules stay within Gemini's 999. */
export const GEMINI_PRIORITY_BASE = 790;

/** Gemini's policy file for the rules, null when nothing in it applies. */
export function geminiPolicy(rules: PermissionRuleset): { file: PolicyFile | null; gaps: PolicyGap[] } {
    const gaps: PolicyGap[] = [];
    const blocks: string[] = [];
    const decision = { allow: "allow", ask: "ask_user", deny: "deny" } as const;
    rules.forEach((rule, index) => {
        const priority = GEMINI_PRIORITY_BASE + index;
        const block = (tools: string | string[], match: string | null) =>
            [
                "[[rule]]",
                `toolName = ${JSON.stringify(tools)}`,
                ...(match ? [match] : []),
                `decision = "${decision[rule.effect]}"`,
                `priority = ${priority}`
            ].join("\n");
        if (rule.action === "*" && rule.resource === "*") {
            blocks.push(block("*", null));
            return;
        }
        const covers = actionsOf(rule);
        if (covers.length === 0) return;
        let kind: PolicyGap["kind"] | null = null;
        for (const action of covers) {
            for (const target of GEMINI_TOOLS[action]!) {
                if (rule.resource === "*") {
                    blocks.push(block(target.tools, null));
                } else if (target.key === "command") {
                    blocks.push(block(target.tools, `commandRegex = ${JSON.stringify(wildcardJsonRegex(rule.resource))}`));
                } else if (target.key) {
                    const regex = `"${target.key}":"${wildcardJsonRegex(rule.resource)}`;
                    blocks.push(block(target.tools, `argsPattern = ${JSON.stringify(regex)}`));
                } else if (rule.effect === "allow") {
                    // No argument to match: allowing every call is more than
                    // the rule said, so Gemini's own default stands.
                    kind = "unenforced";
                } else {
                    // A deny or an ask over every call of the tool instead.
                    blocks.push(block(target.tools, null));
                    kind ??= "stricter";
                }
            }
        }
        if (kind) gaps.push({ cli: "gemini", index, kind });
    });
    if (blocks.length === 0) return { file: null, gaps };
    return {
        file: {
            path: POLICY_PATHS.gemini,
            contents: ["# Written by Polaris from this agent's permission rules, on every start.", "", blocks.join("\n\n"), ""].join("\n")
        },
        gaps
    };
}

/** The policy file a session of this tool gets, or null for none. */
export function cliPolicyFile(cli: string, rules: PermissionRuleset): PolicyFile | null {
    if (cli === "codex") return codexPolicy(rules).file;
    if (cli === "gemini") return geminiPolicy(rules).file;
    return null;
}

/** Every rule Codex or Gemini holds differently from how it is written. */
export function cliPolicyGaps(rules: PermissionRuleset): PolicyGap[] {
    return [...codexPolicy(rules).gaps, ...geminiPolicy(rules).gaps];
}

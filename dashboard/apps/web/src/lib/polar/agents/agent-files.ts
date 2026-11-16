/**
 * Agents written as Markdown files in a repository, read into Polar's own
 * shape. Three places, in the order they are looked at:
 *
 * - `.polaris/agents/*.md`, Polaris's own, in OpenCode's format;
 * - `.opencode/agent/*.md` (and `agents/`), OpenCode's
 *   (`config/plugin/agent.ts`: the file name is the agent's name, the body its
 *   prompt, the frontmatter `description`, `mode`, `model`, `steps`, `tools`
 *   and `permission`);
 * - `.claude/agents/*.md`, Claude Code's subagents (`name`, `description`,
 *   `tools` as a comma list that allows those and no other, `model`).
 *
 * A file that does not read is skipped with the reason, as OpenCode logs and
 * skips one. Client-safe and pure: what fetches the files is elsewhere.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
    rulesFromConfig,
    type PermissionRule
} from "@/lib/polar/agents/permissions";
import {
    AGENT_DESCRIPTION_MAX,
    AGENT_INSTRUCTIONS_MAX,
    AGENT_MODES,
    normalizeAgentName,
    type AgentMode
} from "@/lib/polar/agents/shared";

export const AGENT_FILE_DIRS = [".polaris/agents", ".opencode/agent", ".opencode/agents", ".claude/agents"] as const;
/** The largest agent file read; a prompt longer than an agent holds is cut. */
export const AGENT_FILE_MAX = 64 * 1024;

export interface AgentFile {
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly mode: AgentMode;
    /** "provider/model" as the file wrote it, or null. */
    readonly model: string | null;
    readonly steps: number | null;
    readonly permission: PermissionRule[];
}

export type AgentFileRefusal = "markdown" | "frontmatter" | "empty";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const frontmatterSchema = z
    .object({
        name: z.string().optional(),
        description: z.string().optional(),
        mode: z.enum(AGENT_MODES).optional(),
        model: z.string().max(200).optional(),
        steps: z.number().int().positive().optional(),
        maxSteps: z.number().int().positive().optional(),
        disable: z.boolean().optional(),
        // OpenCode's map, or Claude Code's comma list.
        tools: z.union([z.record(z.string(), z.boolean()), z.string(), z.array(z.string())]).optional(),
        permission: z.unknown().optional()
    })
    .passthrough();

/** Claude Code's own tool names as the actions rules are written in. */
const CLAUDE_TOOL_ACTIONS: Record<string, string> = {
    Bash: "shell",
    Edit: "edit",
    MultiEdit: "edit",
    Write: "edit",
    NotebookEdit: "edit",
    Read: "read",
    Grep: "grep",
    Glob: "glob",
    WebFetch: "webfetch",
    WebSearch: "websearch",
    Task: "subagent",
    Agent: "subagent"
};

/** The agent's name from its path: the part under the agents folder. */
export function agentNameFromPath(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    const dir = AGENT_FILE_DIRS.find((entry) => normalized.includes(`${entry}/`));
    const rest = dir ? normalized.slice(normalized.indexOf(`${dir}/`) + dir.length + 1) : normalized.split("/").pop()!;
    return rest.replace(/\.md$/i, "");
}

/** One agent file read, or why it was skipped. */
export function parseAgentFile(path: string, content: string): AgentFile | AgentFileRefusal {
    if (content.length > AGENT_FILE_MAX) content = content.slice(0, AGENT_FILE_MAX);
    const found = FRONTMATTER.exec(content);
    // Frontmatter opened and never closed is not a file OpenCode reads.
    if (!found && /^---\r?\n/.test(content)) return "markdown";
    let data: unknown = {};
    let body = content;
    if (found) {
        try {
            data = parseYaml(found[1]!) ?? {};
        } catch {
            return "markdown";
        }
        body = found[2]!;
    }
    const front = frontmatterSchema.safeParse(data);
    if (!front.success) return "frontmatter";
    const meta = front.data;
    if (meta.disable) return "empty";
    const claude = path.replaceAll("\\", "/").includes(".claude/agents/");
    let permission: PermissionRule[] | null;
    if (typeof meta.tools === "string" || Array.isArray(meta.tools)) {
        // Claude Code: the tools listed and nothing else.
        const listed = (Array.isArray(meta.tools) ? meta.tools : meta.tools.split(","))
            .map((entry) => entry.trim())
            .filter(Boolean);
        const actions = [...new Set(listed.map((tool) => CLAUDE_TOOL_ACTIONS[tool] ?? tool))];
        permission = [
            { action: "*", resource: "*", effect: "deny" },
            ...actions.map((action) => ({ action, resource: "*", effect: "allow" as const }))
        ];
    } else {
        permission = rulesFromConfig(meta.permission, meta.tools);
    }
    if (!permission) return "frontmatter";
    const instructions = body.trim().slice(0, AGENT_INSTRUCTIONS_MAX);
    const name = normalizeAgentName(meta.name ?? agentNameFromPath(path)).slice(0, 80);
    if (!instructions || !name) return "empty";
    return {
        name,
        description: (meta.description ?? "").trim().slice(0, AGENT_DESCRIPTION_MAX),
        instructions,
        // Claude Code's are subagents; OpenCode's default is "all".
        mode: meta.mode ?? (claude ? "subagent" : "all"),
        model: meta.model && meta.model !== "inherit" ? meta.model.trim() : null,
        steps: meta.steps ?? meta.maxSteps ?? null,
        permission
    };
}

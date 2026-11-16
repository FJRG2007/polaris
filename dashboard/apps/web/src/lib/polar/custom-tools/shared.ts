/**
 * Custom tools and plugins, the shapes and the pure work on them (OpenCode's
 * `.opencode/tool` and plugin hooks, ported).
 *
 * A custom tool is somebody's own script with a name, a description and the
 * input it takes. It is user code, so it never runs here: the command built by
 * `toolCommand` is handed to the person's own session sandbox (a container, their
 * server) and nothing in this file executes anything. The input it takes is a
 * small JSON-schema subset, checked with Zod when the tool is saved and turned
 * into a Zod schema that every call is parsed against before it is sent.
 *
 * A plugin is a reaction to one of a session's events: a POST to a webhook, or
 * one of the person's custom tools run in the same sandbox.
 *
 * Project tools come from the repository - `.polaris/tools/<name>.json`, and
 * `.opencode/tool(s)/<name>.json` for compatibility - and run only once the
 * person approved that exact set of files (`projectDigest`) for the repository.
 *
 * Pure and shared: the settings screen validates with the same schemas the
 * server stores with.
 */

import { z } from "zod";

/** A tool's own name: what the model calls it after the `custom_` prefix. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
/** The prefix every custom tool carries in a turn, so one can never stand in
 *  for a built-in tool of the same name. */
export const TOOL_PREFIX = "custom_";
/** The most custom tools, and plugins, one person keeps. */
export const TOOLS_MOST = 50;
export const PLUGINS_MOST = 50;
/** The biggest script a tool may carry. */
export const SCRIPT_MAX = 64 * 1024;
/** What a run hands back at most: under hostd's 16 KiB exec cap, which cuts
 *  silently, so the end of the output is kept here and marked. */
export const OUTPUT_MAX = 12_000;
export const TIMEOUT_DEFAULT = 60;
export const TIMEOUT_MOST = 300;
/** The most input properties a tool declares. */
const PROPERTIES_MOST = 20;

export const RUNTIMES = ["shell", "node"] as const;
export type ToolRuntime = (typeof RUNTIMES)[number];

/** Who decides that a call runs: the same three answers a session's tools have. */
export const TOOL_PERMISSIONS = ["ask", "allow", "deny"] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

const propertySchema = z
    .object({
        type: z.enum(["string", "number", "integer", "boolean"]),
        description: z.string().trim().max(500).optional(),
        enum: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional()
    })
    .strict()
    .refine((property) => !property.enum || property.type === "string", {
        message: "Only a text input can list its choices."
    });

/** The input a tool takes: an object of flat, typed properties. */
export const inputSchemaShape = z
    .object({
        type: z.literal("object").default("object"),
        properties: z
            .record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/), propertySchema)
            .default({})
            .refine((properties) => Object.keys(properties).length <= PROPERTIES_MOST, {
                message: `At most ${PROPERTIES_MOST} inputs.`
            }),
        required: z.array(z.string()).max(PROPERTIES_MOST).default([])
    })
    .strict()
    .refine((schema) => schema.required.every((key) => key in schema.properties), {
        message: "A required input must be one of the inputs."
    });
export type ToolInputSchema = z.infer<typeof inputSchemaShape>;

/** A custom tool as it is saved. */
export const customToolSchema = z.object({
    name: z.string().trim().toLowerCase().regex(TOOL_NAME),
    description: z.string().trim().min(1).max(1024),
    input: inputSchemaShape,
    runtime: z.enum(RUNTIMES).default("shell"),
    script: z.string().min(1).max(SCRIPT_MAX),
    timeoutSeconds: z.number().int().min(1).max(TIMEOUT_MOST).default(TIMEOUT_DEFAULT),
    permission: z.enum(TOOL_PERMISSIONS).default("ask"),
    enabled: z.boolean().default(true)
});
export type CustomToolInput = z.input<typeof customToolSchema>;
export type CustomTool = z.infer<typeof customToolSchema>;

/** What actually runs a tool: a saved one's runtime, or Bun for one of
 *  OpenCode's TypeScript modules (never offered on the settings form). */
export type RunnerKind = ToolRuntime | "bun";
export type RunnableTool = Omit<CustomTool, "runtime"> & { readonly runtime: RunnerKind };

/**
 * Every call is parsed against this before anything is sent to the sandbox: the
 * declared properties, typed, the required ones present, and nothing else.
 */
export function callSchema(input: ToolInputSchema): z.ZodType<Record<string, unknown>> {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(input.properties)) {
        let field: z.ZodType =
            property.type === "boolean"
                ? z.boolean()
                : property.type === "integer"
                  ? z.number().int()
                  : property.type === "number"
                    ? z.number()
                    : property.enum
                      ? z.enum(property.enum as [string, ...string[]])
                      : z.string().max(SCRIPT_MAX);
        if (property.description) field = field.describe(property.description);
        shape[key] = input.required.includes(key) ? field : field.optional();
    }
    return z.object(shape).strict() as z.ZodType<Record<string, unknown>>;
}

/** The name a tool carries in a turn. */
export function turnToolName(name: string): string {
    return `${TOOL_PREFIX}${name}`;
}

/** The base64 of some text, in a form a single-quoted shell word holds as-is. */
function base64(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}

/**
 * The shell command that runs one call inside the sandbox.
 *
 * The script and the input travel base64-encoded inside single quotes, so no
 * character of either is ever read by the shell that runs this. The script is
 * written to a private temporary directory and run from the checkout; the
 * input arrives on standard input and as a file named by `POLARIS_TOOL_INPUT`.
 * `timeout` ends a run that outlives its budget, and only the last
 * `OUTPUT_MAX` bytes are printed, followed by the exit code on a line of its own.
 */
export function toolCommand(
    tool: Pick<RunnableTool, "runtime" | "script" | "timeoutSeconds">,
    args: Record<string, unknown>
): string {
    const file = tool.runtime === "node" ? "run.mjs" : tool.runtime === "bun" ? "run.ts" : "run.sh";
    const runner = tool.runtime === "shell" ? "sh" : tool.runtime;
    const seconds = Math.min(Math.max(1, Math.trunc(tool.timeoutSeconds)), TIMEOUT_MOST);
    return [
        'd="$(mktemp -d)" || exit 1',
        `printf '%s' '${base64(tool.script)}' | base64 -d > "$d/${file}"`,
        `printf '%s' '${base64(JSON.stringify(args))}' | base64 -d > "$d/input.json"`,
        'cd "${POLARIS_WORKDIR:-$HOME}" 2>/dev/null || true',
        `POLARIS_TOOL_INPUT="$d/input.json" timeout ${seconds} ${runner} "$d/${file}" < "$d/input.json" > "$d/out" 2>&1`,
        "code=$?",
        `tail -c ${OUTPUT_MAX} "$d/out"`,
        `printf '\\n%s%s\\n' "${EXIT_MARK}" "$code"`,
        'rm -rf "$d"'
    ].join("\n");
}

/** The line `toolCommand` ends with, before the exit code. */
export const EXIT_MARK = "polaris-tool-exit:";

/** What one run said, read back from the sandbox's output. */
export interface ToolRun {
    ok: boolean;
    /** 124 is `timeout`'s own code for a run it ended. */
    timedOut: boolean;
    code: number | null;
    text: string;
}

export function readToolRun(output: string): ToolRun {
    const at = output.lastIndexOf(EXIT_MARK);
    if (at < 0) return { ok: false, timedOut: false, code: null, text: output.slice(-OUTPUT_MAX) };
    const code = Number.parseInt(output.slice(at + EXIT_MARK.length).trim(), 10);
    const text = output.slice(0, at).replace(/\n$/, "");
    const known = Number.isFinite(code) ? code : null;
    return { ok: known === 0, timedOut: known === 124, code: known, text };
}

// ---------------------------------------------------------------------------
// Project tools
// ---------------------------------------------------------------------------

/** Where a repository keeps its tools, Polaris's own first. */
export const PROJECT_TOOL_DIRS = [".polaris/tools", ".opencode/tool", ".opencode/tools"] as const;
/** The most project tool files read from one checkout. */
export const PROJECT_FILES_MOST = 30;

/**
 * A project tool's manifest, `<dir>/<name>.json`: the same fields as a custom
 * tool, the name taken from the file the way OpenCode takes it, and the
 * script either inline or as a file next to the manifest.
 */
export const projectManifestSchema = z
    .object({
        description: z.string().trim().min(1).max(1024),
        input: inputSchemaShape.optional(),
        runtime: z.enum(RUNTIMES).optional(),
        script: z.string().min(1).max(SCRIPT_MAX).optional(),
        file: z
            .string()
            .regex(/^[A-Za-z0-9_.-]{1,64}$/)
            .refine((name) => !name.startsWith("."), { message: "A plain file name next to the manifest." })
            .optional(),
        timeoutSeconds: z.number().int().min(1).max(TIMEOUT_MOST).optional()
    })
    .strict()
    .refine((manifest) => Boolean(manifest.script) !== Boolean(manifest.file), {
        message: "Give either a script or a file, not both."
    });

/** One file of a checkout's tool folders, as the sandbox read it. */
export interface ProjectFile {
    /** Relative to the checkout, e.g. `.polaris/tools/lint.json`. */
    readonly path: string;
    readonly contents: string;
}

export interface ProjectTool extends RunnableTool {
    /** The manifest or module it came from. */
    readonly path: string;
}

export interface ProjectTools {
    readonly tools: ProjectTool[];
    /** Manifests that could not be read, by path, so the person sees why. */
    readonly refused: string[];
    /** OpenCode's TypeScript or JavaScript tool modules, by path: code that
     *  only says what it takes once it runs, so read in the sandbox with Bun
     *  after the approval (`moduleListCommand`), never before. */
    readonly modules: string[];
}

/** A file OpenCode loads as a tool module (`.opencode/tool(s)/<name>.ts`). */
export const MODULE_FILE = /^\.opencode\/tools?\/[^/]+\.(ts|js|mjs)$/;

/** The tools a checkout's files declare. The first folder wins a name. */
export function parseProjectTools(files: readonly ProjectFile[]): ProjectTools {
    const byPath = new Map(files.map((file) => [file.path, file.contents]));
    const tools: ProjectTool[] = [];
    const refused: string[] = [];
    const taken = new Set<string>();
    const referenced = new Set<string>();
    for (const dir of PROJECT_TOOL_DIRS) {
        const manifests = files
            .filter((file) => file.path.startsWith(`${dir}/`) && file.path.endsWith(".json"))
            .filter((file) => !file.path.slice(dir.length + 1).includes("/"))
            .sort((a, b) => a.path.localeCompare(b.path));
        for (const file of manifests) {
            const name = file.path.slice(dir.length + 1, -".json".length).toLowerCase();
            if (!TOOL_NAME.test(name) || taken.has(name)) {
                refused.push(file.path);
                continue;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(file.contents);
            } catch {
                refused.push(file.path);
                continue;
            }
            const manifest = projectManifestSchema.safeParse(raw);
            if (!manifest.success) {
                refused.push(file.path);
                continue;
            }
            if (manifest.data.file) referenced.add(`${dir}/${manifest.data.file}`);
            const script = manifest.data.script ?? byPath.get(`${dir}/${manifest.data.file}`);
            if (!script) {
                refused.push(file.path);
                continue;
            }
            const runtime =
                manifest.data.runtime ?? (/\.(m?js)$/.test(manifest.data.file ?? "") ? "node" : "shell");
            const parsed = customToolSchema.safeParse({
                name,
                description: manifest.data.description,
                input: manifest.data.input ?? {},
                runtime,
                script,
                timeoutSeconds: manifest.data.timeoutSeconds ?? TIMEOUT_DEFAULT,
                permission: "ask",
                enabled: true
            });
            if (!parsed.success) {
                refused.push(file.path);
                continue;
            }
            taken.add(name);
            tools.push({ ...parsed.data, path: file.path });
        }
    }
    const modules = files
        .map((file) => file.path)
        .filter((path) => MODULE_FILE.test(path) && !referenced.has(path))
        .sort();
    return { tools, refused, modules };
}

/**
 * What an approval is for: a digest of every tool file at the revision the
 * person looked at. A commit that changes, adds or removes any of them is a new
 * digest, and so a new approval; one that touches nothing else keeps the old.
 */
export async function projectDigest(files: readonly ProjectFile[]): Promise<string> {
    const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const text = ordered.map((file) => `${file.path}\u0000${file.contents}\u0000`).join("");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Buffer.from(hash).toString("hex");
}

/**
 * The command that prints the checkout's tool files as base64 lines,
 * `<path>\t<base64>`, bounded by `PROJECT_FILES_MOST` and `SCRIPT_MAX`.
 */
export function projectFilesCommand(): string {
    const dirs = PROJECT_TOOL_DIRS.map((dir) => `'${dir}'`).join(" ");
    return [
        `if command -v bun >/dev/null 2>&1; then echo '${BUN_MARK}1'; else echo '${BUN_MARK}0'; fi`,
        'cd "${POLARIS_WORKDIR:-$HOME}" 2>/dev/null || exit 0',
        `for dir in ${dirs}; do [ -d "$dir" ] && find "$dir" -maxdepth 1 -type f -size -${SCRIPT_MAX / 1024}k; done | sort | head -n ${PROJECT_FILES_MOST} | while IFS= read -r f; do`,
        '    printf \'%s\\t%s\\n\' "$f" "$(base64 < "$f" | tr -d \'\\n\')"',
        "done"
    ].join("\n");
}

/** The line `projectFilesCommand` starts with: whether the sandbox has Bun. */
export const BUN_MARK = "polaris-bun:";

export function readHasBun(output: string): boolean {
    return output.split("\n").some((line) => line.trim() === `${BUN_MARK}1`);
}

/** The lines `projectFilesCommand` printed, as files. */
export function readProjectFiles(output: string): ProjectFile[] {
    const files: ProjectFile[] = [];
    for (const line of output.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab <= 0) continue;
        const path = line.slice(0, tab).replace(/^\.\//, "");
        if (!PROJECT_TOOL_DIRS.some((dir) => path.startsWith(`${dir}/`))) continue;
        files.push({ path, contents: Buffer.from(line.slice(tab + 1).trim(), "base64").toString("utf8") });
        if (files.length >= PROJECT_FILES_MOST) break;
    }
    return files;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** The events a plugin can react to, after OpenCode's plugin hooks. */
export const PLUGIN_EVENTS = [
    "tool.before",
    "tool.after",
    "session.start",
    "session.end",
    "permission.asked",
    "message.sent"
] as const;
export type PluginEvent = (typeof PLUGIN_EVENTS)[number];

export const pluginActionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("webhook"),
        url: z
            .string()
            .trim()
            .url()
            .max(2048)
            .refine((url) => url.startsWith("https://"), { message: "An https address." })
    }),
    z.object({ kind: z.literal("tool"), tool: z.string().trim().toLowerCase().regex(TOOL_NAME) })
]);

export const pluginSchema = z.object({
    name: z.string().trim().min(1).max(80),
    events: z.array(z.enum(PLUGIN_EVENTS)).min(1).max(PLUGIN_EVENTS.length),
    action: pluginActionSchema,
    enabled: z.boolean().default(true)
});
export type PluginInput = z.input<typeof pluginSchema>;
export type Plugin = z.infer<typeof pluginSchema>;

/** The events a session's own lifecycle hooks map to (`session-hooks.ts`). */
const HOOK_EVENTS: Record<string, PluginEvent> = {
    "tool.start": "tool.before",
    "tool.end": "tool.after",
    "tool.failed": "tool.after",
    "session.start": "session.start",
    "session.end": "session.end",
    prompt: "message.sent",
    "permission.request": "permission.asked"
};

/** The plugin event a normalized session hook is, or null for one no plugin
 *  hears. */
export function pluginEventOfHook(kind: string): PluginEvent | null {
    return HOOK_EVENTS[kind] ?? null;
}

/** The plugins that hear an event, enabled and in the order they were saved. */
export function pluginsFor<T extends Pick<Plugin, "events" | "enabled">>(plugins: readonly T[], event: PluginEvent): T[] {
    return plugins.filter((plugin) => plugin.enabled && plugin.events.includes(event));
}

/** What a plugin is sent: the event and its facts, never a credential. The
 *  detail is cut so one huge tool output cannot become a huge POST. */
export function pluginPayload(event: PluginEvent, facts: { sessionId?: string; threadId?: string; tool?: string; detail?: string }): Record<string, unknown> {
    return {
        event,
        at: new Date().toISOString(),
        ...(facts.sessionId ? { sessionId: facts.sessionId } : {}),
        ...(facts.threadId ? { threadId: facts.threadId } : {}),
        ...(facts.tool ? { tool: facts.tool } : {}),
        ...(facts.detail ? { detail: facts.detail.slice(0, 2000) } : {})
    };
}

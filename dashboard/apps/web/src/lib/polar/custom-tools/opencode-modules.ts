/**
 * OpenCode's own tool modules (`.opencode/tool(s)/<file>.ts`), run the way
 * OpenCode runs them: Bun imports the file, every export with an `execute`
 * is a tool named `<file>` (the default export) or `<file>_<export>`, its
 * `args` are Zod schemas, and `execute(args, context)` answers a string.
 *
 * A module only says what it takes once it runs, so it is imported in the
 * session's sandbox, with Bun and the checkout's own `zod`, and only after
 * the person approved the revision. A sandbox without Bun, or a module whose
 * input Polaris cannot describe, is listed as unavailable with the reason.
 *
 * Pure: builds the commands and reads their output.
 */

import * as shared from "@/lib/polar/custom-tools/shared";

/** One line of `moduleListCommand`'s output. */
interface ListedExport {
    readonly file: string;
    readonly export?: string;
    readonly description?: string;
    readonly schema?: unknown;
    readonly error?: string;
}

/** A module that could not be offered, and why, in words for the screen. */
export interface UnavailableModule {
    readonly path: string;
    readonly reason: "no_bun" | "no_zod" | "load_failed" | "input" | "name";
}

/** The marker each listed line carries, so other output is never read as one. */
const LINE_MARK = "polaris-module:";

function base64(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}

/** The Bun program that imports every module and prints what it exports. */
function listProgram(paths: readonly string[]): string {
    return [
        `const files = ${JSON.stringify(paths)};`,
        `const mark = ${JSON.stringify(LINE_MARK)};`,
        "const dir = process.cwd();",
        "let z = null;",
        "try { const loaded = await import(Bun.resolveSync(\"zod\", dir)); z = loaded.z ?? loaded; } catch {}",
        "for (const file of files) {",
        "    if (!z || typeof z.toJSONSchema !== \"function\") { console.log(mark + JSON.stringify({ file, error: \"no_zod\" })); continue; }",
        "    let mod;",
        "    try { mod = await import(dir + \"/\" + file); } catch { console.log(mark + JSON.stringify({ file, error: \"load_failed\" })); continue; }",
        "    for (const [key, value] of Object.entries(mod)) {",
        "        if (!value || typeof value.execute !== \"function\") continue;",
        "        let schema = null;",
        "        try { schema = z.toJSONSchema(z.object(value.args ?? {})); } catch {}",
        "        console.log(mark + JSON.stringify({ file, export: key, description: String(value.description ?? \"\"), schema }));",
        "    }",
        "}"
    ].join("\n");
}

/** The shell command that lists the modules' tools in the sandbox. */
export function moduleListCommand(paths: readonly string[]): string {
    return [
        'cd "${POLARIS_WORKDIR:-$HOME}" 2>/dev/null || exit 0',
        'd="$(mktemp -d)" || exit 1',
        `printf '%s' '${base64(listProgram(paths))}' | base64 -d > "$d/list.ts"`,
        "timeout 60 bun \"$d/list.ts\" 2>/dev/null",
        'rm -rf "$d"'
    ].join("\n");
}

/** The program one call runs: the module's export, its own Zod parse, and
 *  OpenCode's context for what Polaris has (session and folder). */
function callProgram(file: string, exportName: string, sessionId: string): string {
    return [
        "const dir = process.cwd();",
        "const input = JSON.parse(await Bun.file(process.env.POLARIS_TOOL_INPUT).text());",
        "const loaded = await import(Bun.resolveSync(\"zod\", dir));",
        "const z = loaded.z ?? loaded;",
        `const mod = await import(dir + "/" + ${JSON.stringify(file)});`,
        `const def = mod[${JSON.stringify(exportName)}];`,
        "const args = z.object(def.args ?? {}).parse(input);",
        "const context = {",
        `    sessionID: ${JSON.stringify(sessionId)}, messageID: "", agent: "polaris", directory: dir, worktree: dir,`,
        "    abort: new AbortController().signal, metadata() {}, async ask() {}",
        "};",
        "const result = await def.execute(args, context);",
        "process.stdout.write(typeof result === \"string\" ? result : JSON.stringify(result ?? \"\"));"
    ].join("\n");
}

/** A JSON Schema property Polaris's flat input shape can hold, or null. */
function propertyOf(raw: unknown): shared.ToolInputSchema["properties"][string] | null {
    if (!raw || typeof raw !== "object") return null;
    const property = raw as Record<string, unknown>;
    const type = property.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") return null;
    const description = typeof property.description === "string" ? property.description.slice(0, 500) : undefined;
    const choices = Array.isArray(property.enum) && property.enum.every((entry) => typeof entry === "string")
        ? (property.enum as string[])
        : undefined;
    return { type, ...(description ? { description } : {}), ...(choices ? { enum: choices } : {}) };
}

/** A module's input as Polaris's shape, or null when it is not flat. */
export function inputOf(schema: unknown): shared.ToolInputSchema | null {
    if (!schema || typeof schema !== "object") return null;
    const object = schema as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries((object.properties as Record<string, unknown> | undefined) ?? {})) {
        const property = propertyOf(raw);
        if (!property) return null;
        properties[key] = property;
    }
    const parsed = shared.inputSchemaShape.safeParse({
        properties,
        required: Array.isArray(object.required) ? object.required : []
    });
    return parsed.success ? parsed.data : null;
}

/** The tools `moduleListCommand` printed, and the modules that gave none. */
export function readModuleList(
    output: string,
    paths: readonly string[],
    sessionId: string,
    taken: ReadonlySet<string>
): { tools: shared.ProjectTool[]; unavailable: UnavailableModule[] } {
    const tools: shared.ProjectTool[] = [];
    const unavailable: UnavailableModule[] = [];
    const names = new Set(taken);
    const seen = new Set<string>();
    for (const line of output.split("\n")) {
        if (!line.startsWith(LINE_MARK)) continue;
        let entry: ListedExport;
        try {
            entry = JSON.parse(line.slice(LINE_MARK.length)) as ListedExport;
        } catch {
            continue;
        }
        if (typeof entry.file !== "string" || !paths.includes(entry.file)) continue;
        seen.add(entry.file);
        if (entry.error === "no_zod" || entry.error === "load_failed") {
            unavailable.push({ path: entry.file, reason: entry.error });
            continue;
        }
        if (typeof entry.export !== "string") continue;
        const base = entry.file.replace(/^.*\//, "").replace(/\.[^.]+$/, "").toLowerCase();
        const name = entry.export === "default" ? base : `${base}_${entry.export.toLowerCase()}`;
        if (!shared.TOOL_NAME.test(name) || names.has(name)) {
            unavailable.push({ path: `${entry.file}#${entry.export}`, reason: "name" });
            continue;
        }
        const input = inputOf(entry.schema);
        const parsed = input
            ? shared.customToolSchema.safeParse({
                  name,
                  description: entry.description || name,
                  input,
                  script: callProgram(entry.file, entry.export, sessionId),
                  permission: "ask"
              })
            : null;
        if (!parsed?.success) {
            unavailable.push({ path: `${entry.file}#${entry.export}`, reason: "input" });
            continue;
        }
        names.add(name);
        tools.push({ ...parsed.data, runtime: "bun", path: entry.file });
    }
    for (const path of paths) if (!seen.has(path)) unavailable.push({ path, reason: "load_failed" });
    return { tools, unavailable };
}

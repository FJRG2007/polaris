/**
 * The project's own formatter, run on a file the native agent just wrote.
 *
 * Ported from OpenCode (sst/opencode `packages/core/src/formatter/builtins.ts`
 * and v1.0.0 `packages/opencode/src/format/index.ts`): each formatter names the
 * extensions it handles and is enabled only when the checkout configures it,
 * every enabled one runs in order with the file in place of `$FILE`, and a
 * formatter that fails is logged and the write stands. Narrower than
 * OpenCode's list on purpose: a formatter runs only when both the tool and its
 * configuration are in the checkout (or the tool on the PATH beside a project
 * file that names the language), so nothing reformats a repository that never
 * asked for it.
 *
 * Every command is an argument array run through the `Workspace`, with no
 * shell and a timeout. Node packages run through this process's own node, so
 * the `.cmd` shims on Windows never matter. Server-free.
 */

import * as path from "node:path";
import type { Workspace } from "@/lib/polar/native/workspace";

export const FORMAT_TIMEOUT_MS = 10_000;
/** Folders walked up from a file looking for configuration. */
const MAX_DEPTH = 64;

/** What one search for configuration is bounded by. */
export interface Lookup {
    readonly ws: Workspace;
    /** The folder the edited file is in. */
    readonly dir: string;
}

export interface Formatter {
    readonly name: string;
    readonly extensions: readonly string[];
    /** The command with `$FILE` in it, or null when the checkout does not use it. */
    detect(lookup: Lookup): Promise<string[] | null>;
}

function within(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Every `name` from `dir` up to the checkout's root, nearest first. Nothing
 *  above the checkout counts: configuration there is not the project's. */
export async function findUp(lookup: Lookup, name: string): Promise<string[]> {
    const { ws } = lookup;
    if (!within(ws.root, lookup.dir)) return [];
    const out: string[] = [];
    let dir = lookup.dir;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const candidate = path.join(dir, name);
        if ((await ws.stat(candidate))?.kind === "file") out.push(candidate);
        if (path.relative(ws.root, dir) === "") break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return out;
}

async function readJson(ws: Workspace, file: string): Promise<Record<string, unknown> | null> {
    try {
        const value: unknown = JSON.parse((await ws.readFile(file)).toString("utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

async function readText(ws: Workspace, file: string): Promise<string> {
    try {
        return (await ws.readFile(file)).toString("utf8");
    } catch {
        return "";
    }
}

function hasKey(record: Record<string, unknown>, field: string, key: string): boolean {
    const value = record[field];
    return !!value && typeof value === "object" && key in (value as Record<string, unknown>);
}

/** Whether a package.json between the file and the root depends on `name`. */
export async function dependsOn(lookup: Lookup, name: string): Promise<boolean> {
    for (const file of await findUp(lookup, "package.json")) {
        const json = await readJson(lookup.ws, file);
        if (json && (hasKey(json, "dependencies", name) || hasKey(json, "devDependencies", name))) return true;
    }
    return false;
}

/** The absolute path of an installed npm package's executable script, from
 *  its own package.json `bin`, or null when it is not installed. */
export async function packageBin(lookup: Lookup, name: string, bin: string = name.split("/").pop() ?? name): Promise<string | null> {
    for (const manifest of await findUp(lookup, path.join("node_modules", ...name.split("/"), "package.json"))) {
        const json = await readJson(lookup.ws, manifest);
        const field = json?.bin;
        const relative = typeof field === "string" ? field : field && typeof field === "object" ? (field as Record<string, unknown>)[bin] : null;
        if (typeof relative !== "string") continue;
        const script = path.resolve(path.dirname(manifest), relative);
        if ((await lookup.ws.stat(script))?.kind === "file") return script;
    }
    return null;
}

const WEB = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".json", ".jsonc", ".yaml", ".yml", ".md", ".mdx", ".graphql", ".gql"];

/** A program on the PATH, enabled when one of `markers` is in the checkout. */
function onPath(name: string, extensions: readonly string[], markers: readonly string[], args: readonly string[]): Formatter {
    return {
        name,
        extensions,
        async detect(lookup) {
            for (const marker of markers) {
                if ((await findUp(lookup, marker)).length === 0) continue;
                return (await lookup.ws.has(name)) ? [name, ...args] : null;
            }
            return null;
        }
    };
}

export const FORMATTERS: readonly Formatter[] = [
    onPath("gofmt", [".go"], ["go.mod"], ["-w", "$FILE"]),
    {
        name: "prettier",
        extensions: WEB,
        async detect(lookup) {
            if (!(await dependsOn(lookup, "prettier"))) return null;
            const bin = await packageBin(lookup, "prettier");
            return bin ? [process.execPath, bin, "--write", "$FILE"] : null;
        }
    },
    {
        name: "biome",
        extensions: WEB,
        async detect(lookup) {
            const configs = [...(await findUp(lookup, "biome.json")), ...(await findUp(lookup, "biome.jsonc"))];
            if (configs.length === 0) return null;
            const bin = await packageBin(lookup, "@biomejs/biome", "biome");
            return bin ? [process.execPath, bin, "format", "--write", "$FILE"] : null;
        }
    },
    onPath("clang-format", [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"], [".clang-format"], ["-i", "$FILE"]),
    {
        name: "ruff",
        extensions: [".py", ".pyi"],
        async detect(lookup) {
            let configured = (await findUp(lookup, "ruff.toml")).length > 0 || (await findUp(lookup, ".ruff.toml")).length > 0;
            if (!configured) {
                const [pyproject] = await findUp(lookup, "pyproject.toml");
                configured = !!pyproject && (await readText(lookup.ws, pyproject)).includes("[tool.ruff");
            }
            return configured && (await lookup.ws.has("ruff")) ? ["ruff", "format", "$FILE"] : null;
        }
    },
    onPath("rustfmt", [".rs"], ["Cargo.toml"], ["$FILE"])
];

export interface FormatResult {
    /** The formatters that ran and succeeded. */
    readonly ran: readonly string[];
}

export type Log = (line: string) => void;

/**
 * Runs every formatter the checkout configures for `file`. Never throws: a
 * formatter that fails, times out or cannot start is logged and skipped.
 * `cache` remembers each formatter's command per folder for the session.
 */
export async function formatFile(
    ws: Workspace,
    file: string,
    options: { signal?: AbortSignal; log: Log; cache: Map<string, string[] | null>; formatters?: readonly Formatter[] }
): Promise<FormatResult> {
    const ran: string[] = [];
    if (!within(ws.root, file)) return { ran };
    const extension = path.extname(file);
    const lookup: Lookup = { ws, dir: path.dirname(file) };
    for (const formatter of options.formatters ?? FORMATTERS) {
        if (!formatter.extensions.includes(extension)) continue;
        const key = `${formatter.name}\u0000${lookup.dir}`;
        let command = options.cache.get(key);
        if (command === undefined) {
            command = await formatter.detect(lookup).catch(() => null);
            options.cache.set(key, command);
        }
        if (!command) continue;
        const argv = command.map((part) => (part === "$FILE" ? file : part));
        try {
            const result = await ws.exec(argv, { cwd: ws.root, timeoutMs: FORMAT_TIMEOUT_MS, signal: options.signal });
            if (result.code === 0) ran.push(formatter.name);
            else options.log(`${formatter.name} did not format ${file}: ${result.timedOut ? "timed out" : `exit ${result.code ?? "killed"}`}`);
        } catch (error) {
            options.log(`${formatter.name} did not start: ${(error as Error).message}`);
        }
    }
    return { ran };
}

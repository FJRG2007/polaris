/**
 * What a repository already tells another platform about deploying it.
 *
 * A project that deploys on Railway, Render, Netlify, Vercel or Heroku carries a
 * file saying how: the build command, the start command, the health path, the
 * variables it needs. Reading those means a service created here starts with the
 * same settings instead of somebody copying them across by hand - and the screen
 * lists what was picked up, so nothing is set that the reader did not see.
 *
 * Only documented fields, and only the ones a Polaris service has a setting for:
 *
 *   railway.json / railway.toml  build.buildCommand, build.builder,
 *                                build.dockerfilePath, deploy.startCommand,
 *                                deploy.healthcheckPath
 *   render.yaml                  the first web service: rootDir, buildCommand,
 *                                startCommand, healthCheckPath, dockerfilePath,
 *                                numInstances, envVars (value / sync / generateValue)
 *   netlify.toml                 [build] base, publish, command; [build.environment]
 *   vercel.json                  installCommand, buildCommand, outputDirectory
 *   Procfile                     the web: process
 *   app.json                     env (value / required / generator), formation.web.quantity
 *
 * Pure and dependency-free: the parsers read the narrow shapes those files take in
 * practice rather than whole TOML and YAML, and a file they cannot read is skipped,
 * never an error.
 */

import { procfileWeb } from "./detect-languages.js";

/** Every file this reads, at the service's directory. */
export const CONFIG_FILES = [
    "railway.json",
    "railway.toml",
    "render.yaml",
    "netlify.toml",
    "vercel.json",
    "Procfile",
    "app.json"
] as const;

export type ConfigFile = (typeof CONFIG_FILES)[number];

/** One setting and where it came from, for the screen to list. */
export interface PickedSetting {
    readonly setting:
        | "installCommand"
        | "buildCommand"
        | "startCommand"
        | "outputDirectory"
        | "rootDirectory"
        | "dockerfilePath"
        | "healthPath"
        | "replicas";
    readonly value: string;
    readonly from: ConfigFile;
}

export interface ImportedConfig {
    readonly settings: readonly PickedSetting[];
    /** Variables with a literal value, set as plain variables. */
    readonly variables: Readonly<Record<string, string>>;
    /** Variables a file says to generate a random value for. */
    readonly generate: readonly string[];
    /** Variables a file names as required but gives no value. */
    readonly needs: readonly string[];
    /** Anything read and deliberately left alone, in one line each. */
    readonly skipped: readonly string[];
}

type Settings = Partial<Record<PickedSetting["setting"], string>>;

interface Parsed {
    readonly settings: Settings;
    readonly variables?: Record<string, string>;
    readonly generate?: string[];
    readonly needs?: string[];
    readonly skipped?: string[];
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Whether a command changes into another directory first, which means it
 *  describes that directory's build rather than this one's. */
function changesDirectory(command: string | undefined): boolean {
    return command ? /(?:^|&&|;|\|)\s*cd\s+['"]?(?!\.\/?['"]?(?:\s|&|;|$))[^'"&;|\s]+/.test(command) : false;
}

/** A directory as the service stores it: relative, no leading or trailing slash. */
function directory(value: string | undefined): string | undefined {
    const cleaned = value?.replace(/^\.?\/+/, "").replace(/\/+$/, "").trim();
    return cleaned ? cleaned : undefined;
}

/* -------------------------------------------------------------------------- */
/* TOML, the narrow part                                                      */
/* -------------------------------------------------------------------------- */

/** The value on the right of `key = value`: a quoted string (with the usual
 *  escapes), or a bare word with any trailing comment removed. */
function tomlValue(rest: string): string | undefined {
    const trimmed = rest.trim();
    const quote = trimmed[0];
    if (quote === '"' || quote === "'") {
        let out = "";
        for (let at = 1; at < trimmed.length; at += 1) {
            const char = trimmed[at];
            if (quote === '"' && char === "\\" && at + 1 < trimmed.length) {
                const next = trimmed[++at];
                out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
                continue;
            }
            if (char === quote) return out;
            out += char;
        }
        return undefined;
    }
    const bare = trimmed.split("#")[0]?.trim();
    return bare ? bare : undefined;
}

/** `{ "table.key": value }` for every scalar in the file, tables by their full
 *  dotted name. Arrays, inline tables and multi-line strings are skipped. */
function tomlScalars(raw: string): Map<string, string> {
    const values = new Map<string, string>();
    let table = "";
    const lines = raw.split(/\r?\n/);
    for (let at = 0; at < lines.length; at += 1) {
        const line = lines[at] ?? "";
        const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
        if (header?.[1]) {
            table = header[1].trim();
            continue;
        }
        const pair = /^\s*([A-Za-z0-9_."-]+)\s*=\s*(.+)$/.exec(line);
        if (!pair?.[1] || !pair[2]) continue;
        const rest = pair[2];
        if (/^("""|''')/.test(rest.trim())) {
            // Skip the body of a multi-line string so none of it reads as a key.
            const delimiter = rest.trim().slice(0, 3);
            if (!rest.trim().slice(3).includes(delimiter)) {
                while (++at < lines.length && !(lines[at] ?? "").includes(delimiter)) {
                    // the body
                }
            }
            continue;
        }
        if (/^[[{]/.test(rest.trim())) continue;
        const value = tomlValue(rest);
        if (value === undefined) continue;
        const key = pair[1].replace(/"/g, "");
        values.set(table ? `${table}.${key}` : key, value);
    }
    return values;
}

/* -------------------------------------------------------------------------- */
/* Railway                                                                    */
/* -------------------------------------------------------------------------- */

function fromRailway(build: Record<string, unknown>, deploy: Record<string, unknown>): Parsed {
    const settings: Settings = {};
    const skipped: string[] = [];
    const buildCommand = text(build.buildCommand);
    if (buildCommand && changesDirectory(buildCommand)) skipped.push(`its build command changes into another directory: ${buildCommand}`);
    else if (buildCommand) settings.buildCommand = buildCommand;
    const start = text(deploy.startCommand);
    if (start) settings.startCommand = start;
    const health = text(deploy.healthcheckPath);
    if (health?.startsWith("/")) settings.healthPath = health;
    if (text(build.builder)?.toUpperCase() === "DOCKERFILE") {
        settings.dockerfilePath = text(build.dockerfilePath) ?? "Dockerfile";
    }
    return { settings, skipped };
}

function parseRailwayJson(raw: string): Parsed | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const object = parsed as Record<string, unknown>;
    const section = (name: string) =>
        object[name] && typeof object[name] === "object" ? (object[name] as Record<string, unknown>) : {};
    return fromRailway(section("build"), section("deploy"));
}

function parseRailwayToml(raw: string): Parsed {
    const values = tomlScalars(raw);
    const pick = (table: string) =>
        Object.fromEntries([...values].filter(([key]) => key.startsWith(`${table}.`)).map(([key, value]) => [key.slice(table.length + 1), value]));
    return fromRailway(pick("build"), pick("deploy"));
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

function yamlScalar(raw: string): string | undefined {
    const trimmed = raw.replace(/\s+#.*$/, "").trim();
    if (!trimmed || trimmed === "|" || trimmed === ">" || trimmed.startsWith("|") || trimmed.startsWith(">")) return undefined;
    const quoted = /^(['"])(.*)\1$/.exec(trimmed);
    return quoted ? quoted[2] : trimmed;
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/**
 * The first web service of a render.yaml (else its first service), read line by
 * line: the scalar keys at the service's own indentation, and its envVars list.
 */
function parseRender(raw: string): Parsed | null {
    const lines = raw.split(/\r?\n/);
    const start = lines.findIndex((line) => /^services\s*:/.test(line));
    if (start < 0) return null;
    // Split the services list into one block of lines per item.
    const blocks: string[][] = [];
    let itemIndent = -1;
    for (let at = start + 1; at < lines.length; at += 1) {
        const line = lines[at] ?? "";
        if (!line.trim() || line.trim().startsWith("#")) continue;
        if (indentOf(line) === 0) break;
        const item = /^(\s*)-\s+/.exec(line);
        if (item && (itemIndent < 0 || item[1]?.length === itemIndent)) {
            itemIndent = item[1]?.length ?? 0;
            blocks.push([line.replace(/^(\s*)-\s+/, (_match, space: string) => `${space}  `)]);
            continue;
        }
        blocks[blocks.length - 1]?.push(line);
    }
    const block = blocks.find((lines) => lines.some((line) => /^\s*type\s*:\s*['"]?web['"]?\s*$/.test(line))) ?? blocks[0];
    if (!block) return null;
    const keyIndent = indentOf(block[0] ?? "");
    const settings: Settings = {};
    const variables: Record<string, string> = {};
    const generate: string[] = [];
    const needs: string[] = [];
    const skipped: string[] = [];
    let inEnv = false;
    let envKey: string | null = null;
    const closeEnvKey = () => {
        if (envKey) needs.push(envKey);
        envKey = null;
    };
    for (const line of block) {
        const indent = indentOf(line);
        const pair = /^\s*-?\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
        if (!pair?.[1]) continue;
        const [, key, rest = ""] = pair;
        if (indent === keyIndent && !line.trimStart().startsWith("-")) {
            if (inEnv) closeEnvKey();
            inEnv = key === "envVars";
            const value = yamlScalar(rest);
            if (!value) continue;
            if (key === "rootDir") settings.rootDirectory = value;
            else if (key === "buildCommand") {
                // Render's build step is often only the install; that is not a build.
                if (!/^(npm|yarn|pnpm|bun)\s+(install|i|ci)\s*$/.test(value)) settings.buildCommand = value;
            } else if (key === "startCommand") settings.startCommand = value;
            else if (key === "healthCheckPath" && value.startsWith("/")) settings.healthPath = value;
            else if (key === "dockerfilePath") settings.dockerfilePath = value;
            else if (key === "numInstances" && /^\d+$/.test(value)) settings.replicas = value;
            continue;
        }
        if (!inEnv) continue;
        const value = yamlScalar(rest);
        if (key === "key") {
            closeEnvKey();
            envKey = value ?? null;
        } else if (envKey && key === "value" && value !== undefined) {
            variables[envKey] = value;
            envKey = null;
        } else if (envKey && key === "generateValue" && value === "true") {
            generate.push(envKey);
            envKey = null;
        } else if (envKey && key === "fromDatabase") {
            skipped.push(`${envKey} comes from a Render database - point it at a Polaris one`);
            envKey = null;
        } else if (envKey && key === "fromService") {
            skipped.push(`${envKey} comes from another Render service`);
            envKey = null;
        }
    }
    if (inEnv) closeEnvKey();
    return { settings, variables, generate, needs, skipped };
}

/* -------------------------------------------------------------------------- */
/* Netlify, Vercel, Heroku                                                    */
/* -------------------------------------------------------------------------- */

function parseNetlify(raw: string): Parsed {
    const values = tomlScalars(raw);
    const settings: Settings = {};
    const base = directory(values.get("build.base"));
    if (base) settings.rootDirectory = base;
    const publish = directory(values.get("build.publish"));
    // Netlify's publish directory is relative to its base, as the service's is to
    // its root directory.
    if (publish) settings.outputDirectory = base && publish.startsWith(`${base}/`) ? publish.slice(base.length + 1) : publish;
    const command = values.get("build.command");
    if (command) settings.buildCommand = command;
    const variables = Object.fromEntries(
        [...values].filter(([key]) => key.startsWith("build.environment.")).map(([key, value]) => [key.slice("build.environment.".length), value])
    );
    return { settings, variables };
}

function parseVercel(raw: string): Parsed | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const object = parsed as Record<string, unknown>;
    const settings: Settings = {};
    const skipped: string[] = [];
    for (const key of ["installCommand", "buildCommand"] as const) {
        const command = text(object[key]);
        if (command && changesDirectory(command)) skipped.push(`vercel.json's ${key} changes into another directory: ${command}`);
        else if (command) settings[key] = command;
    }
    const output = directory(text(object.outputDirectory));
    if (output) settings.outputDirectory = output;
    return { settings, skipped };
}

function parseAppJson(raw: string): Parsed | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const object = parsed as Record<string, unknown>;
    const settings: Settings = {};
    const variables: Record<string, string> = {};
    const generate: string[] = [];
    const needs: string[] = [];
    const env = object.env && typeof object.env === "object" ? (object.env as Record<string, unknown>) : {};
    for (const [key, entry] of Object.entries(env)) {
        if (typeof entry === "string") {
            variables[key] = entry;
            continue;
        }
        if (!entry || typeof entry !== "object") continue;
        const spec = entry as { value?: unknown; required?: unknown; generator?: unknown };
        if (typeof spec.value === "string") variables[key] = spec.value;
        else if (spec.generator === "secret") generate.push(key);
        // Required unless it says otherwise - that is app.json's own default.
        else if (spec.required !== false) needs.push(key);
    }
    const formation = object.formation && typeof object.formation === "object" ? (object.formation as Record<string, unknown>) : {};
    const web = formation.web && typeof formation.web === "object" ? (formation.web as { quantity?: unknown }) : {};
    if (typeof web.quantity === "number" && Number.isInteger(web.quantity) && web.quantity > 0) settings.replicas = String(web.quantity);
    return { settings, variables, generate, needs };
}

/* -------------------------------------------------------------------------- */
/* Folding                                                                    */
/* -------------------------------------------------------------------------- */

/** In precedence order: the first file that states a setting decides it. The
 *  Railway and Netlify files and vercel.json are explicit build configuration;
 *  render.yaml and the Heroku files are read after them. */
const PARSERS: ReadonlyArray<readonly [ConfigFile, (raw: string) => Parsed | null]> = [
    ["railway.json", parseRailwayJson],
    ["railway.toml", parseRailwayToml],
    ["netlify.toml", parseNetlify],
    ["vercel.json", parseVercel],
    ["render.yaml", parseRender],
    ["Procfile", (raw) => {
        const web = procfileWeb(raw);
        return web ? { settings: { startCommand: web } } : null;
    }],
    ["app.json", parseAppJson]
];

/** Read whichever of `CONFIG_FILES` the caller found, keyed by file name. */
export function importDeployConfig(texts: Readonly<Partial<Record<string, string>>>): ImportedConfig {
    const settings: PickedSetting[] = [];
    const variables: Record<string, string> = {};
    const generate = new Set<string>();
    const needs = new Set<string>();
    const skipped: string[] = [];
    for (const [file, parse] of PARSERS) {
        const raw = texts[file];
        if (!raw) continue;
        const parsed = parse(raw);
        if (!parsed) {
            skipped.push(`${file} could not be read`);
            continue;
        }
        for (const [setting, value] of Object.entries(parsed.settings) as [PickedSetting["setting"], string][]) {
            if (!settings.some((picked) => picked.setting === setting)) settings.push({ setting, value, from: file });
        }
        for (const [key, value] of Object.entries(parsed.variables ?? {})) if (!(key in variables)) variables[key] = value;
        for (const key of parsed.generate ?? []) generate.add(key);
        for (const key of parsed.needs ?? []) needs.add(key);
        skipped.push(...(parsed.skipped ?? []));
    }
    // A variable that has a value, or one that is generated, needs nothing more.
    for (const key of [...needs]) if (key in variables || generate.has(key)) needs.delete(key);
    for (const key of [...generate]) if (key in variables) generate.delete(key);
    return { settings, variables, generate: [...generate], needs: [...needs], skipped };
}

/** Whether anything was picked up at all. */
export function importedAnything(config: ImportedConfig): boolean {
    return (
        config.settings.length > 0 ||
        Object.keys(config.variables).length > 0 ||
        config.generate.length > 0 ||
        config.needs.length > 0
    );
}

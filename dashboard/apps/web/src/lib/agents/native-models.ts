/**
 * The models a coding tool itself says it can run, read on the machine the
 * session runs on.
 *
 * Ported from backend/internal/adapters/agent/modelcatalog/catalog.go,
 * provider_catalog.go and backend/internal/adapters/chatdriver/codexappserver
 * (conversation.go `listModels`, driver.go `initializeConnection`) of Agent
 * Orchestrator (Apache-2.0, see NOTICE.md).
 *
 * The public index (`model-catalog.ts`) says what a provider serves; a tool's
 * own list says what that tool, signed in the way it is, will accept - a plan
 * that does not include a model, a provider configured only on that machine, a
 * model released after the index was last read. Each tool is asked the way its
 * own command line or cache answers:
 *
 *   - OpenCode, Kilo Code, MiMo Code: `<bin> models` (what it can run now) and
 *     its models.dev cache `${XDG_CACHE_HOME:-~/.cache}/<name>/models.json`
 *     (every model it knows).
 *   - Pi, Kimchi: `<bin> --list-models`, plus the model store and the user's own
 *     provider declarations in the tool's agent directory.
 *   - Oh My Pi: `omp models --json`, plus its model database, opened read-only.
 *   - Codex: `model/list` over `codex app-server`'s JSON-RPC on stdio.
 *
 * Everything here is pure: the script that runs on the machine, and the parsing
 * of what it printed. The machine is the agent's, so its output is untrusted -
 * it is bounded on the machine before it is sent, framed by a nonce the machine
 * did not choose, and every record is read through a schema before it counts.
 * Credentials in those files (keys, headers, URLs) are never decoded.
 */

import { z } from "zod";
import * as core from "@polaris/core";

/** The most models one tool's list keeps. A tool listing more is cut, newest
 *  reads first, so a picker stays bounded whatever a cache holds. */
export const MAX_NATIVE_MODELS = 1000;

/** The most a model command may print before it is cut on the machine. */
const COMMAND_BYTES = 192 * 1024;

/** The largest cache file read. A bigger one is skipped whole rather than cut:
 *  half a JSON document parses as nothing anyway. */
const CACHE_BYTES = 4 * 1024 * 1024;

/** How long one model command may run on the machine, in seconds. */
const COMMAND_SECONDS = 20;

/** How long `codex app-server` is given to answer before its input closes. */
const CODEX_ANSWER_SECONDS = 10;

/** One model as a tool reported it. `id` is what the tool takes back. */
export interface NativeModel {
    readonly id: string;
    readonly name: string;
    /** The provider the tool files it under; empty when it did not say. */
    readonly provider: string;
}

export const nativeModelSchema = z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200),
    provider: z.string().max(100)
});

/** A stored list, read back. Anything malformed reads as nothing. */
export function readStoredModels(raw: string | null | undefined): NativeModel[] {
    try {
        const parsed = z.array(nativeModelSchema).safeParse(JSON.parse(raw ?? "[]"));
        return parsed.success ? parsed.data.slice(0, MAX_NATIVE_MODELS) : [];
    } catch {
        return [];
    }
}

/** What each tool is asked. The binaries come from the catalogue. */
type Source =
    | { kind: "command"; section: string; args: readonly string[]; parse: Parser }
    | { kind: "cache"; section: string; path: string; parse: Parser }
    | { kind: "db"; section: string; path: string }
    | { kind: "codex"; section: string };

type Parser = (text: string) => NativeModel[];

const XDG_CACHE = '"${XDG_CACHE_HOME:-$HOME/.cache}"';
/** Pi's agent directory (and Oh My Pi's): the variable Pi documents, else its home. */
const piDir = (cli: "pi" | "omp") => `"\${PI_CODING_AGENT_DIR:-$HOME/.${cli}/agent}"`;
/** Kimchi runs its embedded Pi from its own harness directory, whatever
 *  PI_CODING_AGENT_DIR says. */
const KIMCHI_DIR = '"$HOME/.config/kimchi/harness"';

const SOURCES: Readonly<Record<string, readonly Source[]>> = {
    opencode: [
        { kind: "command", section: "list", args: ["models"], parse: parseProviderIdLines },
        { kind: "cache", section: "cache", path: `${XDG_CACHE}/opencode/models.json`, parse: parseProviderSnapshot }
    ],
    kilocode: [
        { kind: "command", section: "list", args: ["models"], parse: parseProviderIdLines },
        { kind: "cache", section: "cache", path: `${XDG_CACHE}/kilo/models.json`, parse: parseProviderSnapshot }
    ],
    "mimo-code": [
        { kind: "command", section: "list", args: ["models"], parse: parseMimoModels },
        { kind: "cache", section: "cache", path: `${XDG_CACHE}/mimocode/models.json`, parse: parseProviderSnapshot }
    ],
    pi: [
        { kind: "command", section: "list", args: ["--list-models"], parse: parsePiModels },
        { kind: "cache", section: "store", path: `${piDir("pi")}/models-store.json`, parse: parseProviderSnapshot },
        { kind: "cache", section: "custom", path: `${piDir("pi")}/models.json`, parse: parseDeclaredProviders }
    ],
    kimchi: [
        { kind: "command", section: "list", args: ["--list-models"], parse: parsePiModels },
        { kind: "cache", section: "store", path: `${KIMCHI_DIR}/models-store.json`, parse: parseProviderSnapshot },
        { kind: "cache", section: "custom", path: `${KIMCHI_DIR}/models.json`, parse: parseDeclaredProviders }
    ],
    omp: [
        { kind: "command", section: "list", args: ["models", "--json"], parse: parseJsonModels },
        { kind: "db", section: "db", path: `${piDir("omp")}/models.db` }
    ],
    codex: [{ kind: "codex", section: "list" }]
};

/** The tools whose own model list Polaris can read. */
export const NATIVE_MODEL_CLIS: readonly string[] = Object.keys(SOURCES);

export function readsNativeModels(cli: string): boolean {
    return Object.hasOwn(SOURCES, cli);
}

/** A nonce for one read: hex only, so it is safe inside the script and cannot
 *  be produced by accident in a tool's output. */
export function modelsNonce(): string {
    return crypto.randomUUID().replace(/-/g, "");
}

const NONCE = /^[0-9a-f]{16,64}$/;

/** The JSON-RPC lines that ask `codex app-server` for its models: the handshake
 *  it requires, then one bounded page of `model/list`. */
const CODEX_REQUESTS = [
    JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
            clientInfo: { name: "polaris", title: "Polaris", version: "1" },
            capabilities: { experimentalApi: true }
        }
    }),
    JSON.stringify({ method: "initialized" }),
    JSON.stringify({ id: 2, method: "model/list", params: { limit: 200 } })
];

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The script that reads one tool's models on the machine and prints them as
 * nonce-framed sections, each bounded. Null for a tool with no reader, or a
 * nonce that is not one of ours.
 *
 * POSIX sh only: the machine may be a slim container or somebody's server.
 * `timeout` and `sqlite3` are used when present and their sources skipped when
 * not. Nothing is written to the machine and nothing goes into the environment.
 */
export function nativeModelsScript(cli: string, nonce: string): string | null {
    const sources = SOURCES[cli];
    const binaries = core.agentCliById(cli)?.binaries ?? [];
    if (!sources || binaries.length === 0 || !NONCE.test(nonce)) return null;
    const mark = (section: string) => `printf '\\n@@${nonce} ${section}@@\\n'`;
    const lines = [
        `B=""; for c in ${binaries.map(quote).join(" ")}; do if command -v "$c" >/dev/null 2>&1; then B="$c"; break; fi; done`,
        `T=""; if command -v timeout >/dev/null 2>&1; then T="timeout ${COMMAND_SECONDS}"; fi`,
        // Small enough to read, else nothing: half a file is not a catalogue.
        `fits() { [ -f "$1" ] && [ "$(wc -c < "$1" 2>/dev/null || echo ${CACHE_BYTES + 1})" -le ${CACHE_BYTES} ]; }`
    ];
    for (const source of sources) {
        lines.push(mark(source.section));
        if (source.kind === "command") {
            lines.push(
                `if [ -n "$B" ]; then $T "$B" ${source.args.map(quote).join(" ")} 2>/dev/null </dev/null | head -c ${COMMAND_BYTES}; fi`
            );
        } else if (source.kind === "cache") {
            lines.push(`F=${source.path}; if fits "$F"; then head -c ${CACHE_BYTES} "$F"; fi`);
        } else if (source.kind === "db") {
            lines.push(
                `F=${source.path}; if [ -f "$F" ] && command -v sqlite3 >/dev/null 2>&1; then $T sqlite3 -readonly "$F" 'SELECT models FROM model_cache WHERE length(models) <= ${CACHE_BYTES}' 2>/dev/null | head -c ${CACHE_BYTES}; fi`
            );
        } else {
            lines.push(
                `if [ -n "$B" ]; then { printf '%s\\n' ${CODEX_REQUESTS.map(quote).join(" ")}; sleep ${CODEX_ANSWER_SECONDS}; } | $T "$B" app-server 2>/dev/null | head -c ${COMMAND_BYTES}; fi`
            );
        }
    }
    lines.push(mark("end"));
    return lines.join("\n");
}

/** The machine's answer, cut back into its sections. A section that never
 *  arrived (the output was cut, or the tool hung) is simply absent. */
export function splitSections(output: string, nonce: string): Map<string, string> {
    const sections = new Map<string, string>();
    if (!NONCE.test(nonce)) return sections;
    const marker = new RegExp(`\\n@@${nonce} ([a-z]+)@@\\n`, "g");
    const found = [...output.matchAll(marker)];
    found.forEach((match, index) => {
        const name = match[1]!;
        if (name === "end") return;
        const start = match.index! + match[0].length;
        const end = found[index + 1]?.index ?? output.length;
        sections.set(name, output.slice(start, end));
    });
    return sections;
}

/**
 * Every model the tool reported, from what the script printed. The tool's own
 * command first - it is what the tool runs now - then its caches. Empty when
 * nothing parsed, which the caller treats as a failed read, never as "the tool
 * has no models".
 */
export function parseNativeModels(cli: string, output: string, nonce: string): NativeModel[] {
    const sources = SOURCES[cli];
    if (!sources) return [];
    const sections = splitSections(output, nonce);
    const models: NativeModel[] = [];
    for (const source of sources) {
        const text = sections.get(source.section);
        if (!text?.trim()) continue;
        if (source.kind === "command" || source.kind === "cache") models.push(...source.parse(text));
        else if (source.kind === "db") models.push(...parseModelCacheRows(text));
        else models.push(...parseCodexModelList(text));
    }
    return normalize(models).slice(0, MAX_NATIVE_MODELS);
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MODEL_ID = /^[A-Za-z0-9./:_@+-]+$/;

/** A string that could be a model id: model-id characters, not a header word. */
function looksLikeModelId(raw: string): boolean {
    const value = raw.replace(/^[`"'[\](),:]+|[`"'[\](),:]+$/g, "");
    if (!value || !MODEL_ID.test(value)) return false;
    return !["model", "models", "provider"].includes(value.toLowerCase());
}

/** `provider/model` split for its label and provider, or null without both. */
function splitProviderId(id: string): NativeModel | null {
    const at = id.indexOf("/");
    if (at <= 0 || at === id.length - 1) return null;
    return { id, name: id.slice(at + 1), provider: id.slice(0, at) };
}

/** One model id per line (`opencode models`, `kilo models`). */
export function parseProviderIdLines(text: string): NativeModel[] {
    const models: NativeModel[] = [];
    for (const raw of text.replace(ANSI, "").split("\n")) {
        const line = raw.replace(/^[\s•*\-✓>│├└]+/u, "").trim();
        const fields = line.split(/\s+/);
        if (!line || fields.length !== 1 || !looksLikeModelId(fields[0]!)) continue;
        const id = fields[0]!.replace(/^[`"'[\](),:]+|[`"'[\](),:]+$/g, "");
        models.push(splitProviderId(id) ?? { id, name: id, provider: "" });
    }
    return models;
}

/** `mimo models`: `provider/model — details`. */
export function parseMimoModels(text: string): NativeModel[] {
    const models: NativeModel[] = [];
    for (const raw of text.replace(ANSI, "").split("\n")) {
        const at = raw.indexOf(" — ");
        if (at < 0) continue;
        const id = raw.slice(0, at).trim();
        const model = looksLikeModelId(id) ? splitProviderId(id) : null;
        if (model) models.push(model);
    }
    return models;
}

/** `pi --list-models` / `kimchi --list-models`: a `provider model ...` table. */
export function parsePiModels(text: string): NativeModel[] {
    const models: NativeModel[] = [];
    for (const raw of text.replace(ANSI, "").split("\n")) {
        const fields = raw.trim().split(/\s+/);
        if (fields.length < 2) continue;
        const [provider, model] = fields as [string, string];
        if (provider.toLowerCase() === "provider") continue;
        // Kimchi prefixes notices with a bracketed tag; they are not rows.
        if (provider.startsWith("[") || !looksLikeModelId(provider) || !looksLikeModelId(model)) continue;
        models.push({ id: `${provider}/${model}`, name: model, provider });
    }
    return models;
}

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function firstString(node: Node, ...keys: string[]): string {
    for (const key of keys) {
        const value = node[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** How deep a reported JSON document is walked. Deeper is not a model list. */
const MAX_DEPTH = 8;

/** A tool's `--json` model list, whatever it nests (`omp models --json`). */
export function parseJsonModels(text: string): NativeModel[] {
    const models: NativeModel[] = [];
    const walk = (value: unknown, inherited: string, depth: number) => {
        if (depth > MAX_DEPTH || models.length > MAX_NATIVE_MODELS * 4) return;
        if (Array.isArray(value)) {
            for (const item of value) walk(item, inherited, depth + 1);
            return;
        }
        if (!isNode(value)) return;
        const container = "models" in value;
        let provider = firstString(value, "provider", "providerId", "provider_id") || inherited;
        if (container && !provider) provider = firstString(value, "id");
        const id =
            firstString(value, "selector", "modelId", "model_id", "model_uid", "slug", "model") ||
            (container ? "" : firstString(value, "id"));
        if (id) {
            const name = firstString(value, "displayName", "display_name", "model_name", "label", "name") || id;
            models.push({ id, name, provider });
        }
        for (const [key, child] of Object.entries(value)) {
            if (key === "models" && isNode(child)) {
                for (const [alias, item] of Object.entries(child)) {
                    if (isNode(item) && alias.trim() && !("models" in item) && firstString(item, "modelId", "model_id", "model_uid", "slug", "model", "provider", "providerId", "provider_id")) {
                        const name = firstString(item, "displayName", "display_name", "model_name", "label", "name") || alias;
                        models.push({
                            id: alias.trim(),
                            name,
                            provider: firstString(item, "provider", "providerId", "provider_id") || provider
                        });
                        continue;
                    }
                    walk(item, provider, depth + 1);
                }
                continue;
            }
            walk(child, provider, depth + 1);
        }
    };
    walk(parseJson(text), "", 0);
    return models;
}

/** One provider's model records, an array or keyed by id. Only the id, name
 *  and provider are read: the rest of a record (keys, headers, URLs) stays put. */
function providerRecords(raw: unknown, provider: string): NativeModel[] {
    const records: Node[] = Array.isArray(raw)
        ? raw.filter(isNode)
        : isNode(raw)
          ? Object.entries(raw).flatMap(([id, record]) =>
                isNode(record) ? [{ ...record, id: firstString(record, "id") || id }] : []
            )
          : [];
    const models: NativeModel[] = [];
    for (const record of records) {
        const id = firstString(record, "id");
        const owner = provider || firstString(record, "provider");
        if (!id || !owner) continue;
        // These catalogues store unqualified ids, including org/model.
        models.push({ id: `${owner}/${id}`, name: firstString(record, "name", "label") || id, provider: owner });
    }
    return models;
}

/** A models.dev-shaped snapshot keyed by provider (OpenCode's cache, Pi's store). */
export function parseProviderSnapshot(text: string): NativeModel[] {
    return snapshotModels(parseJson(text));
}

function snapshotModels(root: unknown): NativeModel[] {
    if (!isNode(root)) return [];
    return Object.entries(root).flatMap(([provider, entry]) =>
        provider.trim() && isNode(entry) ? providerRecords(entry.models, provider.trim()) : []
    );
}

/** Pi's own `models.json`: the providers the person declared, under `providers`. */
export function parseDeclaredProviders(text: string): NativeModel[] {
    const root = parseJson(text);
    return isNode(root) ? snapshotModels(root.providers) : [];
}

/** Oh My Pi's `model_cache.models`, one JSON array per line. The cache key can
 *  carry an account suffix, so the provider is the record's, never the key. */
export function parseModelCacheRows(text: string): NativeModel[] {
    return text.split("\n").flatMap((line) => (line.trim() ? providerRecords(parseJson(line), "") : []));
}

const codexListSchema = z.object({
    id: z.literal(2),
    result: z.object({
        data: z.array(
            z.object({
                id: z.string().optional(),
                model: z.string().optional(),
                displayName: z.string().optional(),
                hidden: z.boolean().optional(),
                isDefault: z.boolean().optional()
            })
        )
    })
});

/** `codex app-server`'s answer to `model/list`, among the other lines it writes.
 *  A model marked hidden is one the account should not be offered. */
export function parseCodexModelList(text: string): NativeModel[] {
    for (const line of text.split("\n")) {
        const parsed = codexListSchema.safeParse(parseJson(line.trim()));
        if (!parsed.success) continue;
        const models: NativeModel[] = [];
        const ordered = [...parsed.data.result.data].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
        for (const entry of ordered) {
            const id = (entry.id || entry.model || "").trim();
            if (!id || entry.hidden) continue;
            const at = id.indexOf("/");
            models.push({ id, name: entry.displayName?.trim() || id, provider: at > 0 ? id.slice(0, at) : "" });
        }
        return models;
    }
    return [];
}

/** One row per id, the first report kept and filled in by later ones; anything
 *  that is not a usable model id is dropped. Order is kept: the tool's own
 *  command reported first, and that is the order it offers them in. */
export function normalize(models: readonly NativeModel[]): NativeModel[] {
    const byId = new Map<string, NativeModel>();
    for (const model of models) {
        const id = model.id.trim();
        if (!core.SAFE_MODEL_ID.test(id)) continue;
        const name = (model.name.trim() || id).slice(0, 200);
        const provider = model.provider.trim().slice(0, 100);
        const previous = byId.get(id);
        if (!previous) {
            byId.set(id, { id, name, provider });
            continue;
        }
        // A bare id (or its part after the provider) is no name: a later
        // report's real one replaces it.
        const bare = previous.name === id || `${previous.provider}/${previous.name}` === id;
        byId.set(id, {
            id,
            name: bare && name !== id && name !== previous.name ? name : previous.name,
            provider: previous.provider || provider
        });
    }
    return [...byId.values()];
}

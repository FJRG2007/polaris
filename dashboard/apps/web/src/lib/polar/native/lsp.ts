/**
 * Diagnostics for a file the native agent just wrote, from a language server
 * the checkout already has.
 *
 * Ported from OpenCode (sst/opencode v1.0.0 `packages/opencode/src/lsp/`):
 * one server per language and project root, started on the first file it
 * handles and kept for the session; the file is opened (then changed) in it,
 * the agent waits up to `DIAGNOSTICS_WAIT_MS` for its `publishDiagnostics`,
 * and only errors are handed back, in OpenCode's `ERROR [line:col] message`
 * form. A server is used only when its binary is already there - in the
 * checkout's `node_modules` or on the PATH; nothing is installed. A server
 * that fails to start or answer is remembered as unavailable and skipped
 * silently for the rest of the session.
 *
 * The JSON-RPC framing is the base protocol of the Language Server Protocol
 * 3.17 (`Content-Length` header, `\r\n\r\n`, UTF-8 JSON body). Server-free.
 */

import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findUp, packageBin, type Lookup } from "@/lib/polar/native/format";
import type { PipedProcess, Workspace } from "@/lib/polar/native/workspace";

export const LSP_INIT_TIMEOUT_MS = 15_000;
/** OpenCode's wait for a file's diagnostics. */
export const DIAGNOSTICS_WAIT_MS = 3_000;
/** How long after a publish to wait for a later one (a server that sends the
 *  syntax pass first and the type pass after). */
const DIAGNOSTICS_SETTLE_MS = 300;
export const DIAGNOSTICS_MAX_SHOWN = 20;
const MAX_CLIENTS = 4;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface Diagnostic {
    readonly range: { readonly start: { readonly line: number; readonly character: number } };
    readonly severity?: number;
    readonly message: string;
}

export interface ServerLaunch {
    readonly argv: string[];
    /** The project root the server is started for. */
    readonly root: string;
}

export interface LanguageServer {
    readonly id: string;
    readonly extensions: readonly string[];
    detect(lookup: Lookup): Promise<ServerLaunch | null>;
}

const LANGUAGE_IDS: Record<string, string> = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
    ".go": "go",
    ".rs": "rust",
    ".py": "python",
    ".pyi": "python"
};

/** The folder of the nearest marker, or the checkout's root. */
async function rootOf(lookup: Lookup, markers: readonly string[]): Promise<string | null> {
    for (const marker of markers) {
        const [found] = await findUp(lookup, marker);
        if (found) return path.dirname(found);
    }
    return null;
}

function pathServer(id: string, extensions: readonly string[], markers: readonly string[], argv: readonly string[]): LanguageServer {
    return {
        id,
        extensions,
        async detect(lookup) {
            const root = await rootOf(lookup, markers);
            if (!root) return null;
            return (await lookup.ws.has(argv[0] as string)) ? { argv: [...argv], root } : null;
        }
    };
}

export const LANGUAGE_SERVERS: readonly LanguageServer[] = [
    {
        id: "typescript",
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        async detect(lookup) {
            const root = await rootOf(lookup, ["tsconfig.json", "jsconfig.json", "package.json"]);
            if (!root) return null;
            // The server needs the project's own TypeScript to answer anything.
            if (!(await packageBin(lookup, "typescript", "tsc"))) return null;
            const bin = await packageBin(lookup, "typescript-language-server");
            if (bin) return { argv: [process.execPath, bin, "--stdio"], root };
            return (await lookup.ws.has("typescript-language-server")) ? { argv: ["typescript-language-server", "--stdio"], root } : null;
        }
    },
    pathServer("gopls", [".go"], ["go.mod"], ["gopls"]),
    pathServer("rust-analyzer", [".rs"], ["Cargo.toml"], ["rust-analyzer"]),
    pathServer("pyright", [".py", ".pyi"], ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"], ["pyright-langserver", "--stdio"])
];

/** A file path as both sides compare it. */
function keyOf(file: string): string {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function uriKey(uri: string): string | null {
    try {
        return keyOf(fileURLToPath(uri));
    } catch {
        return null;
    }
}

/** Splits a byte stream into the JSON bodies of base-protocol frames. */
export class FrameReader {
    private buffer = Buffer.alloc(0);

    constructor(private readonly onMessage: (message: unknown) => void) {}

    push(chunk: Buffer): void {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const end = this.buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const header = this.buffer.subarray(0, end).toString("ascii");
            const match = /content-length:\s*(\d+)/i.exec(header);
            const length = match ? Number(match[1]) : -1;
            if (length < 0 || length > MAX_FRAME_BYTES) {
                // Unreadable: drop what is buffered rather than misparse the rest.
                this.buffer = Buffer.alloc(0);
                return;
            }
            const start = end + 4;
            if (this.buffer.length < start + length) return;
            const body = this.buffer.subarray(start, start + length).toString("utf8");
            this.buffer = this.buffer.subarray(start + length);
            try {
                this.onMessage(JSON.parse(body));
            } catch {
                // A body that is not JSON is skipped.
            }
        }
    }
}

export function frame(message: unknown): string {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** One running language server. */
export class LspClient {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly versions = new Map<string, number>();
    private readonly diagnostics = new Map<string, Diagnostic[]>();
    private readonly listeners = new Set<(key: string) => void>();
    private dead = false;

    constructor(private readonly proc: PipedProcess, readonly id: string) {
        const reader = new FrameReader((message) => this.receive(message));
        proc.onData((chunk) => reader.push(chunk));
        proc.onExit(() => {
            this.dead = true;
            for (const waiter of this.pending.values()) waiter.reject(new Error(`${id} exited`));
            this.pending.clear();
        });
    }

    get alive(): boolean {
        return !this.dead;
    }

    private send(message: Record<string, unknown>): void {
        this.proc.write(frame({ jsonrpc: "2.0", ...message }));
    }

    private receive(message: unknown): void {
        if (!message || typeof message !== "object") return;
        const record = message as Record<string, unknown>;
        const method = typeof record.method === "string" ? record.method : null;
        if (method && "id" in record) {
            // A request from the server: answer what a client is asked at start-up.
            const result = method === "workspace/configuration" ? this.configurationAnswer(record.params) : null;
            this.send({ id: record.id, result });
            return;
        }
        if (method === "textDocument/publishDiagnostics") {
            const params = record.params as { uri?: unknown; diagnostics?: unknown } | undefined;
            const key = typeof params?.uri === "string" ? uriKey(params.uri) : null;
            if (!key || !Array.isArray(params?.diagnostics)) return;
            this.diagnostics.set(key, params.diagnostics as Diagnostic[]);
            for (const listener of this.listeners) listener(key);
            return;
        }
        if (typeof record.id === "number") {
            const waiter = this.pending.get(record.id);
            if (!waiter) return;
            this.pending.delete(record.id);
            if (record.error) waiter.reject(new Error(String((record.error as { message?: unknown }).message ?? "error")));
            else waiter.resolve(record.result);
        }
    }

    private configurationAnswer(params: unknown): unknown[] {
        const items = (params as { items?: unknown } | undefined)?.items;
        return Array.isArray(items) ? items.map(() => ({})) : [];
    }

    request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        if (this.dead) return Promise.reject(new Error(`${this.id} is not running`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${this.id} did not answer ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            });
            this.send({ id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        if (!this.dead) this.send({ method, params });
    }

    async initialize(root: string): Promise<void> {
        const uri = pathToFileURL(root).href;
        await this.request(
            "initialize",
            {
                processId: process.pid,
                rootUri: uri,
                workspaceFolders: [{ name: path.basename(root) || root, uri }],
                capabilities: {
                    window: { workDoneProgress: true },
                    workspace: { configuration: true },
                    textDocument: {
                        synchronization: { didOpen: true, didChange: true },
                        publishDiagnostics: { versionSupport: true }
                    }
                }
            },
            LSP_INIT_TIMEOUT_MS
        );
        this.notify("initialized", {});
    }

    /** Opens or updates `file` with `text` and waits for its diagnostics. */
    async check(file: string, text: string, signal?: AbortSignal, waitMs: number = DIAGNOSTICS_WAIT_MS): Promise<Diagnostic[]> {
        const key = keyOf(file);
        const uri = pathToFileURL(file).href;
        const published = new Promise<void>((resolve) => {
            let settle: ReturnType<typeof setTimeout> | null = null;
            const done = () => {
                clearTimeout(limit);
                if (settle) clearTimeout(settle);
                this.listeners.delete(listener);
                signal?.removeEventListener("abort", done);
                resolve();
            };
            const listener = (published: string) => {
                if (published !== key) return;
                if (settle) clearTimeout(settle);
                settle = setTimeout(done, DIAGNOSTICS_SETTLE_MS);
            };
            const limit = setTimeout(done, waitMs);
            this.listeners.add(listener);
            signal?.addEventListener("abort", done, { once: true });
        });
        const version = this.versions.get(key);
        if (version === undefined) {
            this.versions.set(key, 0);
            this.notify("textDocument/didOpen", {
                textDocument: { uri, languageId: LANGUAGE_IDS[path.extname(file)] ?? "plaintext", version: 0, text }
            });
        } else {
            this.versions.set(key, version + 1);
            this.notify("textDocument/didChange", { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
        }
        await published;
        return this.diagnostics.get(key) ?? [];
    }

    shutdown(): void {
        this.dead = true;
        this.proc.kill();
    }
}

const SEVERITY: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" };

/** OpenCode's one-line form of a diagnostic. */
export function prettyDiagnostic(diagnostic: Diagnostic): string {
    const severity = SEVERITY[diagnostic.severity ?? 1] ?? "ERROR";
    return `${severity} [${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}] ${diagnostic.message}`;
}

/** The errors in `diagnostics`, as the tool result hands them to the model;
 *  empty when there are none. */
export function diagnosticsBlock(diagnostics: readonly Diagnostic[]): string {
    const errors = diagnostics.filter((item) => (item.severity ?? 1) === 1 && typeof item.message === "string");
    if (errors.length === 0) return "";
    const shown = errors.slice(0, DIAGNOSTICS_MAX_SHOWN).map(prettyDiagnostic);
    if (errors.length > shown.length) shown.push(`... and ${errors.length - shown.length} more`);
    return ["This file has errors, please fix", "<file_diagnostics>", ...shown, "</file_diagnostics>"].join("\n");
}

const live = new Set<LspClient>();
let exitHooked = false;

function track(client: LspClient): void {
    live.add(client);
    if (exitHooked) return;
    exitHooked = true;
    process.once("exit", () => {
        for (const each of live) each.shutdown();
    });
}

/** A session's language servers, started on demand and kept. */
export class LspPool {
    private readonly clients = new Map<string, Promise<LspClient | null>>();
    private readonly detected = new Map<string, ServerLaunch | null>();

    constructor(
        private readonly ws: Workspace,
        private readonly log: (line: string) => void,
        private readonly servers: readonly LanguageServer[] = LANGUAGE_SERVERS
    ) {}

    private async clientFor(server: LanguageServer, launch: ServerLaunch): Promise<LspClient | null> {
        const key = `${server.id}\u0000${launch.root}`;
        const existing = this.clients.get(key);
        if (existing) {
            const client = await existing;
            if (client?.alive) return client;
            return null;
        }
        if (this.clients.size >= MAX_CLIENTS || !this.ws.spawnPiped) return null;
        const started = (async () => {
            const proc = this.ws.spawnPiped!(launch.argv, { cwd: launch.root });
            const client = new LspClient(proc, server.id);
            track(client);
            try {
                await client.initialize(launch.root);
                return client;
            } catch (error) {
                this.log(`${server.id} language server unavailable: ${(error as Error).message}`);
                client.shutdown();
                live.delete(client);
                return null;
            }
        })();
        this.clients.set(key, started);
        return started;
    }

    /** The diagnostics block for `file` after it was written, or "". Never throws. */
    async diagnose(file: string, signal?: AbortSignal): Promise<string> {
        try {
            const extension = path.extname(file);
            const lookup: Lookup = { ws: this.ws, dir: path.dirname(file) };
            for (const server of this.servers) {
                if (!server.extensions.includes(extension)) continue;
                const detectKey = `${server.id}\u0000${lookup.dir}`;
                let launch = this.detected.get(detectKey);
                if (launch === undefined) {
                    launch = await server.detect(lookup).catch(() => null);
                    this.detected.set(detectKey, launch);
                }
                if (!launch) continue;
                const client = await this.clientFor(server, launch);
                if (!client) continue;
                const text = (await this.ws.readFile(file)).toString("utf8");
                return diagnosticsBlock(await client.check(file, text, signal));
            }
        } catch (error) {
            this.log(`diagnostics skipped for ${file}: ${(error as Error).message}`);
        }
        return "";
    }

    shutdown(): void {
        for (const pending of this.clients.values()) {
            void pending.then((client) => {
                if (!client) return;
                client.shutdown();
                live.delete(client);
            });
        }
        this.clients.clear();
    }
}

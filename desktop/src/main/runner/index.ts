/**
 * This computer as a runner for Polar Code: the Electron half that pairs,
 * keeps the credential, and wires the connection, the sessions and the chat
 * turns to the real terminal, git, toolchain and network.
 *
 * Paired per Polaris: the credential (`runnerId`, `token`) is kept encrypted
 * with `safeStorage` in `<userData>/runner.bin`, by server origin, and the
 * runner connects to whichever Polaris the app is on. Work lives under
 * `<userData>/runner`; the managed tools under `<userData>/toolchain`.
 */

import { z } from "zod";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { findOnPath } from "./launch";
import { pathToFileURL } from "node:url";
import * as pins from "@toolchain/index";
import * as toolchain from "../toolchain";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { hostname, release } from "node:os";
import { app, safeStorage } from "electron";
import { version } from "../../../package.json";
import { ChatHost, type ClaudeSdk } from "./chat";
import { Folders } from "./folders";
import { createReadStream } from "node:fs";
import * as workspace from "./workspace";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { RunnerConnection, type RunnerSocket, type RunnerState, type ServerFrame } from "./connection";
import { SessionHost, type SpawnTerminal, type Terminal, type ToolchainProgressFrame } from "./sessions";

export type { RunnerState } from "./connection";

/** What the screen shows about this computer. */
export interface ComputerState {
    readonly paired: boolean;
    readonly state: RunnerState;
    /** The tool being prepared now, or the failure that stopped it. */
    readonly preparing: ToolchainProgressFrame | null;
}

export type PairOutcome = { ok: true; } | { ok: false; reason: "code" | "offline" | "storage" | "limited"; };

const credentialSchema = z.object({ runnerId: z.string().uuid(), token: z.string().min(1).max(400) });
const storedSchema = z.record(z.string(), credentialSchema);
const pairAnswerSchema = z.object({ runnerId: z.string().uuid(), token: z.string().min(1).max(400), protocol: z.number().int() });
type Credential = z.infer<typeof credentialSchema>;

/** Sessions this computer holds at once. */
const MAX_SESSIONS = 8;

function credentialFile(): string {
    return join(app.getPath("userData"), "runner.bin");
}

function canKeep(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

async function loadCredentials(): Promise<Record<string, Credential>> {
    if (!canKeep()) return {};
    try {
        const parsed = storedSchema.safeParse(JSON.parse(safeStorage.decryptString(await readFile(credentialFile()))));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

async function saveCredentials(all: Record<string, Credential>): Promise<void> {
    await writeFile(credentialFile(), safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 });
}

/** The folders a `path` session may use, encrypted like the credential. */
const folders = new Folders({
    read: async () => (canKeep() ? safeStorage.decryptString(await readFile(join(app.getPath("userData"), "runner-folders.bin"))) : null),
    write: async (json) => {
        if (!canKeep()) throw new Error("storage");
        await writeFile(join(app.getPath("userData"), "runner-folders.bin"), safeStorage.encryptString(json), { mode: 0o600 });
    }
});

/** The pseudo-terminal library, loaded once and only when a session starts,
 *  so an app whose package lacks it still runs everything else. */
let pty: { spawn: (file: string, args: string[], options: Record<string, unknown>) => Terminal & { onData: (l: (d: string) => void) => unknown; }; } | null | undefined;

function loadPty(): typeof pty {
    if (pty !== undefined) return pty;
    try {
        pty = createRequire(__filename)("node-pty") as typeof pty;
    } catch {
        pty = null;
    }
    return pty;
}

/** A terminal: a pseudo-terminal when the library loads, otherwise the
 *  program on plain pipes, which still runs a non-TUI agent. */
const spawnTerminal: SpawnTerminal = (file, args, options) => {
    const library = loadPty();
    if (library) {
        const term = library.spawn(file, args, { name: "xterm-256color", cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, useConpty: true });
        return {
            onData: (listener) => void term.onData(listener),
            onExit: (listener) => void term.onExit(listener),
            write: (data) => term.write(data),
            resize: (cols, rows) => term.resize(cols, rows),
            kill: () => term.kill()
        };
    }
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return {
        onData: (listener) => {
            child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
            child.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
        },
        onExit: (listener) => {
            child.once("error", () => listener({ exitCode: 127 }));
            child.once("exit", (code) => listener({ exitCode: code ?? 1 }));
        },
        write: (data) => void child.stdin.write(data),
        resize: () => undefined,
        kill: () => void child.kill()
    };
};

function git(args: string[], options: { cwd: string; env: Record<string, string>; }): Promise<number> {
    return new Promise((resolve) => {
        const command = findOnPath("git", options.env, process.platform, existsSync) ?? "git";
        const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: "ignore" });
        child.once("error", () => resolve(127));
        child.once("exit", (code) => resolve(code ?? 1));
    });
}

/** How long one git read may run before it is stopped; under the server's
 *  wait, so an answer still arrives. */
const GIT_READ_TIMEOUT_MS = 12_000;

/** Git with an argument array and no shell, its stdout kept up to `maxBytes`
 *  and the rest counted, stopped past `GIT_READ_TIMEOUT_MS`. */
function gitRead(args: string[], options: workspace.GitReadOptions): Promise<workspace.GitOutput> {
    return new Promise((resolve) => {
        const command = findOnPath("git", options.env, process.platform, existsSync) ?? "git";
        const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        let kept = 0;
        let total = 0;
        const timer = setTimeout(() => child.kill(), GIT_READ_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (kept >= options.maxBytes) return;
            const piece = chunk.subarray(0, options.maxBytes - kept);
            chunks.push(piece);
            kept += piece.length;
        });
        const done = (code: number) => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(chunks), total });
        };
        child.once("error", () => done(127));
        child.once("close", (code) => done(code ?? 1));
    });
}

/** Newlines in a file, read as a stream; null when a NUL shows up in the
 *  first bytes, as git calls a file binary. */
function countLines(path: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
        let seen = 0;
        let lines = 0;
        const stream = createReadStream(path);
        stream.on("data", (chunk: Buffer | string) => {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            if (seen < workspace.BINARY_PROBE_BYTES && bytes.subarray(0, workspace.BINARY_PROBE_BYTES - seen).includes(0)) {
                stream.destroy();
                return resolve(null);
            }
            seen += bytes.length;
            for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1)) lines++;
        });
        stream.once("error", reject);
        stream.once("end", () => resolve(lines));
    });
}

const workspaceDeps: workspace.WorkspaceDeps = {
    gitRead,
    realpath: (path) => realpath(path),
    lstat: async (path) => {
        const stat = await lstat(path).catch(() => null);
        return stat ? { size: stat.size, file: stat.isFile() } : null;
    },
    readHead: async (path, maxBytes) => {
        const handle = await open(path, "r");
        try {
            const buffer = Buffer.alloc(maxBytes);
            const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    },
    countLines
};

class RunnerService {
    #server: string | null = null;
    #connection: RunnerConnection | null = null;
    #state: RunnerState = "stopped";
    #paired = false;
    /** This computer's id on the Polaris in use, once paired there. */
    #runnerId: string | null = null;
    #preparing: ToolchainProgressFrame | null = null;
    readonly #listeners = new Set<(state: ComputerState) => void>();
    readonly #root = () => join(app.getPath("userData"), "runner");
    readonly #toolRoot = () => join(app.getPath("userData"), "toolchain");
    readonly #sessions = new SessionHost({
        root: join(app.getPath("userData"), "runner"),
        platform: process.platform,
        allowedFolders: () => folders.list(this.#server),
        send: (frame) => this.#connection?.send(frame) ?? false,
        spawnTerminal,
        prepare: (agents, onProgress) => this.#prepare(agents, onProgress),
        git,
        exists: existsSync,
        mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
        writeFile: (file, text) => writeFile(file, text, "utf8"),
        maxSessions: MAX_SESSIONS,
        log: (message) => console.warn(message)
    });
    readonly #chat = new ChatHost({
        send: (frame) => this.#connection?.send(frame) ?? false,
        prepare: () => this.#prepareChat(),
        cwd: join(app.getPath("userData"), "runner", "chat"),
        log: (message) => console.warn(message)
    });

    snapshot(): ComputerState {
        return {
            paired: this.#paired,
            state: this.#state,
            preparing: this.#preparing,
            ...(this.#paired && this.#runnerId ? { runnerId: this.#runnerId } : {})
        };
    }

    listen(listener: (state: ComputerState) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #changed(): void {
        const state = this.snapshot();
        for (const listener of this.#listeners) listener(state);
    }

    /** Connect for this Polaris (or none), replacing any other connection. */
    async use(server: string | null): Promise<void> {
        if (server === this.#server && this.#connection) return;
        this.#disconnect();
        this.#server = server;
        if (!server) return this.#changed();
        await folders.load();
        const credential = (await loadCredentials())[server];
        this.#paired = Boolean(credential);
        this.#runnerId = credential?.runnerId ?? null;
        if (credential && this.#server === server) this.#connect(server, credential);
        this.#changed();
    }

    #disconnect(): void {
        this.#sessions.stopAll();
        this.#chat.cancelAll();
        this.#connection?.stop();
        this.#connection = null;
        this.#state = "stopped";
    }

    #connect(server: string, credential: Credential): void {
        const connection = new RunnerConnection({
            server,
            token: credential.token,
            runnerVersion: version,
            openSocket: (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as RunnerSocket,
            capabilities: () => this.#capabilities(),
            sessions: () => this.#sessions.ids(),
            onCommand: (frame) => {
                if (this.#sessions.handle(frame) || this.#chat.handle(frame)) return;
                if (frame.type === "toolchain.prepare") void this.#prepareRequested(frame.requestId, frame.agents);
                if (frame.type === "workspace.read") void this.#readWorkspace(frame);
            },
            onState: (state) => {
                this.#state = state;
                if (state === "unpaired") void this.#forgetCredential(server);
                this.#changed();
            },
            log: (message) => console.warn(message)
        });
        this.#connection = connection;
        connection.start();
    }

    async pair(code: string): Promise<PairOutcome> {
        const server = this.#server;
        if (!server) return { ok: false, reason: "offline" };
        if (!canKeep()) return { ok: false, reason: "storage" };
        let res: Response;
        try {
            res = await fetch(new URL("/api/computers/pair", server), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: code.trim().slice(0, 20), name: hostname().slice(0, 60) || "Computer" }),
                signal: AbortSignal.timeout(15_000)
            });
        } catch {
            return { ok: false, reason: "offline" };
        }
        if (res.status === 429) return { ok: false, reason: "limited" };
        if (!res.ok) return { ok: false, reason: res.status === 400 ? "code" : "offline" };
        const answer = pairAnswerSchema.safeParse(await res.json().catch(() => null));
        if (!answer.success) return { ok: false, reason: "offline" };
        await saveCredentials({ ...(await loadCredentials()), [server]: { runnerId: answer.data.runnerId, token: answer.data.token } });
        this.#disconnect();
        this.#paired = true;
        this.#runnerId = answer.data.runnerId;
        this.#connect(server, answer.data);
        this.#changed();
        return { ok: true };
    }

    /** The folders chosen for the Polaris open here. */
    async folders(): Promise<readonly string[]> {
        await folders.load();
        return folders.list(this.#server);
    }

    /** Keep a folder the person chose in the native dialog. Null when there is
     *  no Polaris open or nowhere safe to keep it. */
    async addFolder(folder: string): Promise<readonly string[] | null> {
        if (!this.#server || !canKeep()) return null;
        return folders.add(this.#server, folder);
    }

    async removeFolder(folder: string): Promise<readonly string[] | null> {
        if (!this.#server || !canKeep()) return null;
        return folders.remove(this.#server, folder);
    }

    async forget(): Promise<void> {
        const server = this.#server;
        this.#disconnect();
        if (server) await this.#forgetCredential(server);
        this.#changed();
    }

    async #forgetCredential(server: string): Promise<void> {
        const all = await loadCredentials();
        delete all[server];
        await saveCredentials(all).catch(() => undefined);
        if (server === this.#server) {
            this.#paired = false;
            this.#runnerId = null;
        }
    }

    /** Prepare the base tools and Claude Code now, from the desktop's own
     *  Try again. */
    async prepareNow(): Promise<boolean> {
        const result = await this.#prepare(["claude"], () => undefined);
        return result.ok;
    }

    async #readWorkspace(frame: Extract<ServerFrame, { type: "workspace.read"; }>): Promise<void> {
        const answer = await workspace.readWorkspace(this.#sessions.checkout(frame.sessionId), frame.query, workspaceDeps).catch((error: unknown) => {
            console.warn(`runner: workspace read for ${frame.sessionId} failed: ${String(error)}`);
            return { kind: "nocheckout" } as const;
        });
        this.#connection?.send({ type: "workspace.answer", requestId: frame.requestId, sessionId: frame.sessionId, answer });
    }

    async #prepareRequested(requestId: string, agents: string[]): Promise<void> {
        await this.#prepare(agents, (progress) => this.#connection?.send({ type: "toolchain.progress", requestId, ...progress }));
    }

    async #prepare(agents: string[], onProgress: (progress: ToolchainProgressFrame) => void): Promise<{ ok: true; env: Record<string, string>; } | { ok: false; tool: string; code: string; }> {
        const { downloads } = toolchain.plan(process.platform, process.arch, agents);
        return toolchain.prepareToolchain(downloads, {
            root: this.#toolRoot(),
            platform: process.platform,
            fetch,
            run: toolchain.spawnRun,
            onProgress: (progress) => {
                const frame: ToolchainProgressFrame = { ...progress, tool: progress.tool };
                this.#preparing = progress.step === "ready" ? null : frame;
                this.#changed();
                onProgress(frame);
            }
        });
    }

    /** Claude Code and the Agent SDK beside it, and the SDK loaded. */
    async #prepareChat(): Promise<{ env: Record<string, string>; claudePath: string; sdk: ClaudeSdk; } | null> {
        const prepared = await this.#prepare(["claude"], () => undefined);
        if (!prepared.ok) return null;
        const platform = process.platform;
        const node = pins.resolveToolchainDownload("node", platform, process.arch);
        if (!node) return null;
        const sdk = sdkDownload();
        const installed = await toolchain.prepareToolchain([node, sdk], { root: this.#toolRoot(), platform, fetch, run: toolchain.spawnRun });
        if (!installed.ok) return null;
        const claudePath = findOnPath("claude", prepared.env, platform, existsSync);
        if (!claudePath) return null;
        await mkdir(join(this.#root(), "chat"), { recursive: true });
        const dir = pins.toolchainToolDir(this.#toolRoot(), platform, sdk);
        const packageDir = platform === "win32" ? join(dir, "node_modules", ...pins.TOOLCHAIN_CLAUDE_AGENT_SDK.name.split("/")) : join(dir, "lib", "node_modules", ...pins.TOOLCHAIN_CLAUDE_AGENT_SDK.name.split("/"));
        const manifest = z.object({ main: z.string().optional(), module: z.string().optional() }).safeParse(JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")));
        const entry = join(packageDir, (manifest.success ? (manifest.data.main ?? manifest.data.module) : undefined) ?? "sdk.mjs");
        const loaded = (await import(pathToFileURL(entry).href)) as ClaudeSdk;
        return { env: prepared.env, claudePath, sdk: loaded };
    }

    async #capabilities() {
        const platform = process.platform;
        const toolRoot = this.#toolRoot();
        const ready: { tool: string; version: string; }[] = [];
        for (const download of toolchain.plan(platform, process.arch, [...pins.TOOLCHAIN_AGENTS]).downloads) {
            const at = await toolchain.readyVersion(toolRoot, platform, download).catch(() => null);
            if (at) ready.push({ tool: download.tool, version: at.slice(0, 60) });
        }
        const agentSet = new Set<string>(pins.TOOLCHAIN_AGENTS);
        return {
            type: "capabilities" as const,
            os: { platform: platform as "win32" | "darwin" | "linux", release: release().slice(0, 80), arch: process.arch.slice(0, 20) },
            hostname: hostname().slice(0, 120),
            shells: [],
            clis: ready.filter((item) => agentSet.has(item.tool)).map((item) => ({ id: item.tool, version: item.version, signedIn: "unknown" as const })),
            maxSessions: MAX_SESSIONS,
            features: ["toolchain", "claude-chat", "workspace-read"],
            toolchain: ready
        };
    }
}

/** The Agent SDK as a toolchain download: an npm tarball installed by the
 *  managed npm, integrity-checked like the agent CLIs. */
export function sdkDownload(): pins.ToolchainDownload {
    const sdk = pins.TOOLCHAIN_CLAUDE_AGENT_SDK;
    return {
        // Not an agent of its own: a library kept beside Claude Code.
        tool: "claude-agent-sdk" as pins.ToolchainTool,
        version: sdk.version,
        url: pins.npmTarballUrl(sdk.name, sdk.version),
        archive: "npm",
        integrity: sdk.integrity,
        binDirs: [],
        command: ""
    };
}

let service: RunnerService | null = null;

/** The one runner, made on first use (after the app has its paths). */
export function runner(): RunnerService {
    service ??= new RunnerService();
    return service;
}

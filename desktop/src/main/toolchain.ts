/**
 * Preparing this computer for Polar Code: git, Node, gh, Enigma and the agent
 * CLIs a person picks, installed into the app's own data directory.
 *
 * Nothing here needs admin rights or touches the system: every tool lands in
 * `<userData>/toolchain/<tool>/<version>`, a local session runs with that
 * directory first on PATH (`toolchainEnv`), and a tool the machine already has
 * is simply shadowed. The versions and hashes are pinned in
 * `@toolchain/index` and ship with the app, so the app's own update is what
 * moves them: a new pin installs beside the old one on next use, and the old
 * directory is removed once the new one is in place.
 *
 * Every file is hashed while it downloads and compared with the pinned value
 * before anything is extracted; a mismatch deletes it and fails with
 * `checksum`. Failures carry a machine word (`ToolchainFailure`), never prose:
 * the dashboard says it in the reader's language and offers Try again, which
 * calls this again and skips whatever is already in place.
 *
 * Archives are opened with fflate (zip) and the operating system's own `tar`
 * (tar.gz, present on macOS, Linux and Windows 10+), started with an argument
 * array and no shell. No script is written and run, which is the pattern
 * antivirus heuristics flag on an unsigned app.
 */

import { join } from "node:path";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import * as pins from "@toolchain/index";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile, open } from "node:fs/promises";

export type ToolchainStep = "download" | "verify" | "install" | "ready" | "failed";
export type ToolchainFailure = "offline" | "checksum" | "disk" | "unsupported" | "blocked" | "install";

export interface ToolchainProgress {
    readonly tool: string;
    readonly step: ToolchainStep;
    readonly received?: number;
    readonly total?: number;
    readonly code?: ToolchainFailure;
}

export type PrepareResult =
    | { ok: true; env: Record<string, string>; }
    | { ok: false; tool: string; code: ToolchainFailure; };

export interface ToolchainDeps {
    /** `<userData>/toolchain`. */
    readonly root: string;
    readonly platform: string;
    readonly fetch: typeof fetch;
    /** Runs a program with an argument array; resolves with its exit code. */
    readonly run: (file: string, args: readonly string[], env: Record<string, string>, signal?: AbortSignal) => Promise<number>;
    readonly onProgress?: (progress: ToolchainProgress) => void;
    readonly signal?: AbortSignal;
}

/** Marker written last into a finished tool directory. A directory without it
 *  is a half-done install and is replaced. */
const READY = ".polaris-ready";
/** Fewest milliseconds between two download progress reports. */
const PROGRESS_EVERY_MS = 250;

class ToolchainError extends Error {
    constructor(readonly code: ToolchainFailure, message: string) {
        super(message);
    }
}

function failureOf(error: unknown): ToolchainFailure {
    if (error instanceof ToolchainError) return error.code;
    const code = (error as { code?: string; } | null)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") return "disk";
    // What a file held by an antivirus scan looks like from here.
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return "blocked";
    return "offline";
}

/** Whether a tool is installed at its pinned version. */
export function toolReady(root: string, platform: string, download: pins.ToolchainDownload): boolean {
    return existsSync(join(pins.toolchainToolDir(root, platform, download), READY));
}

async function download(item: pins.ToolchainDownload, file: string, deps: ToolchainDeps): Promise<void> {
    const report = (progress: Omit<ToolchainProgress, "tool">) => deps.onProgress?.({ tool: item.tool, ...progress });
    let res: Response;
    try {
        res = await deps.fetch(item.url, { redirect: "follow", signal: deps.signal });
    } catch {
        throw new ToolchainError("offline", `could not reach ${item.url}`);
    }
    if (!res.ok || !res.body) throw new ToolchainError("offline", `${item.url} answered ${res.status}`);
    const total = Number(res.headers.get("content-length")) || undefined;
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    const out = await open(file, "w");
    let received = 0;
    let last = 0;
    try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            sha256.update(chunk);
            sha512.update(chunk);
            await out.write(chunk);
            received += chunk.byteLength;
            const now = Date.now();
            if (now - last >= PROGRESS_EVERY_MS) {
                last = now;
                report({ step: "download", received, total });
            }
        }
    } finally {
        await out.close();
    }
    report({ step: "verify", received, total });
    const ok = item.archive === "npm" ? pins.integrityMatches(sha512.digest("base64"), item.integrity) : pins.sha256Matches(sha256.digest("hex"), item.sha256);
    if (!ok) {
        await rm(file, { force: true });
        throw new ToolchainError("checksum", `${item.url} did not match its pinned checksum`);
    }
}

/** Unzip into `dest`, refusing any entry that would land outside it. */
export async function extractZip(file: string, dest: string): Promise<void> {
    const entries = unzipSync(new Uint8Array(await readFile(file)));
    for (const [name, data] of Object.entries(entries)) {
        const parts = name.split(/[\\/]+/).filter(Boolean);
        if (parts.length === 0 || parts.includes("..") || /^[a-zA-Z]:/.test(name) || name.startsWith("/")) throw new ToolchainError("install", `unsafe entry ${name}`);
        const target = join(dest, ...parts);
        if (name.endsWith("/")) {
            await mkdir(target, { recursive: true });
            continue;
        }
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, data);
    }
}

/** The system `tar`, by absolute path so a `tar` earlier on PATH (MinGit's,
 *  say) is never the one that runs. */
export function systemTar(platform: string, env: NodeJS.ProcessEnv = process.env): string {
    if (platform === "win32") return join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    return existsSync("/usr/bin/tar") ? "/usr/bin/tar" : "/bin/tar";
}

/** A directory holding nothing but one directory is that directory: the shape
 *  of every release archive that wraps its files in `name-version/`. */
async function hoistSingleDirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0]!.isDirectory()) return;
    const inner = join(dir, entries[0]!.name);
    const moved = `${dir}.hoist-${randomBytes(4).toString("hex")}`;
    await rename(inner, moved);
    await rm(dir, { recursive: true, force: true });
    await rename(moved, dir);
}

/** Enigma's launchers, the ones its own installer writes, running the managed
 *  Node so every platform is served by the one package. */
async function writeEnigmaLaunchers(dir: string, node: string, platform: string): Promise<void> {
    await mkdir(join(dir, "bin"), { recursive: true });
    const entry = join(dir, "bin", "enigma.mjs");
    if (platform === "win32") {
        await writeFile(join(dir, "bin", "enigma.cmd"), `@echo off\r\n"${node}" "${entry}" %*\r\n`);
        return;
    }
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    await writeFile(join(dir, "bin", "enigma"), `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`);
    await chmod(join(dir, "bin", "enigma"), 0o755);
}

async function installOne(item: pins.ToolchainDownload, installed: pins.ToolchainDownload[], deps: ToolchainDeps): Promise<void> {
    const { root, platform } = deps;
    const finalDir = pins.toolchainToolDir(root, platform, item);
    const downloads = join(root, ".downloads");
    await mkdir(downloads, { recursive: true });
    const file = join(downloads, `${item.tool}-${item.version}-${randomBytes(4).toString("hex")}`);
    const staging = `${finalDir}.staging-${randomBytes(4).toString("hex")}`;
    try {
        await download(item, file, deps);
        deps.onProgress?.({ tool: item.tool, step: "install" });
        await mkdir(staging, { recursive: true });
        const node = installed.find((done) => done.tool === "node");
        if (item.archive === "npm") {
            if (!node) throw new ToolchainError("install", "Node is needed first");
            const nodeDir = pins.toolchainToolDir(root, platform, node);
            const npmCli = platform === "win32" ? join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js") : join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
            const env = pins.toolchainEnv(root, platform, installed, process.env);
            const args = [npmCli, "install", "--global", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", file];
            const code = await deps.run(join(nodeDir, node.command), args, env, deps.signal);
            if (code !== 0) throw new ToolchainError("install", `npm exited with ${code}`);
        } else {
            if (item.archive === "zip") await extractZip(file, staging);
            else {
                const code = await deps.run(systemTar(platform), ["-xzf", file, "-C", staging], { ...process.env } as Record<string, string>, deps.signal);
                if (code !== 0) throw new ToolchainError("install", `tar exited with ${code}`);
            }
            await hoistSingleDirectory(staging);
            if (item.tool === "enigma") {
                if (!node) throw new ToolchainError("install", "Node is needed first");
                await writeEnigmaLaunchers(staging, join(pins.toolchainToolDir(root, platform, node), node.command), platform);
            }
            // A zip keeps no file modes; the command must be executable.
            if (platform !== "win32" && existsSync(join(staging, item.command))) await chmod(join(staging, item.command), 0o755);
        }
        await writeFile(join(staging, READY), `${item.version}\n`);
        await rm(finalDir, { recursive: true, force: true });
        await rename(staging, finalDir);
    } finally {
        await rm(file, { force: true }).catch(() => undefined);
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    // Older versions of this tool, left by a previous pin. Best effort: one in
    // use by a running session on Windows is removed next time.
    const toolDir = join(root, item.tool);
    for (const entry of await readdir(toolDir).catch(() => [] as string[])) {
        if (entry !== item.version) await rm(join(toolDir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * Make sure every download is in place, installing what is missing in order,
 * and answer the environment a session runs with. Safe to call again after a
 * failure: what finished is kept and skipped.
 */
export async function prepareToolchain(downloads: readonly pins.ToolchainDownload[], deps: ToolchainDeps): Promise<PrepareResult> {
    const installed: pins.ToolchainDownload[] = [];
    for (const item of downloads) {
        if (!toolReady(deps.root, deps.platform, item)) {
            try {
                await installOne(item, installed, deps);
            } catch (error) {
                const code = failureOf(error);
                deps.onProgress?.({ tool: item.tool, step: "failed", code });
                return { ok: false, tool: item.tool, code };
            }
        }
        installed.push(item);
        deps.onProgress?.({ tool: item.tool, step: "ready" });
    }
    return { ok: true, env: pins.toolchainEnv(deps.root, deps.platform, installed, process.env) };
}

/** The downloads for this machine and these agents, and the agents it cannot
 *  provide (they must already be installed). */
export function plan(platform: string, arch: string, agents: readonly string[]): { downloads: pins.ToolchainDownload[]; unsupported: string[]; } {
    const downloads = pins.resolveToolchain(platform, arch, agents);
    const unsupported = agents.filter((agent) => !downloads.some((item) => item.tool === agent));
    return { downloads, unsupported };
}

/** `run` for the real app: no shell, no window, output discarded. */
export function spawnRun(file: string, args: readonly string[], env: Record<string, string>, signal?: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, [...args], { env, windowsHide: true, stdio: "ignore", signal });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
    });
}

/** The version a finished tool directory says it holds, or null when it is
 *  missing or half-done. Reported to the dashboard as `capabilities.toolchain`. */
export async function readyVersion(root: string, platform: string, download: pins.ToolchainDownload): Promise<string | null> {
    const marker = join(pins.toolchainToolDir(root, platform, download), READY);
    return (await stat(marker).catch(() => null)) ? (await readFile(marker, "utf8")).trim() : null;
}

/**
 * Which instruction files a native session reads into its system prompt.
 *
 * The discovery follows OpenCode's (sst/opencode): the rule file names and the
 * "first name that is found anywhere wins" walk from
 * `packages/opencode/src/session/system.ts` (v1.0.0, `custom()`: AGENTS.md,
 * then CLAUDE.md, then the deprecated CONTEXT.md, found up from the working
 * directory to the worktree; the global file is the first that exists of the
 * agent's own `AGENTS.md` and `~/.claude/CLAUDE.md`), and the order they are
 * quoted in from `packages/core/src/instruction-discovery.ts` (global first,
 * then the project's files nearest to farthest).
 *
 * Polar's own global file is `~/.polaris-agent/AGENTS.md`, beside the
 * transcripts the agent already keeps in that folder (`launch.ts`).
 *
 * Bounded: at most `RULES_MAX_FILES` files, each read up to
 * `RULES_MAX_FILE_BYTES` and quoted up to `MEMORY_MAX_CHARS`, the whole set up
 * to `RULES_MAX_TOTAL_CHARS`. The same file reached twice (a symlink, the
 * global folder under the checkout) is read once. Server-free.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { MEMORY_MAX_CHARS } from "@/lib/polar/native/prompt";

/** The project rule file names, in the order the first one found wins. */
export const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const;

export const RULES_MAX_FILES = 16;
/** Read no more of any one file than this; the prompt quotes less still. */
export const RULES_MAX_FILE_BYTES = 256 * 1024;
export const RULES_MAX_TOTAL_CHARS = 120_000;
/** Directories walked up looking for the repository root. */
const MAX_DEPTH = 64;

export interface RuleFile {
    /** How the prompt and the session name it: relative to the working
     *  directory inside the checkout, `~/...` in the home. */
    readonly file: string;
    readonly path: string;
    readonly text: string;
}

export interface RulesOptions {
    /** Where the session starts. */
    readonly cwd: string;
    readonly home?: string;
}

/** The global files, the first that exists wins. */
export function globalRuleFiles(home: string): string[] {
    return [path.join(home, ".polaris-agent", "AGENTS.md"), path.join(home, ".claude", "CLAUDE.md")];
}

/** The nearest folder at or above `cwd` that holds a `.git`, or `cwd` itself
 *  when it is not inside a repository. */
export function repositoryRoot(cwd: string): string {
    let dir = path.resolve(cwd);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        if (fs.existsSync(path.join(dir, ".git"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(cwd);
}

/** `start` and each folder above it, up to and including `stop`. */
export function ancestors(start: string, stop: string): string[] {
    const out: string[] = [];
    let dir = path.resolve(start);
    const end = path.resolve(stop);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        out.push(dir);
        if (samePath(dir, end)) return out;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // `stop` was not above `start`: only the start folder is the project's.
    return [path.resolve(start)];
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function readHead(file: string): string | null {
    let handle: number | null = null;
    try {
        handle = fs.openSync(file, "r");
        const buffer = Buffer.alloc(RULES_MAX_FILE_BYTES);
        const length = fs.readSync(handle, buffer, 0, RULES_MAX_FILE_BYTES, 0);
        return buffer.subarray(0, length).toString("utf8");
    } catch {
        return null;
    } finally {
        if (handle !== null) fs.closeSync(handle);
    }
}

function realOf(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return path.resolve(file);
    }
}

function inside(dir: string, file: string): boolean {
    const relative = path.relative(dir, file);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function labelOf(file: string, cwd: string, root: string, home: string): string {
    if (inside(root, file)) return path.relative(cwd, file).split(path.sep).join("/");
    if (inside(home, file)) return `~/${path.relative(home, file).split(path.sep).join("/")}`;
    return file;
}

/** The candidate paths, in the order the prompt quotes them. */
export function ruleCandidates(options: RulesOptions): string[] {
    const home = options.home ?? os.homedir();
    const cwd = path.resolve(options.cwd);
    const found: string[] = [];
    const global = globalRuleFiles(home).find(isFile);
    if (global) found.push(global);
    const dirs = ancestors(cwd, repositoryRoot(cwd));
    for (const name of RULE_FILES) {
        const matches = dirs.map((dir) => path.join(dir, name)).filter(isFile);
        if (matches.length === 0) continue;
        found.push(...matches);
        break;
    }
    return found;
}

/** The instruction files a session starts with, read, deduplicated and bounded.
 *  A file that cannot be read is skipped; this never throws. */
export function discoverRules(options: RulesOptions): RuleFile[] {
    const home = options.home ?? os.homedir();
    const cwd = path.resolve(options.cwd);
    const root = repositoryRoot(cwd);
    const seen = new Set<string>();
    const out: RuleFile[] = [];
    let total = 0;
    let candidates: string[];
    try {
        candidates = ruleCandidates(options);
    } catch {
        return [];
    }
    for (const candidate of candidates) {
        if (out.length >= RULES_MAX_FILES || total >= RULES_MAX_TOTAL_CHARS) break;
        const real = realOf(candidate);
        const key = process.platform === "win32" ? real.toLowerCase() : real;
        if (seen.has(key)) continue;
        seen.add(key);
        const raw = readHead(candidate);
        if (!raw?.trim()) continue;
        const room = Math.min(MEMORY_MAX_CHARS, RULES_MAX_TOTAL_CHARS - total);
        const text = raw.length > room ? `${raw.slice(0, room)}\n[cut]` : raw;
        total += Math.min(raw.length, room);
        out.push({ file: labelOf(candidate, cwd, root, home), path: candidate, text });
    }
    return out;
}

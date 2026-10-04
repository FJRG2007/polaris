/**
 * A `Context` for tests: an in-memory terminal, a temporary config directory, a
 * fake keychain that records what it was handed, a scripted `fetch`, and a
 * browser that only remembers what it was asked to open.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import type { Fetch } from "../../src/api.js";
import type { Host } from "../../src/paths.js";
import type { Context } from "../../src/context.js";
import { secrets, type RunResult, type Runner } from "../../src/secrets.js";

/** Every temporary folder a test made, removed when its file is done. */
const made: string[] = [];
afterAll(async () => {
    // One at a time: a test file makes a handful, and there is no hurry.
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary folder that is removed when the test file finishes. */
export async function tempDir(prefix = "plr-test-"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}

/** A keychain that lives in a map, driven through the same Runner interface the
 *  real tools are, so the store's own argument building is what is tested. */
export function fakeKeychain(): {
    run: Runner;
    entries: Map<string, string>;
    calls: { command: string; args: readonly string[]; input?: string }[];
} {
    const entries = new Map<string, string>();
    const calls: { command: string; args: readonly string[]; input?: string }[] = [];
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, started: true });
    const missing: RunResult = { code: 1, stdout: "", started: true };
    const run: Runner = async (command, args, options = {}) => {
        calls.push({ command, args, input: options.input });
        // The Linux shape: secret-tool store|lookup|clear service S account A.
        const account = args[args.length - 1] ?? "";
        if (args[0] === "store") {
            entries.set(account, options.input ?? "");
            return ok();
        }
        if (args[0] === "lookup") return entries.has(account) ? ok(entries.get(account)) : missing;
        if (args[0] === "clear") {
            entries.delete(account);
            return ok();
        }
        return missing;
    };
    return { run, entries, calls };
}

export interface Recorded {
    readonly context: Context;
    readonly stdout: () => string;
    readonly stderr: () => string;
    readonly opened: string[];
    readonly dir: string;
}

export interface ContextOptions {
    readonly fetch?: Fetch;
    readonly run?: Runner;
    readonly env?: Record<string, string>;
    readonly browser?: boolean;
    readonly answers?: string[];
    readonly platform?: NodeJS.Platform;
    /** What a hidden prompt or stdin hands `readSecret`; null when nothing does. */
    readonly secret?: string | null;
}

export async function testContext(options: ContextOptions = {}): Promise<Recorded> {
    const dir = await tempDir();
    const host: Host = {
        platform: options.platform ?? "linux",
        env: { ...options.env },
        home: dir
    };
    let out = "";
    let err = "";
    const opened: string[] = [];
    const answers = [...(options.answers ?? [])];
    const keychain = options.run ?? fakeKeychain().run;
    const context: Context = {
        host,
        configDir: join(dir, "config"),
        secrets: secrets(host, join(dir, "config"), keychain),
        fetch: options.fetch ?? (async () => new Response(null, { status: 599 })),
        io: {
            out: (text) => void (out += text),
            err: (text) => void (err += text),
            interactive: answers.length > 0
        },
        openBrowser: async (url) => {
            opened.push(url);
            return true;
        },
        canOpenBrowser: () => options.browser ?? true,
        sleep: async () => undefined,
        prompt: async () => answers.shift() ?? null,
        readSecret: async () => options.secret ?? null,
        machineName: () => "test-laptop"
    };
    return { context, stdout: () => out, stderr: () => err, opened, dir };
}

/** A scripted server: each route answers from a function of the request. */
export function scriptedFetch(
    routes: Record<
        string,
        (request: {
            method: string;
            url: string;
            headers: Headers;
            body: unknown;
        }) => Response | Promise<Response>
    >
): { fetch: Fetch; seen: { method: string; url: string; headers: Headers; body: unknown }[] } {
    const seen: { method: string; url: string; headers: Headers; body: unknown }[] = [];
    const fetch: Fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        const body =
            typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
        const request = { method, url, headers, body };
        seen.push(request);
        const path = new URL(url).pathname;
        const handler = routes[`${method} ${path}`];
        if (!handler)
            return Response.json({ error: `no route for ${method} ${path}` }, { status: 404 });
        return handler(request);
    };
    return { fetch, seen };
}

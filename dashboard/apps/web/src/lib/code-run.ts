/**
 * Running a fenced block of code, away from Polaris.
 *
 * The technique is the one Claude's artifacts, ChatGPT's canvas, Observable and
 * CodePen converged on: the code runs in a frame of a different origin than the
 * app, here an iframe sandboxed with `allow-scripts` and without
 * `allow-same-origin`, so its origin is opaque ("null") and it reaches no
 * cookie, no storage and nothing of the page that drew it. The only way out is
 * `postMessage`, and the page accepts a message only from that frame's window.
 * The code itself runs on a Worker the frame starts, so a loop that never ends
 * blocks a thread nobody is looking at, and removing the frame ends it.
 *
 * The frame carries a Content-Security-Policy of its own: no network for
 * JavaScript, and for Python only the CDN the runtime is downloaded from.
 *
 * Everything here is pure - documents are strings, messages are parsed - so it
 * can be asserted without a browser.
 */

import { z } from "zod";
import { languageForToken } from "@/lib/code-language";

export type RunKind = "javascript" | "typescript" | "python" | "html";

/** How long code may run before it is stopped. */
export const RUN_TIMEOUT_MS: Record<Exclude<RunKind, "html">, number> = {
    javascript: 5_000,
    typescript: 5_000,
    python: 10_000
};

/** Downloading the Python runtime is not running code, so it has its own allowance. */
export const PYTHON_LOAD_TIMEOUT_MS = 60_000;

/** Pinned: a CDN path that moves is code that changes under every reader. */
export const PYODIDE_VERSION = "0.29.5";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** The most output kept for one run; past it the run is stopped. */
export const OUTPUT_LIMIT = { lines: 1_000, chars: 200_000 };

// Of the many tags the markup grammar answers to, only these are a page.
const PAGE_TOKENS = new Set(["html", "htm", "xhtml"]);

/** What Run does for a fence tag, or null when the language cannot run here. */
export function runKindFor(language: string | null): RunKind | null {
    if (!language) return null;
    const token = language.trim().toLowerCase();
    const known = languageForToken(token);
    if (!known) return null;
    if (known.id === "javascript" || known.id === "typescript" || known.id === "python") return known.id;
    if (known.id === "xml" && PAGE_TOKENS.has(token)) return "html";
    return null;
}

/** A message from the runner frame, after it has been checked. */
export type RunnerMessage =
    | { type: "ready" }
    | { type: "started" }
    | { type: "out"; stream: "stdout" | "stderr"; text: string }
    | { type: "note"; note: "noInput" }
    | { type: "done"; result?: string }
    | { type: "error"; text: string; reason?: "load" };

const text = z.string().max(OUTPUT_LIMIT.chars);
const RUNNER_MESSAGE = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }).strict(),
    z.object({ type: z.literal("started") }).strict(),
    z.object({ type: z.literal("out"), stream: z.enum(["stdout", "stderr"]), text }).strict(),
    z.object({ type: z.literal("note"), note: z.literal("noInput") }).strict(),
    z.object({ type: z.literal("done"), result: text.optional() }).strict(),
    z.object({ type: z.literal("error"), text, reason: z.literal("load").optional() }).strict()
]);

/** Whatever the frame posts is the code's to choose, so it is parsed, never trusted. */
export function parseRunnerMessage(data: unknown): RunnerMessage | null {
    const parsed = RUNNER_MESSAGE.safeParse(data);
    return parsed.success ? parsed.data : null;
}

/** Inline in a `<script>`: nothing in it can close the element. */
function scriptLiteral(value: string): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function cspMeta(policy: string): string {
    return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

// Shared by both workers: turns a value into the line a console would print.
const FORMAT_SOURCE = `
function fmt(value, depth) {
    depth = depth || 0;
    if (typeof value === "string") return depth ? JSON.stringify(value) : value;
    if (typeof value === "bigint") return value + "n";
    if (typeof value === "symbol" || typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (value instanceof Error) return value.stack || value.name + ": " + value.message;
    if (value instanceof Date) return value.toISOString();
    if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]";
    try {
        if (Array.isArray(value)) return "[ " + value.slice(0, 100).map(function (v) { return fmt(v, depth + 1); }).join(", ") + (value.length > 100 ? ", ..." : "") + " ]";
        if (value instanceof Map) return "Map(" + value.size + ") { " + Array.from(value).slice(0, 100).map(function (e) { return fmt(e[0], depth + 1) + " => " + fmt(e[1], depth + 1); }).join(", ") + " }";
        if (value instanceof Set) return "Set(" + value.size + ") { " + Array.from(value).slice(0, 100).map(function (v) { return fmt(v, depth + 1); }).join(", ") + " }";
        var keys = Object.keys(value);
        return "{ " + keys.slice(0, 100).map(function (k) { return k + ": " + fmt(value[k], depth + 1); }).join(", ") + (keys.length > 100 ? ", ..." : "") + " }";
    } catch (e) {
        return String(value);
    }
}
`;

// The JavaScript worker. Done means the code returned, its promise settled and
// no timer it set is still waiting; an interval nobody clears runs into the
// timeout, which is the honest answer.
const JAVASCRIPT_WORKER = `${FORMAT_SOURCE}
var post = function (m) { postMessage(m); };
var line = function (stream) { return function () { post({ type: "out", stream: stream, text: Array.prototype.map.call(arguments, function (a) { return fmt(a); }).join(" ") }); }; };
console.log = console.info = console.debug = console.trace = line("stdout");
console.warn = console.error = line("stderr");
self.alert = line("stdout");
self.prompt = self.confirm = function () { post({ type: "note", note: "noInput" }); return null; };
var live = new Set(), settled = false, finished = false, result;
function check() {
    if (finished || !settled || live.size) return;
    finished = true;
    post(result === undefined ? { type: "done" } : { type: "done", result: fmt(result, 1) });
}
function guarded(fn, args) {
    try { if (typeof fn === "function") fn.apply(null, args); } catch (e) { post({ type: "out", stream: "stderr", text: fmt(e) }); }
}
var st = setTimeout, ct = clearTimeout, si = setInterval, ci = clearInterval;
self.setTimeout = function (fn, ms) { var args = Array.prototype.slice.call(arguments, 2); var id = st(function () { live.delete(id); guarded(fn, args); check(); }, ms); live.add(id); return id; };
self.clearTimeout = function (id) { live.delete(id); ct(id); check(); };
self.setInterval = function (fn, ms) { var args = Array.prototype.slice.call(arguments, 2); var id = si(function () { guarded(fn, args); }, ms); live.add(id); return id; };
self.clearInterval = function (id) { live.delete(id); ci(id); check(); };
self.addEventListener("unhandledrejection", function (e) { post({ type: "out", stream: "stderr", text: "Uncaught (in promise) " + fmt(e.reason) }); });
self.onmessage = function (e) {
    self.onmessage = null;
    post({ type: "started" });
    var value;
    try { value = (0, eval)(e.data.code); } catch (err) { finished = true; post({ type: "error", text: fmt(err) }); return; }
    Promise.resolve(value).then(function (v) { result = v; settled = true; check(); }, function (err) { finished = true; post({ type: "error", text: fmt(err) }); });
};
`;

const PYTHON_WORKER = `${FORMAT_SOURCE}
var post = function (m) { postMessage(m); };
self.onmessage = async function (e) {
    self.onmessage = null;
    var code = e.data.code, py;
    try {
        importScripts(${JSON.stringify(PYODIDE_BASE)} + "pyodide.js");
        py = await loadPyodide({ indexURL: ${JSON.stringify(PYODIDE_BASE)} });
    } catch (err) {
        post({ type: "error", reason: "load", text: fmt(err) });
        return;
    }
    py.setStdout({ batched: function (s) { post({ type: "out", stream: "stdout", text: s }); } });
    py.setStderr({ batched: function (s) { post({ type: "out", stream: "stderr", text: s }); } });
    py.setStdin({ stdin: function () { post({ type: "note", note: "noInput" }); return null; } });
    post({ type: "started" });
    try {
        await py.loadPackagesFromImports(code, { messageCallback: function () {} });
        var value = await py.runPythonAsync(code);
        var text = value === undefined ? undefined : String(value);
        if (value && typeof value.destroy === "function") value.destroy();
        post(text === undefined ? { type: "done" } : { type: "done", result: text });
    } catch (err) {
        // The runtime's own frames above the reader's code say nothing to them.
        post({ type: "error", text: String(err && err.message || err).replace(/^Traceback[\\s\\S]*?(?=  File "<exec>")/, "Traceback (most recent call last):\\n") });
    }
};
`;

const NO_NETWORK_POLICY =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; worker-src blob: data:; connect-src 'none'; form-action 'none'";
const PYTHON_POLICY =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: https://cdn.jsdelivr.net; worker-src blob: data:; connect-src https://cdn.jsdelivr.net; form-action 'none'";

/**
 * The runner frame's document: it says it is ready, takes one piece of code
 * from the page that drew it, runs it on a Worker and relays what comes back.
 * `parentOrigin` is the page's own origin; the frame answers nobody else.
 */
export function runnerDocument(kind: "javascript" | "typescript" | "python", parentOrigin: string): string {
    const worker = kind === "python" ? PYTHON_WORKER : JAVASCRIPT_WORKER;
    const policy = kind === "python" ? PYTHON_POLICY : NO_NETWORK_POLICY;
    return `<!doctype html><html><head>${cspMeta(policy)}</head><body><script>
(function () {
    var PARENT = ${scriptLiteral(parentOrigin)};
    var SOURCE = ${scriptLiteral(worker)};
    var send = function (m) { parent.postMessage(m, PARENT); };
    var worker = null;
    addEventListener("message", function (e) {
        if (worker || e.source !== parent || e.origin !== PARENT) return;
        var d = e.data;
        if (!d || d.type !== "run" || typeof d.code !== "string") return;
        try {
            worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" })));
        } catch (err) {
            worker = new Worker("data:text/javascript;base64," + btoa(unescape(encodeURIComponent(SOURCE))));
        }
        worker.onmessage = function (ev) { send(ev.data); };
        worker.onerror = function (ev) { ev.preventDefault(); send({ type: "error", text: String(ev.message || "Error") }); };
        worker.postMessage({ code: d.code });
    });
    send({ type: "ready" });
})();
</script></body></html>`;
}

/**
 * A page shown as a preview. Scripts and styles may come from the web, as a
 * page pasted from anywhere expects; it may not call out (`connect-src`), post
 * a form or open anything, and the sandbox gives it an opaque origin.
 */
export function previewDocument(html: string): string {
    return (
        cspMeta(
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'"
        ) + html
    );
}

/** TypeScript with its types taken out, which is all it needs to run as JavaScript. */
export async function stripTypes(code: string): Promise<string> {
    const { transform } = await import("sucrase");
    return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
}

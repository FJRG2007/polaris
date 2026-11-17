/**
 * The worker browser's server inside a container session: a stdio MCP server
 * the agent drives (navigate, click, type, read, screenshot), and beside it a
 * small HTTP listener the dashboard dials for the live view and the person's
 * input. Node's standard library only - CDP over Node's own `WebSocket` - so it
 * needs nothing installed beyond the browser. Written to the session's state
 * folder at boot (`asFile()` in session-runtime, decoded by the boot script)
 * and registered beside Polaris's own server in `mcpConfig()`.
 *
 * Chromium is not in the session image (`node:24`). It is installed the first
 * time the agent reaches for the browser, never at boot: a session that never
 * browses never pays for it. The install is Debian's `chromium` package
 * through the passwordless sudo the session account already has, with apt's
 * download cache pointed into the session home (`~/.cache/polaris-browser`),
 * which is the one folder that outlives a container - so the second session
 * reinstalls from the packages it already has instead of fetching them again.
 * Only where Polaris owns the machine (`POLARIS_BROWSER_INSTALL=1`); on a
 * machine somebody else owns it uses a Chromium that is already there, or says
 * there is none.
 *
 * Chromium runs with `--no-sandbox`: its own sandbox needs kernel features a
 * container's seccomp profile withholds, and the container is the boundary.
 *
 * The listener answers only `Authorization: Bearer <POLARIS_BROWSER_KEY>`, a
 * key the dashboard derives from the session's id (session-browser-link.ts):
 * the container's private network reaches it, and nothing on it can watch or
 * steer the browser without that key.
 *
 * Protocol and limits: `session-browser-protocol.ts`, from Agent
 * Orchestrator's `browserstream` (Apache-2.0).
 */

import * as protocol from "./session-browser-protocol";

/** MCP's revision this server speaks when the client names none it knows. */
const PROTOCOL_VERSION = "2025-06-18";

export function browserMcpScript(): string {
    return `import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";

const KEY = process.env.POLARIS_BROWSER_KEY || "";
const PORT = Number(process.env.POLARIS_BROWSER_PORT) || ${protocol.BROWSER_STREAM_PORT};
const MAY_INSTALL = process.env.POLARIS_BROWSER_INSTALL === "1";
const TOOLS = ${JSON.stringify(protocol.BROWSER_TOOLS)};
const VIEWPORT = ${JSON.stringify(protocol.BROWSER_VIEWPORT)};
const METHODS = new Set(${JSON.stringify(protocol.CDP_METHODS)});
const NOTICE = ${JSON.stringify(protocol.UNTRUSTED_NOTICE)};
const READ_MAX = ${protocol.READ_MAX_CHARS};
const FRAME_MAX = ${protocol.MAX_FRAME_BYTES};
const HEADER = ${protocol.FRAME_HEADER_BYTES};
const KNOWN = ["2024-11-05", "2025-03-26", "2025-06-18"];
const BINARIES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

// ---------------------------------------------------------------- state
const state = { status: "idle", url: "", title: "", agentDriving: false };
let driving = 0;
let browser = null; // { child, socket, call }
let starting = null;
let sequence = 0;
let lastFrame = null;
const viewers = new Set();

function packet(body) {
    const out = Buffer.alloc(4 + body.length);
    out.writeUInt32BE(body.length, 0);
    body.copy(out, 4);
    return out;
}
function statePacket() {
    const json = Buffer.from(JSON.stringify(state), "utf8");
    return packet(Buffer.concat([Buffer.from([${protocol.FRAME_VERSION}, ${protocol.KIND_STATE}]), json]));
}
function framePacket(jpeg, width, height) {
    const head = Buffer.alloc(HEADER);
    head[0] = ${protocol.FRAME_VERSION};
    head[1] = ${protocol.KIND_JPEG};
    head.writeBigUInt64BE(BigInt(++sequence), 2);
    head.writeBigUInt64BE(BigInt(Date.now()), 10);
    head.writeUInt16BE(width, 18);
    head.writeUInt16BE(height, 20);
    return packet(Buffer.concat([head, jpeg]));
}
function publishState(patch) {
    Object.assign(state, patch, { agentDriving: driving > 0 });
    const out = statePacket();
    for (const viewer of viewers) viewer.res.write(out);
}
// Latest value first: a viewer still draining its last frame gets the newest
// one when it drains, never a queue of old ones.
function publishFrame(out) {
    lastFrame = out;
    for (const viewer of viewers) {
        if (viewer.busy) { viewer.pending = true; continue; }
        viewer.busy = !viewer.res.write(out);
    }
}

// ---------------------------------------------------------------- chromium
async function executable(path) {
    try { await access(path, constants.X_OK); return true; } catch { return false; }
}
async function findChromium() {
    const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
    for (const name of BINARIES) for (const dir of dirs) {
        const path = join(dir, name);
        if (await executable(path)) return path;
    }
    return null;
}
function run(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        let errors = "";
        child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-2000); });
        child.on("error", () => resolve({ ok: false, errors: "could not start " + command }));
        child.on("close", (code) => resolve({ ok: code === 0, errors }));
    });
}
async function installChromium() {
    if (!MAY_INSTALL) throw new Error("This machine has no Chromium, and Polaris does not install software on a machine it does not own.");
    publishState({ status: "installing" });
    const cache = join(homedir(), ".cache", "polaris-browser", "apt");
    await mkdir(join(cache, "partial"), { recursive: true }).catch(() => {});
    const apt = ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get"];
    const update = await run("sudo", [...apt, "update", "-qq"]);
    if (!update.ok) throw new Error("The package lists could not be fetched to install Chromium.");
    const install = await run("sudo", [...apt, "install", "-y", "-qq", "--no-install-recommends",
        "-o", "Dir::Cache::Archives=" + cache, "chromium", "fonts-liberation"]);
    if (!install.ok) throw new Error("Chromium could not be installed in this session.");
    const found = await findChromium();
    if (!found) throw new Error("Chromium was installed but cannot be found.");
    return found;
}
function cdp(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        let next = 0;
        const waiting = new Map();
        const listeners = new Map();
        socket.addEventListener("open", () => resolve({
            socket,
            call(method, params = {}) {
                const id = ++next;
                socket.send(JSON.stringify({ id, method, params }));
                return new Promise((ok, fail) => {
                    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(method + " timed out")); }, 30000);
                    waiting.set(id, { ok, fail, timer });
                });
            },
            on(method, handler) { listeners.set(method, handler); }
        }));
        socket.addEventListener("error", () => reject(new Error("The browser could not be reached.")));
        socket.addEventListener("close", () => {
            for (const { fail, timer } of waiting.values()) { clearTimeout(timer); fail(new Error("The browser closed.")); }
            waiting.clear();
            browser = null;
            publishState({ status: "idle" });
        });
        socket.addEventListener("message", (event) => {
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }
            if (message.id && waiting.has(message.id)) {
                const { ok, fail, timer } = waiting.get(message.id);
                clearTimeout(timer);
                waiting.delete(message.id);
                return message.error ? fail(new Error(message.error.message || "CDP error")) : ok(message.result || {});
            }
            const handler = message.method && listeners.get(message.method);
            if (handler) handler(message.params || {});
        });
    });
}
async function launch() {
    const path = (await findChromium()) || (await installChromium());
    const profile = join(tmpdir(), "polaris-browser-profile");
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await mkdir(profile, { recursive: true });
    const child = spawn(path, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
        "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--user-data-dir=" + profile, "--window-size=" + VIEWPORT.width + "," + VIEWPORT.height, "about:blank"],
        { stdio: "ignore", windowsHide: true });
    child.on("exit", () => { browser = null; publishState({ status: "idle" }); });
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
        port = Number(text.split("\\n")[0]) || 0;
    }
    if (!port) { child.kill("SIGKILL"); throw new Error("The browser did not start."); }
    const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) { child.kill("SIGKILL"); throw new Error("The browser has no page open."); }
    const link = await cdp(page.webSocketDebuggerUrl);
    await link.call("Page.enable");
    await link.call("Runtime.enable");
    await link.call("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    link.on("Page.screencastFrame", (params) => {
        link.call("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        const jpeg = Buffer.from(String(params.data || ""), "base64");
        if (!jpeg.length || jpeg.length > FRAME_MAX) return;
        const meta = params.metadata || {};
        publishFrame(framePacket(jpeg, Math.round(meta.deviceWidth || VIEWPORT.width), Math.round(meta.deviceHeight || VIEWPORT.height)));
    });
    link.on("Page.frameNavigated", (params) => {
        if (params.frame && !params.frame.parentId) publishState({ url: String(params.frame.url || "").slice(0, 4096) });
    });
    link.on("Page.loadEventFired", () => { refreshTitle().catch(() => {}); });
    browser = { child, ...link };
    publishState({ status: "ready" });
    if (viewers.size > 0) await startCast();
    return browser;
}
async function ensureBrowser() {
    if (browser) return browser;
    if (!starting) starting = launch().catch((error) => { publishState({ status: "failed" }); throw error; }).finally(() => { starting = null; });
    return starting;
}
async function refreshTitle() {
    if (!browser) return;
    const answer = await browser.call("Runtime.evaluate", { expression: "document.title", returnByValue: true });
    publishState({ title: String((answer.result && answer.result.value) || "").slice(0, 512) });
}
async function startCast() {
    if (!browser) return;
    await browser.call("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }).catch(() => {});
}
async function stopCast() {
    if (browser) await browser.call("Page.stopScreencast").catch(() => {});
}
async function evaluate(expression) {
    const answer = await browser.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw new Error("The page refused: " + String(answer.exceptionDetails.text || "script error"));
    return answer.result ? answer.result.value : undefined;
}
async function history(delta) {
    const answer = await browser.call("Page.getNavigationHistory");
    const entry = (answer.entries || [])[(answer.currentIndex || 0) + delta];
    if (entry) await browser.call("Page.navigateToHistoryEntry", { entryId: entry.id });
}
function browsable(raw) {
    const text = String(raw || "").trim();
    if (!text || text.length > 4096) return null;
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text);
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch { return null; }
}
async function settle() { await new Promise((r) => setTimeout(r, 400)); }
async function clickAt(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await browser.call("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
}
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
async function press(key) {
    const printable = [...key].length === 1;
    if (!printable && !(key in KEYS)) throw new Error("Unknown key: " + key);
    const text = key === "Enter" ? "\\r" : printable ? key : undefined;
    const code = KEYS[key];
    await browser.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, ...(code ? { windowsVirtualKeyCode: code } : {}), ...(text ? { text } : {}) });
    await browser.call("Input.dispatchKeyEvent", { type: "keyUp", key, ...(code ? { windowsVirtualKeyCode: code } : {}) });
}
function centerOf(selector) {
    return "(() => { const el = document.querySelector(" + JSON.stringify(selector) + "); if (!el) return null;" +
        " el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();" +
        " return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()";
}

// ---------------------------------------------------------------- tools
function check(name, args) {
    const spec = TOOLS.find((t) => t.name === name);
    if (!spec) return "Unknown tool: " + name;
    if (!args || typeof args !== "object" || Array.isArray(args)) return "Arguments must be an object.";
    for (const key of Object.keys(args)) if (!(key in spec.inputSchema.properties)) return "Unknown argument: " + key;
    for (const key of spec.inputSchema.required) if (args[key] === undefined) return "Missing argument: " + key;
    for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && typeof value !== spec.inputSchema.properties[key].type) return key + " must be a " + spec.inputSchema.properties[key].type + ".";
        if (typeof value === "number" && !Number.isFinite(value)) return key + " must be a finite number.";
        if (typeof value === "string" && value.length > 16384) return key + " is too long.";
    }
    return null;
}
async function callTool(name, args) {
    const refusal = check(name, args);
    if (refusal) return { text: refusal, error: true };
    driving++;
    publishState({});
    try {
        await ensureBrowser();
        switch (name) {
            case "browser_navigate": {
                const url = browsable(args.url);
                if (!url) return { text: "Only http and https addresses can be opened.", error: true };
                const answer = await browser.call("Page.navigate", { url });
                if (answer.errorText) return { text: "The page did not open: " + answer.errorText, error: true };
                await settle();
                await refreshTitle().catch(() => {});
                return { text: "Opened " + state.url + (state.title ? " (" + state.title + ")" : "") };
            }
            case "browser_click": {
                let point = null;
                if (args.selector) point = await evaluate(centerOf(args.selector));
                else if (typeof args.x === "number" && typeof args.y === "number") point = { x: args.x, y: args.y };
                if (!point) return { text: args.selector ? "No element matches " + args.selector : "Give a selector, or both x and y.", error: true };
                await clickAt(Math.round(point.x), Math.round(point.y));
                await settle();
                return { text: "Clicked at " + Math.round(point.x) + "," + Math.round(point.y) + "." };
            }
            case "browser_type": {
                if (args.selector) {
                    const point = await evaluate(centerOf(args.selector));
                    if (!point) return { text: "No element matches " + args.selector, error: true };
                    await clickAt(Math.round(point.x), Math.round(point.y));
                }
                await browser.call("Input.insertText", { text: args.text });
                if (args.submit) await press("Enter");
                await settle();
                return { text: "Typed " + [...args.text].length + " characters" + (args.submit ? " and pressed Enter." : ".") };
            }
            case "browser_press":
                await press(args.key);
                await settle();
                return { text: "Pressed " + args.key + "." };
            case "browser_scroll":
                await browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX: 0, deltaY: Math.max(-10000, Math.min(10000, args.deltaY)) });
                await settle();
                return { text: "Scrolled." };
            case "browser_back":
                await history(-1);
                await settle();
                return { text: "Went back to " + state.url };
            case "browser_screenshot": {
                const shot = await browser.call("Page.captureScreenshot", { format: "jpeg", quality: 70 });
                return { image: String(shot.data || "") };
            }
            case "browser_read": {
                const expression = "(() => { const root = " + (args.selector ? "document.querySelector(" + JSON.stringify(args.selector) + ")" : "document.body") + ";" +
                    " if (!root) return null; const links = [...root.querySelectorAll('a[href]')].slice(0, 100)" +
                    ".map((a) => ({ text: (a.innerText || '').trim().slice(0, 200), href: a.href }));" +
                    " return { url: location.href, title: document.title, text: (root.innerText || '').slice(0, " + READ_MAX + "), links }; })()";
                const page = await evaluate(expression);
                if (!page) return { text: "No element matches " + args.selector, error: true };
                const links = page.links.map((l) => "- " + (l.text || "(no text)") + " -> " + l.href).join("\\n");
                return { text: NOTICE + "\\n\\n<page url=" + JSON.stringify(page.url) + " title=" + JSON.stringify(page.title) + ">\\n" + page.text + (links ? "\\n\\nLinks:\\n" + links : "") + "\\n</page>" };
            }
        }
        return { text: "Unknown tool: " + name, error: true };
    } catch (error) {
        return { text: String((error && error.message) || error), error: true };
    } finally {
        driving--;
        publishState({});
    }
}

// ---------------------------------------------------------------- MCP (stdio)
function send(message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
async function handle(request) {
    const { id, method, params } = request;
    if (method === "initialize") {
        const asked = params && params.protocolVersion;
        return send({ id, result: {
            protocolVersion: KNOWN.includes(asked) ? asked : ${JSON.stringify(PROTOCOL_VERSION)},
            capabilities: { tools: {} },
            serverInfo: { name: ${JSON.stringify(protocol.BROWSER_SERVER_NAME)}, version: "1.0.0" }
        } });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
    if (method === "tools/call") {
        const outcome = await callTool(params && params.name, (params && params.arguments) || {});
        const content = outcome.image ? [{ type: "image", data: outcome.image, mimeType: "image/jpeg" }] : [{ type: "text", text: outcome.text }];
        return send({ id, result: { content, isError: Boolean(outcome.error) } });
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
    handle(request).catch(() => { if (request.id !== undefined) send({ id: request.id, error: { code: -32603, message: "Internal error" } }); });
});
// The agent's client ending is the end of this server, and of its browser.
process.stdin.on("close", () => {
    if (browser) browser.child.kill("SIGKILL");
    process.exit(0);
});

// ---------------------------------------------------------------- stream (HTTP)
function authorized(req) {
    if (!KEY) return false;
    const given = Buffer.from(String(req.headers.authorization || ""), "utf8");
    const expected = Buffer.from("Bearer " + KEY, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
}
function answer(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}
async function relay(commands) {
    for (const command of commands) {
        if (command.method === "Polaris.history") await history(command.params.delta < 0 ? -1 : 1);
        else await browser.call(command.method, command.params);
    }
}
createServer((req, res) => {
    if (!authorized(req)) return answer(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/stream") {
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
        const viewer = { res, busy: false, pending: false };
        res.on("drain", () => {
            viewer.busy = false;
            if (viewer.pending && lastFrame) { viewer.pending = false; viewer.busy = !res.write(lastFrame); }
        });
        const first = viewers.size === 0;
        viewers.add(viewer);
        res.write(statePacket());
        if (lastFrame) viewer.busy = !res.write(lastFrame);
        if (first) startCast();
        req.on("close", () => {
            viewers.delete(viewer);
            if (viewers.size === 0) stopCast();
        });
        return;
    }
    if (req.method === "POST" && req.url === "/input") {
        let body = "";
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 65536) { req.destroy(); return; }
            body += chunk;
        });
        req.on("end", async () => {
            let commands;
            try { commands = JSON.parse(body).commands; } catch { return answer(res, 400, { error: "invalid" }); }
            if (!Array.isArray(commands) || commands.length === 0 || commands.length > 8) return answer(res, 400, { error: "invalid" });
            for (const c of commands)
                if (!c || !METHODS.has(c.method) || !c.params || typeof c.params !== "object" || Array.isArray(c.params)) return answer(res, 400, { error: "invalid" });
            if (!browser) return answer(res, 409, { error: "no-browser" });
            if (driving > 0) return answer(res, 409, { error: "agent-driving" });
            try { await relay(commands); answer(res, 200, { ok: true }); }
            catch { answer(res, 502, { error: "browser" }); }
        });
        return;
    }
    answer(res, 404, { error: "not-found" });
}).on("error", () => {}).listen(PORT, "0.0.0.0");
`;
}

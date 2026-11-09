/**
 * A live preview of a web server the agent runs in its session, for the
 * workspace beside a Code thread.
 *
 * Served by Polaris itself, under a path, so it needs nothing set up: no
 * wildcard name, no certificate, no port opened. The way code-server's
 * `/proxy/<port>/` and Coder's path-based apps reach a workspace, with the
 * capability in the path the way Daytona's preview links carry a token:
 *
 *     /api/agents/preview/<session>/<signature>/<port>/...
 *
 * The signature is the session's id signed with the app secret every install
 * already has, so the address is stable for the life of the session - the
 * agent is told it (`POLARIS_PREVIEW_BASE`) and can serve under it - and only
 * Polaris can mint it. It opens a session that is still running and nothing
 * else.
 *
 * What the page is never given, because the agent wrote it and it answers on
 * Polaris's own origin:
 *
 * - **Polaris's origin.** Every response carries `Content-Security-Policy:
 *   sandbox` without `allow-same-origin`, so the page runs in an opaque origin:
 *   it cannot read Polaris's cookies or storage, and a request it makes to
 *   Polaris is a cross-site one that carries no session.
 * - **The reader's credentials.** Cookies and `Authorization` are stripped on
 *   the way in, and `Set-Cookie` on the way out: a dev server never sees the
 *   Polaris session, and can never set a cookie on Polaris's name.
 *
 * Reaching the container:
 *
 * - On this box the session joins a private network of its own
 *   (`sessionNetwork`), which the host daemon attaches Polaris's own
 *   containers to, and is dialled by name. No other session is on it.
 * - On a pool server it is dialled at its address on that server, through a
 *   pooled SSH connection (`direct-tcpip`), the way the mail server is.
 *
 * Whether a server serves at its root or under the path is not something this
 * can be told, so it asks: the root first, and the full path when the root
 * answers 404 (a server given a base path answers 404 at the root). Whichever
 * answered is remembered for a short while.
 *
 * Not carried: WebSockets, so a dev server's hot reload does not reach the
 * page. The workspace reloads it instead.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { Readable } from "node:stream";
import { forwardOut } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { withContainerPorts } from "./session-ports";
import { sessionPlacement } from "./session-service";
import { sessionNetwork } from "./session-network";
import { previewBase } from "./session-preview-link";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";

/** How long the upstream has to start answering. A response that has started
 *  may stream for as long as it likes (a dev server's event stream). */
const HEADERS_TIMEOUT_MS = 30_000;
/** How long a server's root-or-path answer is remembered. */
const MODE_TTL_MS = 2 * 60_000;
/** How long where a session's container is is remembered. */
const TARGET_TTL_MS = 10_000;
/** The most entries either memory holds. */
const MEMORY_MAX = 2_000;

// --- Which ports a session serves -----------------------------------------

export interface ListeningPorts {
    /** Listening on every address: the preview reaches these. */
    readonly open: number[];
    /** Listening on the container's loopback only: nothing outside it can. */
    readonly inside: number[];
}

const LOOPBACK_V4 = /^[0-9A-F]{6}7F$/;
const LOOPBACK_V6 = "00000000000000000000000001000000";
const MAPPED_LOOPBACK_V6 = /^0000000000000000FFFF0000[0-9A-F]{6}7F$/;

/**
 * The listening TCP ports in `/proc/net/tcp` and `/proc/net/tcp6`. The kernel
 * writes each address as hex in host byte order, so 127.0.0.1 is `0100007F`.
 */
export function listeningPorts(proc: string): ListeningPorts {
    const open = new Set<number>();
    const inside = new Set<number>();
    for (const line of proc.split("\n")) {
        const fields = line.trim().split(/\s+/);
        // sl, local_address, rem_address, st, ...; 0A is LISTEN.
        if (fields.length < 4 || fields[3] !== "0A") continue;
        const [address, hexPort] = (fields[1] ?? "").split(":");
        if (!address || !hexPort || !/^[0-9A-F]+$/i.test(hexPort)) continue;
        const port = parseInt(hexPort, 16);
        if (!(port >= 1 && port <= 65535)) continue;
        const upper = address.toUpperCase();
        const loopback =
            LOOPBACK_V4.test(upper) || upper === LOOPBACK_V6 || MAPPED_LOOPBACK_V6.test(upper);
        (loopback ? inside : open).add(port);
    }
    for (const port of open) inside.delete(port);
    return {
        open: [...open].sort((a, b) => a - b),
        inside: [...inside].sort((a, b) => a - b)
    };
}

export type PreviewPortsAnswer =
    | { kind: "ports"; base: string; open: number[]; inside: number[] }
    | { kind: "unavailable" };

async function containerOf(sessionId: string): Promise<{ hostId: string | null; name: string } | null> {
    const placement = await sessionPlacement(sessionId);
    // A session on somebody's own account on a server has that server's ports,
    // which are not the session's to show.
    if (!placement || placement.place !== "local" || !placement.containerId) return null;
    if (core.isSessionOver(placement.state)) return null;
    return { hostId: placement.hostId, name: placement.containerId };
}

/** The web servers a running container session answers on. */
export async function sessionPreviewPorts(sessionId: string): Promise<PreviewPortsAnswer> {
    const container = await containerOf(sessionId);
    if (!container) return { kind: "unavailable" };
    try {
        return await withContainerPorts(container.hostId, async (ports) => {
            const read = await ports.runIn(container.name, [
                "sh",
                "-c",
                // Only the listening sockets: the output is a capped string, and a
                // busy agent holds many connections that are not servers.
                "grep -h ' 0A ' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true"
            ]);
            const found = listeningPorts(read.output);
            return { kind: "ports" as const, base: previewBase(sessionId), ...found };
        });
    } catch (error) {
        console.error(`[agent-preview] ${sessionId}: could not read its ports:`, error);
        return { kind: "unavailable" };
    }
}

// --- Headers --------------------------------------------------------------

/** Never passed on in either direction: they describe one hop, not the message. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
]);

/** Never handed to the agent's server: they are the reader's, not the page's. */
const CREDENTIALS = new Set(["cookie", "authorization"]);

/** Never handed back: Polaris's own, or a way to act on Polaris's name. */
const REPLACED = new Set([
    "set-cookie",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "strict-transport-security",
    "clear-site-data",
    "service-worker-allowed"
]);

/** Runs the page in an opaque origin. No `allow-same-origin`, ever. */
export const PREVIEW_SANDBOX =
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export function upstreamHeaders(
    incoming: Headers,
    port: number,
    prefix: string,
    proto: string
): Record<string, string> {
    const out: Record<string, string> = {};
    incoming.forEach((value, key) => {
        const name = key.toLowerCase();
        if (HOP_BY_HOP.has(name) || CREDENTIALS.has(name) || name === "host") return;
        if (name.startsWith("x-forwarded-") || name === "forwarded") return;
        out[name] = value;
    });
    // What a dev server expects to be called, so one that only answers its own
    // name (Vite's allowed hosts) answers.
    out.host = `localhost:${port}`;
    out["x-forwarded-prefix"] = prefix;
    out["x-forwarded-proto"] = proto;
    return out;
}

/** Where a redirect from the upstream should send the browser. */
export function previewLocation(location: string, prefix: string, mode: Mode): string {
    let path: string | null = null;
    if (location.startsWith("/") && !location.startsWith("//")) path = location;
    else {
        try {
            const url = new URL(location);
            // Only the server's own names: a redirect to another site stays one.
            if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname))
                path = `${url.pathname}${url.search}${url.hash}`;
        } catch {
            path = null;
        }
    }
    if (path === null) return location;
    if (mode === "full" && (path === prefix || path.startsWith(`${prefix}/`))) return path;
    return `${prefix}${path}`;
}

export function downstreamHeaders(upstream: IncomingHttpHeaders, prefix: string, mode: Mode): Headers {
    const out = new Headers();
    for (const [key, value] of Object.entries(upstream)) {
        const name = key.toLowerCase();
        if (value === undefined || HOP_BY_HOP.has(name) || REPLACED.has(name)) continue;
        if (name === "location") {
            out.set("location", previewLocation(String(value), prefix, mode));
            continue;
        }
        for (const one of Array.isArray(value) ? value : [value]) out.append(name, one);
    }
    out.set("content-security-policy", PREVIEW_SANDBOX);
    // A page in an opaque origin loads its own modules as cross-origin ones.
    // Nothing credentialed is ever sent here, so any origin may read them.
    out.set("access-control-allow-origin", "*");
    out.set("referrer-policy", "no-referrer");
    out.set("x-robots-tag", "noindex, nofollow");
    return out;
}

// --- Proxying -------------------------------------------------------------

export type Mode = "root" | "full";

interface Remembered<T> {
    readonly value: T;
    readonly at: number;
}

function remember<T>(memory: Map<string, Remembered<T>>, key: string, value: T, now: number): void {
    if (memory.size >= MEMORY_MAX) {
        const oldest = memory.keys().next().value;
        if (oldest !== undefined) memory.delete(oldest);
    }
    memory.set(key, { value, at: now });
}

function recall<T>(memory: Map<string, Remembered<T>>, key: string, ttl: number, now: number): T | undefined {
    const held = memory.get(key);
    if (!held) return undefined;
    if (now - held.at > ttl) {
        memory.delete(key);
        return undefined;
    }
    return held.value;
}

const modes = new Map<string, Remembered<Mode>>();
const targets = new Map<string, Remembered<{ hostId: string | null; name: string } | null>>();
const addresses = new Map<string, Remembered<string>>();

async function targetOf(sessionId: string, now: number) {
    const held = recall(targets, sessionId, TARGET_TTL_MS, now);
    if (held !== undefined) return held;
    const found = await containerOf(sessionId);
    remember(targets, sessionId, found, now);
    return found;
}

/** The container's address on its server, from the engine there. */
async function addressOn(hostId: string, name: string, sessionId: string, now: number): Promise<string> {
    const held = recall(addresses, `${hostId}:${name}`, MODE_TTL_MS, now);
    if (held) return held;
    const inspected = (await withContainerPorts(hostId, (ports) => ports.inspect(name))) as {
        NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    } | null;
    const networks = inspected?.NetworkSettings?.Networks ?? {};
    const own = networks[sessionNetwork(sessionId)]?.IPAddress;
    const any = Object.values(networks).find((network) => network.IPAddress)?.IPAddress;
    const address = own || any;
    if (!address) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
    remember(addresses, `${hostId}:${name}`, address, now);
    return address;
}

export type PreviewFailure = "gone" | "refused" | "older" | "unreachable" | "slow";

export class PreviewError extends Error {
    public constructor(public readonly failure: PreviewFailure) {
        super(failure);
    }
}

function failureOf(error: unknown): PreviewFailure {
    if (error instanceof PreviewError) return error.failure;
    const code = (error as { code?: unknown; reason?: unknown } | null)?.code;
    const reason = (error as { reason?: unknown } | null)?.reason;
    if (code === "ECONNREFUSED" || reason === 2) return "refused";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "older";
    return "unreachable";
}

interface Sent {
    readonly response: IncomingMessage;
    readonly done: () => void;
}

interface Outgoing {
    readonly method: string;
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly body: Readable | null;
    readonly signal: AbortSignal;
}

async function send(
    target: { hostId: string | null; name: string },
    sessionId: string,
    port: number,
    outgoing: Outgoing,
    now: number
): Promise<Sent> {
    let release = () => {};
    let socket: NodeJS.ReadWriteStream | null = null;
    if (target.hostId) {
        const address = await addressOn(target.hostId, target.name, sessionId, now);
        const host = await getHostConnectionUnscoped(target.hostId);
        const lease = await borrowSsh("exec", target.hostId, {
            host: host.address,
            port: host.port,
            username: host.username,
            auth: host.auth,
            pinnedHostKey: host.hostKey
        });
        try {
            socket = await forwardOut(lease.client, address, port);
        } catch (error) {
            lease.release();
            throw error;
        }
        release = () => lease.release();
    }

    return await new Promise<Sent>((resolve, reject) => {
        let settled = false;
        const finish = once(release);
        const request = httpRequest({
            host: target.hostId ? "localhost" : target.name,
            port,
            method: outgoing.method,
            path: outgoing.path,
            headers: outgoing.headers,
            ...(socket ? { createConnection: () => socket as never } : {})
        });
        const timer = setTimeout(() => request.destroy(new PreviewError("slow")), HEADERS_TIMEOUT_MS);
        const abort = () => request.destroy();
        outgoing.signal.addEventListener("abort", abort, { once: true });
        request.on("response", (response) => {
            clearTimeout(timer);
            settled = true;
            const done = () => {
                outgoing.signal.removeEventListener("abort", abort);
                finish();
            };
            response.once("close", done);
            resolve({ response, done });
        });
        request.on("error", (error) => {
            clearTimeout(timer);
            outgoing.signal.removeEventListener("abort", abort);
            finish();
            if (!settled) reject(error);
        });
        if (outgoing.body) outgoing.body.pipe(request);
        else request.end();
    });
}

function once(work: () => void): () => void {
    let ran = false;
    return () => {
        if (ran) return;
        ran = true;
        work();
    };
}

export interface PreviewRequest {
    readonly sessionId: string;
    readonly port: number;
    /** The request's own path, the prefix included, and its query. */
    readonly pathname: string;
    readonly search: string;
    readonly method: string;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array> | null;
    readonly signal: AbortSignal;
    readonly proto: string;
}

/** The path the upstream is asked for in each mode. */
export function upstreamPath(pathname: string, search: string, prefix: string, mode: Mode): string {
    if (mode === "full") return `${pathname}${search}`;
    const rest = pathname.slice(prefix.length);
    return `${rest.startsWith("/") ? rest : `/${rest}`}${search}`;
}

/**
 * Answer one request of a preview from the session's server. The signature is
 * the caller's to have checked; this checks that the session is a running
 * container session.
 */
export async function proxyPreview(input: PreviewRequest, now = Date.now()): Promise<Response> {
    const target = await targetOf(input.sessionId, now);
    if (!target) throw new PreviewError("gone");
    const prefix = `${previewBase(input.sessionId)}/${input.port}`;
    const headers = upstreamHeaders(input.headers, input.port, prefix, input.proto);
    const safe = input.method === "GET" || input.method === "HEAD";
    const key = `${input.sessionId}:${input.port}`;
    const known = recall(modes, key, MODE_TTL_MS, now);

    const attempt = (mode: Mode) =>
        send(
            target,
            input.sessionId,
            input.port,
            {
                method: input.method,
                path: upstreamPath(input.pathname, input.search, prefix, mode),
                headers,
                body: !safe && input.body ? Readable.fromWeb(input.body as never) : null,
                signal: input.signal
            },
            now
        );

    let mode: Mode = known ?? "root";
    let sent: Sent;
    try {
        sent = await attempt(mode);
        // Asked only of a server not yet known, and only for a read: a write is
        // never sent twice.
        if (!known && safe && sent.response.statusCode === 404) {
            sent.response.resume();
            sent.done();
            mode = "full";
            sent = await attempt(mode);
            if (sent.response.statusCode !== 404) remember(modes, key, mode, now);
        } else if (!known && safe) {
            remember(modes, key, mode, now);
        }
    } catch (error) {
        throw new PreviewError(failureOf(error));
    }

    const { response } = sent;
    const status = response.statusCode ?? 502;
    const bodyless = input.method === "HEAD" || status === 204 || status === 304;
    if (bodyless) {
        response.resume();
        sent.done();
    }
    return new Response(bodyless ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
        status,
        statusText: response.statusMessage,
        headers: downstreamHeaders(response.headers, prefix, mode)
    });
}

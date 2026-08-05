/**
 * The guard's proxy mode, which exists for exactly one control: email obfuscation.
 *
 * Everything else the firewall does is a decision about a REQUEST, so Traefik's
 * forwardAuth is enough - it asks the guard, gets a status, and forwards to the app
 * itself. Obfuscation rewrites the RESPONSE, and forwardAuth never sees one. So for a
 * route with obfuscation on, Traefik points at the guard instead and the guard
 * forwards to the app, which is the only place in this design that sits in the data
 * path rather than beside it.
 *
 * Three things keep that from being a bad trade:
 *
 *  - It is per route. A route with obfuscation off is untouched and still goes
 *    straight from Traefik to the app.
 *  - The guard is co-located on the server it protects, started by the same
 *    onboarding that starts Traefik. It is not the control plane, so this does not
 *    make Polaris a runtime dependency of a deployed app.
 *  - Every failure passes the response through unchanged. A body too large, an
 *    encoding it did not ask for, a rewrite that throws - all of them serve the
 *    original bytes. The feature is cosmetic; breaking a page to deliver it would be
 *    a far worse outcome than not delivering it.
 *
 * Compression is sidestepped rather than handled: the forwarded request asks the app
 * for `identity`, so what comes back is the plain HTML the rewrite needs and there is
 * no decompress/recompress step to get wrong. Guard and app are on the same host, so
 * the transfer costs nothing worth reclaiming; downstream compression is Traefik's
 * with its `compress` middleware, exactly as it would be without the proxy.
 */

import type { Duplex } from "node:stream";
import { sendBlocked } from "./block-page.js";
import { connect as netConnect } from "node:net";
import { request as httpsRequest } from "node:https";
import { clientIp, evaluate, type GuardConfig } from "./authz.js";
import { decodeGuardRule, verifyEdgeOrigin } from "@polaris/core/waf";
import {
    EMAIL_DECODE_PATH,
    EMAIL_DECODE_SCRIPT,
    obfuscateEmailsInHtml
} from "@polaris/core";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** The header Traefik stamps with the signed upstream for a proxied route. */
export const ORIGIN_HEADER = "x-polaris-origin";

/**
 * The most HTML this will hold in memory to rewrite one response.
 *
 * A rewrite cannot stream: an address can straddle two chunks, and a `<script>` whose
 * opening tag is in one chunk and whose body is in the next would have its contents
 * rewritten by a scanner that only saw the second. So the body is buffered, and a body
 * past this size is streamed through untouched instead - a 16 MB HTML page is a data
 * dump, not a page with a contact address on it.
 */
const REWRITE_MAX_BYTES = 8 * 1024 * 1024;

/** Content types the rewrite applies to. Matches the same feature's documented scope,
 *  and for the same reason: anything else is not a document and rewriting it corrupts
 *  whatever is actually reading it. */
const HTML_TYPES = ["text/html", "application/xhtml+xml"];

/** Hop-by-hop headers, which belong to one connection and must not be forwarded onto
 *  the next (RFC 9110). Passing `connection` or `transfer-encoding` through is how a
 *  proxy ends up serving a truncated or double-chunked body. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
]);

/** First value of a request header (Node lower-cases header names). */
function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/** True when the response is HTML the rewrite is allowed to touch. */
function rewritable(res: IncomingMessage): boolean {
    if ((res.statusCode ?? 0) !== 200) return false;
    const type = String(res.headers["content-type"] ?? "").toLowerCase();
    if (!HTML_TYPES.some((entry) => type.startsWith(entry))) return false;
    // `no-transform` is the standard way for an origin to say a proxy must not alter
    // its payload. Honouring it is what keeps this from fighting an app that already
    // knows what it is doing.
    const cache = String(res.headers["cache-control"] ?? "").toLowerCase();
    if (cache.includes("no-transform")) return false;
    // A body the app already compressed is one this proxy asked not to receive. If it
    // arrives anyway, it is passed through rather than rewritten as if it were text.
    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
    return encoding === "" || encoding === "identity";
}

/** The headers to forward upstream, minus the ones that are this connection's. */
function upstreamHeaders(req: IncomingMessage, obfuscating: boolean): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        // The guard's own routing header never reaches the app.
        if (name === ORIGIN_HEADER) continue;
        out[name] = value;
    }
    // Ask for plain text when we intend to rewrite it, so there is nothing to
    // decompress. Left alone otherwise, so a passthrough route keeps the app's own
    // compression end to end.
    if (obfuscating) out["accept-encoding"] = "identity";
    return out;
}

/** A random byte, used as the XOR key so one address is not encoded identically on
 *  every page of the site. */
function freshKey(): number {
    return Math.floor(Math.random() * 256) & 0xff;
}

/** Serve the decoder. Cached hard: it is a constant, and it is fetched once per page
 *  by every visitor of every obfuscated route on the server. */
function serveDecodeScript(res: ServerResponse): void {
    res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400, immutable",
        "x-content-type-options": "nosniff"
    });
    res.end(EMAIL_DECODE_SCRIPT);
}

/** Copy an upstream response's headers onto the downstream one, dropping the
 *  hop-by-hop set and anything the caller is about to recompute. */
function downstreamHeaders(
    upstream: IncomingMessage,
    drop: readonly string[] = []
): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    const dropped = new Set(drop);
    for (const [name, value] of Object.entries(upstream.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || dropped.has(name)) continue;
        out[name] = value;
    }
    return out;
}

/**
 * Build the guard's proxy server.
 *
 * `config` is called per request so `now` (and any re-read of the environment) is
 * fresh, matching how the forwardAuth server is built.
 */
export function createProxyServer(config: () => GuardConfig): Server {
    const server = createServer((req, res) => {
        const cfg = config();
        const url = req.url ?? "/";

        if (url === "/health" || url.startsWith("/health?")) {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
            return;
        }
        if (url === EMAIL_DECODE_PATH || url.startsWith(`${EMAIL_DECODE_PATH}?`)) {
            serveDecodeScript(res);
            return;
        }

        const origin = verifyEdgeOrigin(header(req, ORIGIN_HEADER), cfg.secret);
        if (!origin) {
            // No verifiable upstream means this request reached the proxy without
            // Traefik's routing header, so there is nowhere legitimate to send it.
            res.writeHead(502, { "content-type": "text/plain" });
            res.end("Bad gateway");
            return;
        }

        // The same decision the forwardAuth path makes, on the same rule. A proxied
        // route is not a route with weaker rules; it is a route whose response also
        // gets rewritten.
        const wafHeader = header(req, "x-polaris-waf");
        const decision = evaluate(
            {
                wafHeader,
                forwardedFor: header(req, "x-forwarded-for"),
                forwardedProto: header(req, "x-forwarded-proto"),
                forwardedHost: header(req, "x-forwarded-host") ?? header(req, "host"),
                forwardedUri: url,
                forwardedMethod: req.method,
                userAgent: header(req, "user-agent"),
                accept: header(req, "accept"),
                acceptLanguage: header(req, "accept-language"),
                acceptEncoding: header(req, "accept-encoding"),
                cookie: header(req, "cookie")
            },
            cfg
        );
        if (decision.status === 403) {
            sendBlocked(res, {
                host: header(req, "x-forwarded-host") ?? header(req, "host"),
                ip: clientIp(header(req, "x-forwarded-for")),
                accept: header(req, "accept")
            });
            return;
        }
        if (decision.status === 302) {
            const headers: Record<string, string> = { location: decision.location };
            if (decision.setCookie) headers["set-cookie"] = decision.setCookie;
            res.writeHead(302, headers);
            res.end();
            return;
        }

        const obfuscating = decodeGuardRule(wafHeader).emailObfuscation === true;
        forward(req, res, origin, obfuscating);
    });

    // A WebSocket (or any other upgrade) cannot be rewritten and must not be broken by
    // sitting behind something that tries. It is spliced through at the socket level.
    server.on("upgrade", (req, clientSocket, head) => {
        const origin = verifyEdgeOrigin(header(req, ORIGIN_HEADER), config().secret);
        if (!origin) {
            clientSocket.destroy();
            return;
        }
        splice(req, clientSocket, head, origin);
    });

    return server;
}

/** Forward one request upstream and write the response back, rewriting the body when
 *  it is HTML and the route asked for it. */
function forward(req: IncomingMessage, res: ServerResponse, origin: string, obfuscating: boolean): void {
    const target = new URL(req.url ?? "/", origin);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    const upstream = send(
        {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers: upstreamHeaders(req, obfuscating)
        },
        (response) => {
            if (!obfuscating || !rewritable(response)) {
                res.writeHead(response.statusCode ?? 502, downstreamHeaders(response));
                response.pipe(res);
                return;
            }
            collectAndRewrite(response, res);
        }
    );

    upstream.on("error", () => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Bad gateway");
    });
    req.pipe(upstream);
}

/**
 * Buffer an HTML response, rewrite it, and write it back.
 *
 * The size cap is enforced as the body arrives rather than after it: the point is not
 * to refuse a large page but to stop holding it, so once the cap is passed what has
 * been collected is flushed and the rest is piped. The response therefore always
 * completes, whichever branch it takes.
 */
function collectAndRewrite(upstream: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let flushed = false;

    upstream.on("data", (chunk: Buffer) => {
        if (flushed) return;
        size += chunk.length;
        if (size > REWRITE_MAX_BYTES) {
            flushed = true;
            // Past the cap. Give up on rewriting, send what was held, and let the rest
            // stream - `content-length` is dropped because it may no longer describe
            // what is being sent.
            res.writeHead(upstream.statusCode ?? 200, downstreamHeaders(upstream, ["content-length"]));
            for (const held of chunks) res.write(held);
            res.write(chunk);
            upstream.pipe(res);
            return;
        }
        chunks.push(chunk);
    });

    upstream.on("end", () => {
        if (flushed) return;
        const body = Buffer.concat(chunks);
        let out = body;
        try {
            const rewritten = obfuscateEmailsInHtml(body.toString("utf8"), { key: freshKey() });
            // Nothing found means nothing to serve differently, script included: a page
            // with no address does not need a decoder on it.
            if (rewritten.replaced > 0) out = Buffer.from(injectDecoder(rewritten.html), "utf8");
        } catch {
            // Any failure serves the original bytes. This is a cosmetic feature and it
            // does not get to break a page.
            out = body;
        }
        const headers = downstreamHeaders(upstream, ["content-length"]);
        headers["content-length"] = String(out.length);
        res.writeHead(upstream.statusCode ?? 200, headers);
        res.end(out);
    });

    upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end();
    });
}

/** Put the decoder script into the document. Before `</body>` where there is one, and
 *  appended otherwise - a page that never closes its body is still a page a browser
 *  will run the script on. */
function injectDecoder(html: string): string {
    const tag = `<script defer src="${EMAIL_DECODE_PATH}"></script>`;
    const close = html.lastIndexOf("</body>");
    return close < 0 ? html + tag : html.slice(0, close) + tag + html.slice(close);
}

/** Splice an upgrade (WebSocket) straight through to the upstream, byte for byte. */
// Typed as a Duplex, which is what Node hands the `upgrade` listener: the client
// side may be a TLS socket rather than a plain one, and nothing here needs more than
// the stream.
function splice(req: IncomingMessage, clientSocket: Duplex, head: Buffer, origin: string): void {
    const target = new URL(req.url ?? "/", origin);
    const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
    const upstream = netConnect(port, target.hostname, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined || name === ORIGIN_HEADER) continue;
            for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`);
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
}

/**
 * HTTP wrapper for the edge guard. A thin marshaller: it turns Traefik's forwarded
 * request headers into a GuardRequest, calls the pure `evaluate`, and writes the
 * status back. `/health` is a liveness probe; every other path is treated as the
 * forwardAuth check, so Traefik can point at `/authz` (or any path) uniformly.
 */

import { evaluate, type GuardConfig } from "./authz.js";
import { createServer, type IncomingMessage, type Server } from "node:http";

/** First value of a request header (Node lower-cases header names). */
function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/** Build the guard's HTTP server. `config` is called per request so `now` (and any
 *  env re-read) is fresh on every check. */
export function createGuardServer(config: () => GuardConfig): Server {
    return createServer((req, res) => {
        const url = req.url ?? "/";
        if (url === "/health" || url.startsWith("/health?")) {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
            return;
        }
        const decision = evaluate(
            {
                wafHeader: header(req, "x-polaris-waf"),
                forwardedFor: header(req, "x-forwarded-for"),
                forwardedProto: header(req, "x-forwarded-proto"),
                forwardedHost: header(req, "x-forwarded-host"),
                forwardedUri: header(req, "x-forwarded-uri"),
                // Traefik forwards the original method as a header; the guard's own
                // request is always a GET, so `req.method` would say nothing.
                forwardedMethod: header(req, "x-forwarded-method"),
                userAgent: header(req, "user-agent"),
                cookie: header(req, "cookie")
            },
            config()
        );
        if (decision.status === 302) {
            const headers: Record<string, string> = { location: decision.location };
            if (decision.setCookie) headers["set-cookie"] = decision.setCookie;
            res.writeHead(302, headers);
            res.end();
            return;
        }
        if (decision.status === 403) {
            res.writeHead(403, { "content-type": "text/plain" });
            res.end("Forbidden");
            return;
        }
        res.writeHead(200);
        res.end();
    });
}

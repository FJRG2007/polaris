/**
 * The network half of a check: dial the target and report what came back, for
 * `model/checks.ts` to decide.
 *
 * Every connection resolves its name here and dials only an address
 * `addressAllowed` accepts, for every address the name answers with, at the
 * moment of connecting - so a name cannot pass the check and then answer with
 * another address. Redirects are not followed: a check reports the first answer,
 * which is what the operator's expected status is about. Bodies are read up to a
 * ceiling, only when a keyword asks for them.
 *
 * Server-only.
 */

import * as net from "node:net";
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { addressAllowed, clampTimeout, type CheckError, type CheckSpec, type ProbeResult } from "../model/checks";

/** How much of a body is read to look for a keyword. */
const BODY_CEILING = 64 * 1024;

const USER_AGENT = "Polaris-StatusCheck/1";

class Refused extends Error {
    constructor(readonly code: CheckError) {
        super(code);
    }
}

/** Resolves a name, refusing it when any address it answers with is not allowed. */
async function vetted(hostname: string): Promise<{ address: string; family: number }[]> {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bare)) {
        if (!addressAllowed(bare)) throw new Refused("blocked");
        return [{ address: bare, family: net.isIP(bare) }];
    }
    let found: dns.LookupAddress[];
    try {
        found = await dns.promises.lookup(bare, { all: true, verbatim: true });
    } catch {
        throw new Refused("unresolved");
    }
    if (found.length === 0) throw new Refused("unresolved");
    if (found.some((entry) => !addressAllowed(entry.address))) throw new Refused("blocked");
    return found.map((entry) => ({ address: entry.address, family: entry.family }));
}

/** A `lookup` for sockets that answers only with vetted addresses. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
    vetted(hostname).then(
        (addresses) => {
            if (options.all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
            callback(null, addresses[0]!.address, addresses[0]!.family);
        },
        (error: Error) => callback(error as NodeJS.ErrnoException, "", 0)
    );
};

function errorCode(caught: unknown): CheckError {
    if (caught instanceof Refused) return caught.code;
    const code = (caught as NodeJS.ErrnoException | null)?.code ?? "";
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
    if (code === "ECONNREFUSED" || code === "ECONNRESET") return "refused";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "unresolved";
    if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.includes("SELF_SIGNED")) return "tls";
    return "network";
}

function probeHttp(spec: CheckSpec, timeoutMs: number, started: number): Promise<ProbeResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: ProbeResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const fail = (caught: unknown) =>
            finish({ kind: "error", error: errorCode(caught), latencyMs: null });
        let url: URL;
        try {
            url = new URL(spec.target);
        } catch {
            return finish({ kind: "error", error: "network", latencyMs: null });
        }
        const client = url.protocol === "https:" ? https : http;
        const request = client.request(
            url,
            {
                method: "GET",
                lookup: guardedLookup,
                headers: { "user-agent": USER_AGENT, accept: "*/*" },
                agent: false
            },
            (response) => {
                const latencyMs = Date.now() - started;
                const status = response.statusCode ?? 0;
                if (!spec.keyword) {
                    response.destroy();
                    return finish({ kind: "http", status, body: "", latencyMs });
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                    chunks.push(chunk);
                    size += chunk.length;
                    if (size >= BODY_CEILING) response.destroy();
                });
                const done = () =>
                    finish({
                        kind: "http",
                        status,
                        body: Buffer.concat(chunks).subarray(0, BODY_CEILING).toString("utf8"),
                        latencyMs
                    });
                response.on("end", done);
                response.on("close", done);
                response.on("error", done);
            }
        );
        const timer = setTimeout(() => {
            request.destroy();
            finish({ kind: "error", error: "timeout", latencyMs: null });
        }, timeoutMs);
        request.on("error", fail);
        request.end();
    });
}

function probeTcp(host: string, port: number, timeoutMs: number, started: number): Promise<ProbeResult> {
    return new Promise((resolve) => {
        let settled = false;
        const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port, lookup: guardedLookup });
        const finish = (result: ProbeResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(
            () => finish({ kind: "error", error: "timeout", latencyMs: null }),
            timeoutMs
        );
        socket.once("connect", () => finish({ kind: "tcp", latencyMs: Date.now() - started }));
        socket.once("error", (caught) =>
            finish({ kind: "error", error: errorCode(caught), latencyMs: null })
        );
    });
}

async function probeDns(spec: CheckSpec, timeoutMs: number, started: number): Promise<ProbeResult> {
    const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
    const name = spec.target;
    try {
        let answers: string[];
        switch (spec.dnsType) {
            case "AAAA":
                answers = await resolver.resolve6(name);
                break;
            case "CNAME":
                answers = await resolver.resolveCname(name);
                break;
            case "MX":
                answers = (await resolver.resolveMx(name)).map((entry) => entry.exchange);
                break;
            case "TXT":
                answers = (await resolver.resolveTxt(name)).map((parts) => parts.join(""));
                break;
            default:
                answers = await resolver.resolve4(name);
        }
        return { kind: "dns", answers, latencyMs: Date.now() - started };
    } catch (caught) {
        const code = (caught as NodeJS.ErrnoException).code ?? "";
        if (code === "ENODATA" || code === "ENOTFOUND") {
            return { kind: "dns", answers: [], latencyMs: Date.now() - started };
        }
        return { kind: "error", error: code === "ETIMEOUT" ? "timeout" : "unresolved", latencyMs: null };
    }
}

/** Whether the check's host, when it is a literal address, may be dialed.
 *  A name is checked at connect time by `guardedLookup` instead. */
export function literalAllowed(spec: Pick<CheckSpec, "kind" | "target">): boolean {
    let host = spec.target;
    if (spec.kind === "http") {
        try {
            host = new URL(spec.target).hostname;
        } catch {
            return false;
        }
    }
    const bare = host.replace(/^\[|\]$/g, "");
    return !net.isIP(bare) || addressAllowed(bare);
}

/** Runs one check once. Never throws: every failure is a result. */
export async function probe(spec: CheckSpec): Promise<ProbeResult> {
    const timeoutMs = clampTimeout(spec.timeoutMs);
    const started = Date.now();
    try {
        // Node skips `lookup` when the host is already an address, so a typed
        // address is held to the same rule here, before any socket opens.
        if (spec.kind !== "dns" && !literalAllowed(spec)) {
            return { kind: "error", error: "blocked", latencyMs: null };
        }
        switch (spec.kind) {
            case "http":
                return await probeHttp(spec, timeoutMs, started);
            case "dns":
                return await probeDns(spec, timeoutMs, started);
            case "tcp":
            case "ping":
                return await probeTcp(spec.target, spec.port ?? 443, timeoutMs, started);
        }
    } catch (caught) {
        return { kind: "error", error: errorCode(caught), latencyMs: null };
    }
}

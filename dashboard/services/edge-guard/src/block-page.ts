/**
 * How the guard answers a block: the shared block page from `@polaris/core`, with the
 * request's own facts written into it.
 *
 * Only a client that asked for a document gets the document. An API call, a fetch or a
 * curl gets the same two facts as text, because a page of markup in a response body is
 * noise to everything that is not a browser.
 *
 * Every block is written to the guard's own log first, with the reference the visitor
 * is shown and the rule that decided. The page tells whoever was turned away to quote
 * that reference to the operator, and until this was here the operator had nothing to
 * look it up in: the reason was computed, put in a variable, and dropped. A firewall
 * whose false positives cannot be explained is a firewall nobody can tune - the address
 * that hit one first was the operator's own.
 */

import { randomUUID } from "node:crypto";
import { wafBlockPage } from "@polaris/core";
import type { ServerResponse } from "node:http";

/** The request facts the page shows. All of them arrive in headers. */
export interface BlockContext {
    /** The site the request was for. */
    readonly host?: string;
    /** The address the firewall judged (leftmost X-Forwarded-For). */
    readonly ip?: string | null;
    /** The visitor's Accept header, which decides page or plain text. */
    readonly accept?: string;
    /** What decided, as `evaluate` phrased it: the rule's own name, the intel entry,
     *  the injection signature. Logged, never shown - telling a scanner which
     *  signature caught it is telling it what to change. */
    readonly reason?: string;
    /** What was asked for, for the log line. */
    readonly uri?: string;
    readonly method?: string;
    readonly userAgent?: string;
}

/** True when the client asked for a document rather than data. */
function wantsDocument(accept: string | undefined): boolean {
    return (accept ?? "").toLowerCase().includes("text/html");
}

/**
 * Answer one refused request. Never cached: a shared cache holding this would keep
 * serving it to a visitor the rules no longer block, and to visitors they never did.
 */
export function sendBlocked(res: ServerResponse, ctx: BlockContext): void {
    const reference = randomUUID();
    const document = wantsDocument(ctx.accept);
    // One line, so `docker logs` and a grep for the reference answer the question the
    // block page tells the visitor to ask.
    console.log(
        JSON.stringify({
            event: "waf.block",
            reference,
            reason: ctx.reason ?? "unknown",
            ip: ctx.ip ?? null,
            host: ctx.host ?? null,
            uri: ctx.uri ?? null,
            method: ctx.method ?? null,
            userAgent: ctx.userAgent ?? null,
            at: new Date().toISOString()
        })
    );
    res.writeHead(403, {
        "content-type": document ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
    });
    res.end(
        document
            ? wafBlockPage({ reference, host: ctx.host, ip: ctx.ip })
            : `Blocked by the firewall.\nReference ID: ${reference}\n`
    );
}

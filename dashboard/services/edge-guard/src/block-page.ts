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

import { randomBytes, randomUUID } from "node:crypto";
import { wafBlockPage } from "@polaris/core";
import { createWafBlockLog } from "@polaris/core/waf";
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
    /** For an automatic ban that lifts: when, and where signing in lifts it now. */
    readonly release?: { readonly until: number | null; readonly signIn: string | null };
}

/** The most recent blocks, for the Firewall screen to look a reference up in. */
export const blockLog = createWafBlockLog();

/** True when the client asked for a document rather than data. */
function wantsDocument(accept: string | undefined): boolean {
    return (accept ?? "").toLowerCase().includes("text/html");
}

/** The same way out, for a client that reads text. */
function plainRelease(release: BlockContext["release"]): string {
    if (!release) return "";
    const lines: string[] = [];
    if (release.until !== null) lines.push(`Unblocked at: ${new Date(release.until).toISOString()}`);
    if (release.signIn) lines.push(`Signing in unblocks it now: ${release.signIn}`);
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
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
    const record = {
        reference,
        reason: ctx.reason ?? "unknown",
        ip: ctx.ip ?? null,
        host: ctx.host ?? null,
        uri: ctx.uri ?? null,
        method: ctx.method ?? null,
        userAgent: ctx.userAgent ?? null,
        at: new Date().toISOString()
    };
    console.log(JSON.stringify({ event: "waf.block", ...record }));
    blockLog.add(record);
    // The page's one script is its Try again button, allowed by this nonce and
    // nothing else.
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(403, {
        "content-type": document ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        ...(document
            ? {
                  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
              }
            : {}),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // A refusal is never something to show inside another site's page.
        "x-frame-options": "DENY"
    });
    res.end(
        document
            ? wafBlockPage({ reference, host: ctx.host, ip: ctx.ip, release: ctx.release, retryNonce: nonce })
            : `Blocked by the firewall.\nReference ID: ${reference}\n${plainRelease(ctx.release)}`
    );
}

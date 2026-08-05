/**
 * How the guard answers a block: the shared block page from `@polaris/core`, with the
 * request's own facts written into it.
 *
 * Only a client that asked for a document gets the document. An API call, a fetch or a
 * curl gets the same two facts as text, because a page of markup in a response body is
 * noise to everything that is not a browser.
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

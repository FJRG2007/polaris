/**
 * How the guard answers a visitor it wants proof of a browser from: the challenge page
 * from `@polaris/core`, with the puzzle it just issued written into it.
 *
 * 503 rather than 403, because nothing is refused - the site is asking for a moment -
 * and never cached, because the puzzle in the page is bound to this visitor's address
 * and to this minute.
 *
 * A client that did not ask for a document gets one line of text instead. It cannot
 * solve the page anyway, and markup in a response body is noise to everything that is
 * not a browser; an operator who wants a machine let through writes a rule that skips
 * the challenge for its path.
 */

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { wafChallengePage } from "@polaris/core";
import { EDGE_PASS_COOKIE, EDGE_PASS_TTL_SECONDS } from "@polaris/core/waf";

export interface ChallengeContext {
    readonly challenge: string;
    readonly bits: number;
    readonly host?: string;
    readonly ip?: string | null;
    readonly accept?: string;
    /** Whether the visitor is on https, so the pass cookie is marked Secure. */
    readonly secure: boolean;
}

export function sendChallenge(res: ServerResponse, ctx: ChallengeContext): void {
    const document = (ctx.accept ?? "").toLowerCase().includes("text/html");
    if (!document) {
        res.writeHead(503, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
        });
        res.end("This site is asking visitors to open it in a browser for a moment. Try again from a browser.\n");
        return;
    }
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // The page's own script and nothing else. Written here rather than left to the
        // site's headers, which never reach a response the guard answers itself.
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    });
    res.end(
        wafChallengePage({
            challenge: ctx.challenge,
            bits: ctx.bits,
            cookieName: EDGE_PASS_COOKIE,
            maxAge: EDGE_PASS_TTL_SECONDS,
            secure: ctx.secure,
            nonce,
            host: ctx.host,
            ip: ctx.ip
        })
    );
}

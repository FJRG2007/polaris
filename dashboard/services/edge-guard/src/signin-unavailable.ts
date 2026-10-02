/**
 * How the guard answers a visitor who has to sign in while the Polaris that signs them
 * in is unreachable: the shared page from `@polaris/core`, or the same facts as text for
 * a client that did not ask for a document. A 503 with `Retry-After`, because the
 * condition is temporary and the visitor is told to try again - and never cached, since
 * the same request succeeds the moment Polaris is back.
 */

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { SIGNIN_UNAVAILABLE_REFRESH_SECONDS, signInUnavailablePage } from "@polaris/core";

export function sendSignInUnavailable(res: ServerResponse, ctx: { host?: string; accept?: string }): void {
    const reference = randomUUID();
    const document = (ctx.accept ?? "").toLowerCase().includes("text/html");
    res.writeHead(503, {
        "content-type": document ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(SIGNIN_UNAVAILABLE_REFRESH_SECONDS),
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY"
    });
    res.end(
        document
            ? signInUnavailablePage({ host: ctx.host, reference })
            : `Sign-in is temporarily unavailable. If you were already signed in, try again.\nReference ID: ${reference}\n`
    );
}

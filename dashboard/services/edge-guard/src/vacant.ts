/**
 * How the guard answers for a hostname with nothing serving it.
 *
 * The edge reaches here two ways, and the page is the same object in both: a router of
 * last resort for a name in the wildcard zone that no app claims, and an error page for
 * an app router whose upstream refused the connection. Traefik rewrites the visitor's
 * path to one of the two vacant paths, and which one it picked is the only thing that
 * tells the cases apart from in here.
 *
 * It is served before the signed-origin check, unlike everything else on this listener:
 * there is no origin to sign, because the whole point is that there is nothing to
 * forward to.
 */

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
    VACANT_HEADER,
    VACANT_HEADER_VALUE,
    vacantCode,
    vacantPage,
    vacantStateForPath,
    vacantStatus
} from "@polaris/core";

/** The request facts the page shows. */
export interface VacantContext {
    /** The hostname that was asked for. */
    readonly host?: string;
    /** The visitor's Accept header, which decides page or plain text. */
    readonly accept?: string;
    /** The path the edge rewrote to, which carries which of the two states this is. */
    readonly path: string;
}

/** True when the client asked for a document rather than data. */
function wantsDocument(accept: string | undefined): boolean {
    return (accept ?? "").toLowerCase().includes("text/html");
}

/**
 * Answer one request for a name with nothing behind it. Never cached: a name is vacant
 * until the moment someone deploys on it, and a shared cache holding this would keep
 * serving it to the visitors of the app that just came up.
 */
export function sendVacant(res: ServerResponse, ctx: VacantContext): void {
    const reference = randomUUID();
    const state = vacantStateForPath(ctx.path);
    const document = wantsDocument(ctx.accept);
    res.writeHead(vacantStatus(state), {
        "content-type": document ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // Read by the control plane before it points the edge here, and by anything
        // else that needs to know this page came from Polaris rather than an app.
        [VACANT_HEADER]: VACANT_HEADER_VALUE
    });
    res.end(
        document
            ? vacantPage({ reference, host: ctx.host, state })
            : `${vacantCode(state)}\nReference ID: ${reference}\n`
    );
}

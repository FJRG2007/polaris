/**
 * How every `/api/polar/code/*` route answers: in the wire format `readPoll`
 * reads, never cached, and a refusal rather than a redirect when an Agents
 * action underneath decides the caller may not - a fetch cannot follow one.
 */

import { NextResponse } from "next/server";
import { toWire } from "@/lib/app-bundles/wire";
import { isRedirectError } from "next/dist/client/components/redirect-error";

const NO_STORE = { "cache-control": "no-store" };

export async function codeAnswer(
    read: () => Promise<unknown>,
    path: string
): Promise<NextResponse> {
    try {
        return NextResponse.json({ value: toWire(await read()) }, { headers: NO_STORE });
    } catch (caught) {
        if (isRedirectError(caught))
            // i18n-ignore: status bodies no screen shows; the caller keeps what it had
            return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
        console.error(`polaris: ${path} failed:`, caught);
        // i18n-ignore: as above
        return NextResponse.json({ error: "Failed" }, { status: 500, headers: NO_STORE });
    }
}

/** A request body as JSON, or null when it is not JSON at all. */
export async function jsonBody(request: Request): Promise<unknown> {
    try {
        return (await request.json()) as unknown;
    } catch {
        return null;
    }
}

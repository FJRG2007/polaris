/**
 * Where a crashing program reports to.
 *
 * The second endpoint in Polaris that anonymous outside traffic writes to, and
 * it is written to the same rules as the first one (`/api/analytics/collect`):
 * everything is bounded, the key names a project and proves nothing, and the
 * answer is the same whatever happened - a client that gets an error back
 * retries, and a retry storm from an application in a crash loop is how an
 * ingest takes the rest of the dashboard down with it.
 *
 * The path is the shape a Sentry client builds from a DSN, which is why it reads
 * oddly: given `https://<key>@<host>/api/telemetry/<n>`, every SDK posts to
 * `<host>/api/telemetry/api/<n>/envelope/`. That is the whole reason to speak
 * this protocol at all - the client already exists in every language, and
 * nothing about the application changes except one string.
 *
 * `envelope` is what current clients send and `store` is what older ones do.
 * Both end in the same place.
 */

import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit-service";
import { captureEvent } from "@/lib/telemetry/store";
import { projectForIngest } from "@/lib/telemetry/project-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reported from a browser, so the request is cross-origin by definition and the
 * preflight has to pass. Open, for the reason the analytics collector's is: this
 * endpoint reads nothing and returns nothing that is not already the caller's.
 */
const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-sentry-auth, x-requested-with",
    "access-control-max-age": "86400"
};

/** What one report may weigh. A stack with its source context and forty
 *  breadcrumbs is tens of kilobytes; past this is not an event. */
const MAX_BYTES = 1_000_000;

/** Per project, per minute. High enough for a service under real load, low
 *  enough that one crash loop cannot fill the table. */
const LIMIT = 600;
const WINDOW_MS = 60_000;

export function OPTIONS(): NextResponse {
    return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * The one answer.
 *
 * Accepted, refused, rate limited, unreadable and addressed to a project that
 * does not exist all look identical from outside - so this endpoint cannot be
 * used to find out which projects or which keys exist, and a client never has a
 * reason to retry.
 */
function accepted(eventId?: string | null): NextResponse {
    return NextResponse.json({ id: eventId ?? "" }, { status: 200, headers: CORS });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ projectId: string; kind: string }> }
): Promise<NextResponse> {
    const { projectId, kind } = await params;
    if (kind !== "envelope" && kind !== "store") return accepted();

    const number = Number.parseInt(projectId, 10);
    if (!Number.isSafeInteger(number) || number <= 0) return accepted();

    const length = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(length) && length > MAX_BYTES) return accepted();

    const body = await request.text().catch(() => "");
    if (!body || body.length > MAX_BYTES) return accepted();

    const url = new URL(request.url);
    // An envelope names its own DSN in the header, which is the third of the
    // three ways clients identify themselves and the only one available when a
    // proxy has stripped the query.
    const envelope = kind === "envelope" ? core.parseEnvelope(body) : null;
    const key = core.readIngestKey({
        query: url.searchParams.get("sentry_key"),
        header: request.headers.get("x-sentry-auth"),
        dsn: typeof envelope?.header.dsn === "string" ? envelope.header.dsn : null
    });
    if (!key) return accepted();

    const project = await projectForIngest(number, key);
    if (!project) return accepted();

    // Counted per project rather than per address: an application behind one
    // load balancer is one address, and a browser application is thousands.
    const limit = await rateLimit(`telemetry:${project.id}`, LIMIT, WINDOW_MS);
    if (!limit.ok) return accepted();

    const now = new Date();
    const payloads =
        envelope === null
            ? [safeJson(body)]
            : envelope.items
                  // A session, a transaction, a profile and a client report are
                  // all legitimate items on an envelope, and none of them is a
                  // failure. Reading them all and storing what turns out to be
                  // an event is cheaper than a list of types to keep in step.
                  .map((item) => item.payload);

    let stored: string | null = null;
    for (const payload of payloads) {
        const event = core.readEvent(payload, now);
        if (!event) continue;
        await captureEvent(project, event);
        stored ??= event.eventId;
    }
    return accepted(stored);
}

function safeJson(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

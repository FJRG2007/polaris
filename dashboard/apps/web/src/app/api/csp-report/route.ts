/**
 * Where browsers send what the report-only Content-Security-Policy would have
 * blocked (lib/integrity/csp). Logged as one line per report, kept to the
 * fields that say what to fix, so the policy can be enforced once these stop.
 *
 * No session: a browser sends these on its own. Bounded so nobody can use it
 * to fill the log: a capped body, and a cap on lines per minute per process.
 */

import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 16 * 1024;
const PER_MINUTE = 60;
let minuteSeen = 0;
let count = 0;

const field = z.string().max(2_048).optional();
const reportSchema = z.object({
    "csp-report": z.object({
        "document-uri": field,
        "violated-directive": field,
        "effective-directive": field,
        "blocked-uri": field,
        "source-file": field,
        "line-number": z.number().int().optional()
    })
});

/** A URL down to its origin and path: a query can carry a token. */
function bare(value: string | undefined): string {
    if (!value) return "";
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    } catch {
        return value.slice(0, 64);
    }
}

export async function POST(request: Request): Promise<Response> {
    const text = await request.text().catch(() => "");
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== minuteSeen) {
        minuteSeen = minute;
        count = 0;
    }
    if (text.length === 0 || text.length > MAX_BODY || ++count > PER_MINUTE) return new Response(null, { status: 204 });
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return new Response(null, { status: 204 });
    }
    const parsed = reportSchema.safeParse(raw);
    if (parsed.success) {
        const report = parsed.data["csp-report"];
        console.warn(
            `polaris: csp report-only: ${report["effective-directive"] ?? report["violated-directive"] ?? "?"} blocked ${bare(report["blocked-uri"]) || "inline"} on ${bare(report["document-uri"])}${report["source-file"] ? ` from ${bare(report["source-file"])}:${report["line-number"] ?? ""}` : ""}`
        );
    }
    return new Response(null, { status: 204 });
}

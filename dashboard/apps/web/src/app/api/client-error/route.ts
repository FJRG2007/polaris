/**
 * Where a page that could not be drawn says what it failed with
 * (`app/global-error.tsx`). Without it a failure in the browser leaves nothing
 * in the server's log, and "the page broke" cannot be told apart from a page
 * that never reached the server.
 *
 * Logged as one line, kept to what says where to look: the error's name, its
 * first line, the digest, the page's path and the first frames of the stack,
 * each address cut to its path and anything that reads like an address, a
 * token or a long number masked. No session: the page sending this may be the
 * one that failed to read it. Bounded like `/api/csp-report`: a capped body and
 * a cap on lines per minute per process.
 */

import { clientErrorLine, clientErrorSchema } from "@/lib/client-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 16 * 1024;
const PER_MINUTE = 30;
let minuteSeen = 0;
let count = 0;

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
    const parsed = clientErrorSchema.safeParse(raw);
    if (parsed.success) console.error(clientErrorLine(parsed.data));
    return new Response(null, { status: 204 });
}

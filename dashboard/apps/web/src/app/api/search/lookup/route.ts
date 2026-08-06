/**
 * One scoped search, for the commands that cannot be answered from the index the
 * palette already holds.
 *
 * `GET /api/search/lookup?scope=tasks&q=orphion`. The scope is required and
 * closed: there is no "search everything" here, because running four searches
 * for a name somebody was halfway through typing is exactly what the commands
 * exist to avoid. Callers debounce, drop stale replies and keep the answer for a
 * moment, so a request per scope per pause is what actually reaches this.
 *
 * Node runtime for Prisma.
 */

import { requireUser } from "@/lib/session";
import { searchLookupSchema } from "@polaris/core";
import { lookup } from "@/lib/search/lookup-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const parsed = searchLookupSchema.safeParse({ scope: params.get("scope"), query: params.get("q") ?? "" });
    if (!parsed.success) {
        return Response.json({ error: parsed.error.issues[0]?.message ?? "Unknown scope" }, { status: 400 });
    }

    try {
        return Response.json({ hits: await lookup(user, parsed.data) });
    } catch (caught) {
        console.error(caught);
        return Response.json({ error: "That search could not be run" }, { status: 500 });
    }
}

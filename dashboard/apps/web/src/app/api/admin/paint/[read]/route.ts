// a Management region's data, asked for after its shell paints. A route, not an
// action: see app/(app)/admin/paint-reads.
import { NextResponse } from "next/server";
import { pollRoute } from "@/lib/poll-route";
import { apiAdmin, apiPermission } from "@/lib/api-session";
import { PAINT_READS, type PaintReadName } from "@/app/(app)/admin/paint-reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTES = new Map(
    Object.entries(PAINT_READS).map(([name, entry]) => [
        name as PaintReadName,
        {
            inbox: entry.inbox,
            answer: pollRoute(entry.query, entry.run as (input: unknown) => Promise<unknown>, {
                sameOrigin: true
            })
        }
    ])
);

export async function GET(
    request: Request,
    { params }: { params: Promise<{ read: string }> }
): Promise<Response> {
    const route = ROUTES.get((await params).read as PaintReadName);
    // i18n-ignore: status body no screen shows; the region offers to ask again
    if (!route)
        return NextResponse.json(
            { error: "Not found" },
            { status: 404, headers: { "cache-control": "no-store" } }
        );
    // Operator only, or whoever answers the inbox for its reads, said here as
    // every admin route says it; the action checks again.
    const refused = route.inbox ? await apiPermission("inbox.read") : await apiAdmin();
    if (refused instanceof Response) return refused;
    return route.answer(request);
}

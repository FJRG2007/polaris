/**
 * The protected things, filtered and paged.
 *
 * A route rather than a server component read, because the console paints its
 * shell first and fetches the rows after: a table of hundreds that blocked the
 * navigation would make every visit wait on the slowest query on the page.
 *
 * Admin-only. A backup reaches every app's data, so listing them is not
 * something a viewer of one app should be able to do. Node runtime for Prisma.
 */

import { listResources } from "@/lib/backups/manage";
import { apiAdmin } from "@/lib/api-session";
import { listResourcesSchema } from "@/lib/backups/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const params = new URL(request.url).searchParams;
    const parsed = listResourcesSchema.safeParse({
        query: params.get("query") || undefined,
        kind: params.get("kind") || undefined,
        planId: params.get("planId") || undefined,
        status: params.get("status") || undefined,
        cursor: params.get("cursor") || undefined,
        limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        sort: params.get("sort") || undefined,
        direction: params.get("direction") || undefined
    });
    if (!parsed.success) {
        return Response.json({ error: "Those filters are not valid." }, { status: 400 });
    }
    return Response.json(await listResources(user.id, parsed.data));
}

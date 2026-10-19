/**
 * One UPS's event log, newest first, a page at a time (`?before=` the oldest
 * time shown), filtered by `?kinds=ONBATT,LOWBATT`, `?state=open` and
 * `?days=`. Read by the Events and Battery tabs while they are open.
 */

import * as upsData from "@/lib/ups/ups-data";
import * as upsEvents from "@/lib/ups/ups-events";
import { badRequest, upsAdmin, upsFromPath } from "../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    const user = await upsAdmin();
    if (user instanceof Response) return user;
    const row = await upsFromPath(params);
    if (row instanceof Response) return row;
    const query = upsEvents.upsEventQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!query.success) return badRequest();
    return Response.json(await upsData.listEvents(row.id, query.data));
}

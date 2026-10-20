/**
 * One UPS's event log, newest first, a page at a time (`?before=` the oldest
 * time shown), filtered by `?kinds=ONBATT,LOWBATT`, `?state=open` and
 * `?days=`. Read by the Events and Battery tabs while they are open.
 */

import * as upsData from "@/lib/ups/ups-data";
import * as upsEvents from "@/lib/ups/ups-events";
import { badRequest, upsReached } from "../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    const reached = await upsReached(params, "watch");
    if (reached instanceof Response) return reached;
    const { row } = reached;
    const query = upsEvents.upsEventQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!query.success) return badRequest();
    return Response.json(await upsData.listEvents(row.id, query.data));
}

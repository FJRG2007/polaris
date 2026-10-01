/** Search every calendar the reader reads, across all time. */

import { z } from "zod";
import { searchEvents } from "../../../../lib/search";
import { isKnownZone } from "../../../../lib/schemas";
import { apiCalendarUser } from "../../../../lib/access";

const query = z.object({
    q: z.string().trim().min(2).max(200),
    zone: z.string().max(64).refine(isKnownZone)
});

export async function GET(request: Request): Promise<Response> {
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ hits: [] });
    try {
        const hits = await searchEvents(user, parsed.data.q, { floatingZone: parsed.data.zone, now: new Date() });
        return Response.json({ hits }, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        console.error("polaris: a calendar search failed:", caught);
        return Response.json({ error: "unavailable" }, { status: 500 });
    }
}

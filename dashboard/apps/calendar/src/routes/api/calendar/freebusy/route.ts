/**
 * Free/busy for people: POST `{ emails?, userIds?, from, to, zone,
 * durationMinutes? }` answers each person's busy intervals - never a title -
 * and, when a length is given, times everybody is free and at work. Only
 * people the reader may look up are answered; everybody else is `unavailable`.
 */

import { freeBusy } from "../../../../lib/freebusy";
import { apiCalendarUser } from "../../../../lib/access";
import { freeBusyRequestSchema } from "../../../../lib/scheduling-schemas";

export async function POST(request: Request): Promise<Response> {
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "body" }, { status: 400 });
    }
    const parsed = freeBusyRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "input" }, { status: 400 });
    try {
        const view = await freeBusy(user, { ...parsed.data, from: new Date(parsed.data.from), to: new Date(parsed.data.to) });
        return Response.json(view, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        console.error("polaris: free/busy could not be answered:", caught);
        return Response.json({ error: "unavailable" }, { status: 500 });
    }
}

/**
 * Downloads: a whole calendar (`/api/calendar/export/<calendarId>`) or one
 * event (`/api/calendar/export/event/<objectId>`) as an .ics file, or all of
 * one's own calendars and booking pages as a zip (`/api/calendar/export/all`).
 */

import { z } from "zod";
import { apiCalendarUser } from "../../../../../lib/access";
import { CalendarRefusal } from "../../../../../lib/errors";
import { exportCalendar, exportEvent, fileName } from "../../../../../lib/transfer";
import { exportEverything } from "../../../../../lib/export-all";

const id = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    const { path = [] } = await context.params;
    if (path.length === 1 && path[0] === "all") {
        try {
            const bytes = await exportEverything(user);
            return new Response(bytes, {
                headers: {
                    "content-type": "application/zip",
                    "content-disposition": 'attachment; filename="calendars.zip"',
                    "cache-control": "no-store"
                }
            });
        } catch (caught) {
            console.error("polaris: the calendar export failed:", caught);
            return new Response(null, { status: 500 });
        }
    }
    const event = path[0] === "event";
    const parsed = id.safeParse(event ? path[1] : path[0]);
    if (!parsed.success || path.length !== (event ? 2 : 1)) return new Response(null, { status: 404 });
    try {
        const file = event ? await exportEvent(user, parsed.data) : await exportCalendar(user, parsed.data);
        return new Response(file.ics, {
            headers: {
                "content-type": "text/calendar; charset=utf-8",
                "content-disposition": `attachment; filename="${fileName(file.name, "ics")}"`,
                "cache-control": "no-store"
            }
        });
    } catch (caught) {
        if (caught instanceof CalendarRefusal) return new Response(null, { status: 404 });
        console.error("polaris: a calendar export failed:", caught);
        return new Response(null, { status: 500 });
    }
}

/**
 * What the calendar draws between two instants: its occurrences and the tasks
 * due inside it. Asked by the browser for exactly the window on screen, so a
 * month view never pulls a year; the window is validated and capped.
 */

import { z } from "zod";
import { isKnownZone } from "../../../../lib/schemas";
import { apiCalendarUser } from "../../../../lib/access";
import { addressesOf, MAX_WINDOW_DAYS, occurrencesIn } from "../../../../lib/occurrences";

const query = z
    .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        zone: z.string().max(64).refine(isKnownZone),
        calendars: z
            .string()
            .max(20_000)
            .transform((value) => (value ? value.split(",") : []))
            .pipe(z.array(z.string().uuid()).max(500))
            .optional(),
        tasks: z.enum(["0", "1"]).default("1")
    })
    .transform((value) => ({ ...value, from: new Date(value.from), to: new Date(value.to) }))
    .refine((value) => value.to > value.from)
    .refine((value) => value.to.getTime() - value.from.getTime() <= MAX_WINDOW_DAYS * 86_400_000);

export async function GET(request: Request): Promise<Response> {
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    const url = new URL(request.url);
    const parsed = query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return Response.json({ error: "window" }, { status: 400 });
    try {
        const view = await occurrencesIn(
            user,
            { from: parsed.data.from, to: parsed.data.to },
            {
                floatingZone: parsed.data.zone,
                calendarIds: parsed.data.calendars,
                emails: await addressesOf(user),
                includeTasks: parsed.data.tasks === "1"
            }
        );
        return Response.json(view, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        console.error("polaris: the calendar window could not be read:", caught);
        return Response.json({ error: "unavailable" }, { status: 500 });
    }
}

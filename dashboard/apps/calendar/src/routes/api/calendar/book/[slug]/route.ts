/**
 * The slots a booking page offers, for its public page: GET
 * `/api/calendar/book/<slug>?from=&to=`. No session - the page is public - and
 * rate limited per address. Nothing about the owner's calendars is in the
 * answer: only the instants a visitor may pick.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { MAX_SLOT_WINDOW_DAYS, publicSlots } from "../../../../../lib/booking";

const window = z
    .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true })
    })
    .transform((value) => ({ from: new Date(value.from), to: new Date(value.to) }))
    .refine((value) => value.to > value.from)
    .refine(
        (value) => value.to.getTime() - value.from.getTime() <= MAX_SLOT_WINDOW_DAYS * 86_400_000
    );

/** Requests one address may make per minute: a visitor paging through weeks. */
const PER_MINUTE = 60;

export async function GET(
    request: Request,
    context: { params: Promise<{ slug: string }> }
): Promise<Response> {
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    const limited = await host.rateLimitService.rateLimit(
        `calendar.book-slots:${ip}`,
        PER_MINUTE,
        60_000
    );
    if (!limited.ok) return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    const { slug } = await context.params;
    const parsed = window.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "window" }, { status: 400 });
    try {
        const slots = await publicSlots(slug, parsed.data);
        if (!slots) return new Response(null, { status: 404 });
        return Response.json({ slots }, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        console.error("polaris: a booking page's slots could not be read:", caught);
        return Response.json({ error: "unavailable" }, { status: 500 });
    }
}

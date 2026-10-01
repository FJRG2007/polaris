/**
 * A published calendar, by its link: `feed.ics` for subscribing, `range` for
 * the public page and the embed. No session - the token is the whole of the
 * right to read it - and rate limited per address, since it is open to anybody.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { calendarTIn } from "../../../../../../lib/i18n";
import { fileName } from "../../../../../../lib/transfer";
import { isKnownZone } from "../../../../../../lib/schemas";
import { MAX_WINDOW_DAYS } from "../../../../../../lib/occurrences";
import { publishedFeed, publishedRange } from "../../../../../../lib/published";

const window = z
    .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        zone: z.string().max(64).refine(isKnownZone)
    })
    .transform((value) => ({ ...value, from: new Date(value.from), to: new Date(value.to) }))
    .refine((value) => value.to > value.from)
    .refine((value) => value.to.getTime() - value.from.getTime() <= MAX_WINDOW_DAYS * 86_400_000);

/** Requests one address may make to published calendars per minute. A
 *  subscribing client asks every few hours; a page, once per view. */
const PER_MINUTE = 120;

async function allowed(): Promise<boolean> {
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    const result = await host.rateLimitService.rateLimit(
        `calendar.public:${ip}`,
        PER_MINUTE,
        60_000
    );
    return result.ok;
}

export async function GET(
    request: Request,
    context: { params: Promise<{ token: string; path?: string[] }> }
): Promise<Response> {
    if (!(await allowed()))
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    const { token, path = [] } = await context.params;
    const what = path.join("/");
    try {
        if (what === "feed.ics") {
            const locale = await host.i18nRequest.getLocale();
            const feed = await publishedFeed(token, calendarTIn(locale)("published.busy"));
            if (!feed) return new Response(null, { status: 404 });
            return new Response(feed.ics, {
                headers: {
                    "content-type": "text/calendar; charset=utf-8",
                    "content-disposition": `inline; filename="${fileName(feed.name, "ics")}"`,
                    "cache-control": "private, max-age=300"
                }
            });
        }
        if (what === "range") {
            const parsed = window.safeParse(Object.fromEntries(new URL(request.url).searchParams));
            if (!parsed.success) return Response.json({ error: "window" }, { status: 400 });
            const view = await publishedRange(
                token,
                { from: parsed.data.from, to: parsed.data.to },
                parsed.data.zone
            );
            if (!view) return new Response(null, { status: 404 });
            return Response.json(view, { headers: { "cache-control": "no-store" } });
        }
        return new Response(null, { status: 404 });
    } catch (caught) {
        console.error("polaris: a published calendar could not be read:", caught);
        return new Response(null, { status: 500 });
    }
}

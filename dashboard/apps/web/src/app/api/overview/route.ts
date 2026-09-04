/**
 * The Overview's data, for the cards that need the server to answer them.
 *
 * A route rather than part of the page render, because the point of the Overview
 * is that it is there the instant you sign in: the grid, its headings and its
 * card frames come down with the HTML, and the figures arrive behind them. A
 * monitoring read held in front of the navigation would make the landing screen
 * the slowest one in Polaris.
 *
 * The caller says which cards it is drawing and gets those; every one of them is
 * still checked against the permission its own screen requires, so asking for a
 * card you cannot see returns nothing rather than somebody else's numbers.
 * Node runtime for Prisma.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";

import { OVERVIEW_WIDGET_IDS } from "@polaris/core";
import { getOverviewData } from "@/lib/overview/overview-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    /** Comma-separated card ids. Unknown ids are dropped rather than refused: a
     *  browser left open across a release should get the cards it still knows
     *  about, not an error. */
    widgets: z
        .string()
        .max(400)
        .transform((value) =>
            value
                .split(",")
                .map((id) => id.trim())
                .filter((id): id is (typeof OVERVIEW_WIDGET_IDS)[number] =>
                    (OVERVIEW_WIDGET_IDS as readonly string[]).includes(id)
                )
        )
        .default("")
});

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const parsed = querySchema.safeParse({
        widgets: new URL(request.url).searchParams.get("widgets") ?? ""
    });
    if (!parsed.success) return Response.json({ error: "Unsupported request" }, { status: 400 });

    return Response.json(await getOverviewData(user, parsed.data.widgets));
}

/**
 * GET /api/polar/search?q=<words>&page=<n> - the signed-in person's Polar
 * chats whose title or message text holds the words, newest first, twenty a
 * page. Archived chats are included and say so.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { searchPolarThreads } from "@/lib/polar/threads";
import { POLAR_SEARCH_PAGES, searchTextSchema } from "@/lib/polar/shared";

export const dynamic = "force-dynamic";

const querySchema = z.object({
    q: searchTextSchema,
    page: z.coerce
        .number()
        .int()
        .min(0)
        .max(POLAR_SEARCH_PAGES - 1)
        .default(0)
});

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-search:${user.id}`, 60, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    return NextResponse.json(await searchPolarThreads(user.id, query.data.q, query.data.page));
}

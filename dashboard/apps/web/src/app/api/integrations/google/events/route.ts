/**
 * The signed-in account's Google Calendar events for one window.
 *
 * The calendar screen asks for exactly the days it is drawing, so a month view
 * never pulls a year. The window is validated and capped: an unbounded range
 * would be a way to make this deployment hammer Google on somebody else's quota.
 *
 * Answers 200 with a status in every case, including "you have not linked an
 * account" - the screen turns that into a Connect button, and a 4xx here would
 * only make a normal state look like a failure in the console.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { listConnections, readCredential } from "@/lib/connections/store";
import { getGoogleOAuthClient, listGoogleEvents, GoogleAuthExpiredError } from "@/lib/google-calendar/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The widest window worth answering: a month view spans six weeks, and nothing
 *  on screen asks for more. */
const MAX_DAYS = 70;

const rangeSchema = z
    .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true })
    })
    .transform((value) => ({ from: new Date(value.from), to: new Date(value.to) }))
    .refine((range) => range.to > range.from, "The window ends before it starts.")
    .refine(
        (range) => range.to.getTime() - range.from.getTime() <= MAX_DAYS * 24 * 60 * 60 * 1000,
        `A window may not exceed ${MAX_DAYS} days.`
    );

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    const url = new URL(request.url);
    const parsed = rangeSchema.safeParse({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
    if (!parsed.success) {
        return NextResponse.json({ status: "error", error: "Unreadable window.", events: [] }, { status: 400 });
    }

    const client = await getGoogleOAuthClient();
    if (!client) return NextResponse.json({ status: "unavailable", events: [] });

    // The first Google account this person linked. One is the limit today, and a
    // second would be a choice of which calendar to draw rather than both.
    const [connection] = await listConnections(user.id, "google");
    if (!connection) return NextResponse.json({ status: "unlinked", events: [] });

    // Linked, but with nothing that can mint a fresh access token - a credential
    // that could not be decrypted, or an authorization Google issued no refresh
    // token for. Either way the fix is to authorize again, not to link a first
    // time, so the screen is told the difference.
    const refreshToken = (await readCredential(connection.id))?.refreshToken;
    if (!refreshToken) return NextResponse.json({ status: "expired", events: [] });

    try {
        const events = await listGoogleEvents(client, refreshToken, parsed.data.from, parsed.data.to);
        return NextResponse.json({ status: "ready", events });
    } catch (caught) {
        if (caught instanceof GoogleAuthExpiredError) {
            return NextResponse.json({ status: "expired", events: [] });
        }
        // The reason stays in the server log; the screen is told the calendar
        // could not be reached, which is all it can act on.
        console.error("google calendar events failed", caught);
        return NextResponse.json({ status: "error", error: "Google Calendar could not be reached.", events: [] });
    }
}

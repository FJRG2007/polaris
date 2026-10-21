/**
 * New mail since a tab last asked, for the notice the system draws.
 *
 * Asked by the one tab per device that holds the live channel, when a frame
 * says a mailbox moved and the tab is not being looked at. The answer names the
 * newest few and counts the rest, narrowed to the caller's own mailboxes with
 * "Notify me" on - see `arrivals`. The cursor is validated here and handed out
 * by the server, never trusted from a clock in a browser. In do not disturb
 * the cursor still moves and nothing is named, so the mail that arrived during
 * a call is not announced the moment it ends.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { arrivalsSince } from "@/lib/mailbox/arrivals";
import { doNotDisturbOf } from "@/lib/presence-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    since: z
        .string()
        .max(40)
        // i18n-ignore never shown: an unreadable cursor is treated as a first ask
        .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Not a moment" })
        .transform((value) => new Date(value))
        .nullable()
});

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const parsed = querySchema.safeParse({
        since: new URL(request.url).searchParams.get("since")
    });
    // A cursor that is not one is a first ask: a fresh cursor and no notices,
    // rather than an error the tab would have to handle for nobody's benefit.
    const since = parsed.success ? parsed.data.since : null;
    const [answer, quiet] = await Promise.all([
        arrivalsSince(user.id, since),
        since
            ? doNotDisturbOf(user.id)
                  .then((view) => view.on)
                  .catch(() => false)
            : false
    ]);
    return NextResponse.json(quiet ? { ...answer, named: [], more: 0 } : answer, {
        headers: { "cache-control": "private, no-store" }
    });
}

/**
 * The caller's own activity, read after the screen has painted.
 *
 * Scoped to the signed-in user in the query itself, so this returns one
 * account's history and no amount of guessing at the session parameter reaches
 * another's - an id that is not theirs simply matches nothing.
 *
 * The sessions the history was written from come back with it, named where the
 * session is still live. They are resolved unfiltered even when the entries are
 * narrowed, or choosing a session would collapse the list that offers the others.
 * Node runtime for Prisma.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { NextResponse } from "next/server";

import { sessionDeviceLabels } from "@/lib/session-device";
import { listUserActivity, listUserActivitySessions } from "@/lib/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The filter value standing for everything that came from no session at all. */
const NO_SESSION = "none";

/** Bounded so one request can never ask for the whole log. */
const querySchema = z.object({
    session: z.union([z.string().uuid(), z.literal(NO_SESSION)]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200)
});

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;

    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    }

    const { session, limit } = parsed.data;
    // Absent asks for everything; "none" asks for the entries stamped with no
    // session, which is a filter and not the absence of one.
    const sessionId = session === NO_SESSION ? null : session;
    const [items, groups, labels] = await Promise.all([
        listUserActivity(user.id, { sessionId, limit }),
        listUserActivitySessions(user.id),
        sessionDeviceLabels(user.id)
    ]);

    const sessions = groups.map((group) => ({
        id: group.id ?? NO_SESSION,
        // Null once the session has ended: nothing is left to name it by.
        label: group.id === null ? null : (labels.get(group.id) ?? null),
        current: group.id === user.sessionId,
        lastAt: group.lastAt as string | null
    }));

    // A session that has done nothing yet has no group of its own, and arriving
    // from its row would otherwise land on a filter the list cannot name.
    if (session !== undefined && !sessions.some((option) => option.id === session)) {
        sessions.unshift({
            id: session,
            label: sessionId === null ? null : (labels.get(session) ?? null),
            current: session === user.sessionId,
            lastAt: null
        });
    }

    return NextResponse.json({ items, sessions });
}

/**
 * The caller's own activity, a page at a time, read after the screen has painted.
 *
 * Scoped to the signed-in user in the query itself, so this returns one
 * account's history and no amount of guessing at the session parameter reaches
 * another's - an id that is not theirs simply matches nothing. The narrowing is
 * the same as every other audit screen's; the session filter is this one's own.
 *
 * The sessions the history was written from come back with the first page, named
 * where the session is still live. They are resolved unfiltered even when the
 * entries are narrowed, or choosing a session would collapse the list that
 * offers the others. Node runtime for Prisma.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { sessionDeviceLabels } from "@/lib/session-device";
import { auditFacets, queryAudit } from "@/lib/audit-query";
import { listUserActivitySessions } from "@/lib/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The filter value standing for everything that came from no session at all. */
const NO_SESSION = "none";

const sessionSchema = z.union([z.string().uuid(), z.literal(NO_SESSION)]).optional();

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;

    const { session: rawSession, ...query } = Object.fromEntries(new URL(request.url).searchParams);
    const session = sessionSchema.safeParse(rawSession || undefined);
    const filter = core.auditFilterSchema.safeParse(query);
    if (!session.success || !filter.success) {
        const issue = (!session.success ? session.error : filter.error)?.issues[0];
        return NextResponse.json({ error: issue?.message ?? "Invalid request" }, { status: 400 });
    }

    // Absent asks for everything; "none" asks for the entries stamped with no
    // session, which is a filter and not the absence of one.
    const sessionId = session.data === NO_SESSION ? null : session.data;
    const scope = { kind: "user" as const, userId: user.id, sessionId };
    const first = !filter.data.cursor;

    const [page, facets, groups, labels] = await Promise.all([
        queryAudit(scope, filter.data),
        first ? auditFacets({ kind: "user", userId: user.id }) : Promise.resolve(undefined),
        first ? listUserActivitySessions(user.id) : Promise.resolve(undefined),
        first ? sessionDeviceLabels(user.id) : Promise.resolve(undefined)
    ]);
    if (!first || !groups || !labels) return NextResponse.json(page);

    const sessions = groups.map((group) => ({
        id: group.id ?? NO_SESSION,
        // Null once the session has ended: nothing is left to name it by.
        label: group.id === null ? null : (labels.get(group.id) ?? null),
        current: group.id === user.sessionId,
        lastAt: group.lastAt as string | null
    }));

    // A session that has done nothing yet has no group of its own, and arriving
    // from its row would otherwise land on a filter the list cannot name.
    if (session.data !== undefined && !sessions.some((option) => option.id === session.data)) {
        sessions.unshift({
            id: session.data,
            label: sessionId === null ? null : (labels.get(session.data) ?? null),
            current: session.data === user.sessionId,
            lastAt: null
        });
    }

    return NextResponse.json({ ...page, facets, sessions });
}

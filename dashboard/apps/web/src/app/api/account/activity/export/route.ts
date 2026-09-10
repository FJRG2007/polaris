/**
 * The caller's own history as a file, narrowed the way the screen is - including
 * to one session, which is how somebody hands over "everything done from that
 * laptop" after losing it. Scoped to the caller in the query; recorded in the
 * trail like every export. Node runtime for Prisma.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { auditExportResponse } from "@/lib/audit-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_SESSION = "none";
const sessionSchema = z.union([z.string().uuid(), z.literal(NO_SESSION)]).optional();

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const session = sessionSchema.safeParse(new URL(request.url).searchParams.get("session") || undefined);
    if (!session.success) return NextResponse.json({ error: "Not a session" }, { status: 400 });

    // The session parameter is read here and nowhere else, so stripping it from
    // the URL leaves the narrowing the shared parser knows.
    const url = new URL(request.url);
    url.searchParams.delete("session");
    return auditExportResponse(
        new Request(url, request),
        {
            kind: "user",
            userId: user.id,
            ...(session.data === undefined ? {} : { sessionId: session.data === NO_SESSION ? null : session.data })
        },
        { label: "my", actorId: user.id }
    );
}

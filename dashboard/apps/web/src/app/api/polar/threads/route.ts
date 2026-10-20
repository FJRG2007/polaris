/**
 * GET /api/polar/threads - the signed-in person's conversations with Polar,
 * fifty at a time (`?cursor=<id>` for the next page), with `more` saying
 * whether another page exists.
 *
 * With no `view`, what the sidebar opens on in one round trip: the first page
 * of recents (chats that are not pinned, archived or in a project) as
 * `threads` and `more`, the first page of `pinned` and `morePinned`, and
 * `projects`. With `view=recent|pinned|archived`, or
 * `view=project&project=<id>`, that one list as `threads` and `more`.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { THREAD_VIEWS } from "@/lib/polar/shared";
import { listPolarThreads, polarSidebar } from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

const querySchema = z
    .object({
        cursor: z.string().uuid().optional(),
        view: z.enum(THREAD_VIEWS).optional(),
        project: z.string().uuid().optional()
    })
    .refine((query) => (query.view === "project") === (query.project !== undefined));

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const { cursor, view, project } = query.data;
    if (!view && !cursor) return NextResponse.json(await polarSidebar(user.id));
    return NextResponse.json(await listPolarThreads(user.id, cursor, view ?? "recent", project));
}

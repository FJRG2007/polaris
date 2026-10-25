/**
 * POST /api/polar/threads/bulk - one action on a selection of the signed-in
 * person's chats: delete them, archive them, or file them under a project (or
 * take them out of one). At most `POLAR_BULK_MAX` ids, each once. Another
 * person's id is left alone and not counted; another person's project answers
 * 404, as a single chat's PATCH does.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { stopPolarRun } from "@/lib/polar/runs";
import { polarBulkSchema } from "@/lib/polar/shared";
import { changePolarThreads, deletePolarThreads } from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const body = polarBulkSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const { ids } = body.data;
    if (body.data.action === "delete") {
        // An answer still running in a deleted chat has nowhere left to go.
        for (const id of ids) stopPolarRun(user.id, id);
        return NextResponse.json({ count: await deletePolarThreads(user.id, ids) });
    }
    const count = await changePolarThreads(
        user.id,
        ids,
        body.data.action === "archive"
            ? { kind: "archive" }
            : { kind: "move", projectId: body.data.projectId }
    );
    if (count === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ count });
}

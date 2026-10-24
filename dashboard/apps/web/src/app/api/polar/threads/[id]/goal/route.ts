/**
 * GET    /api/polar/threads/:id/goal - the chat's /goal, or `{ goal: null }`.
 * DELETE /api/polar/threads/:id/goal - clears it; answers with the one cleared,
 *        or `{ goal: null }` when there was none.
 *
 * A goal is set by the chat message that names it (`api/polar/chat`), so its
 * first turn starts with it. Owner-scoped: another person's thread reads as
 * having no goal.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { clearPolarGoal, polarGoal } from "@/lib/polar/goal-store";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

async function caller(params: Params["params"]) {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-goal:${user.id}`, 60, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    return { user, threadId: id.data };
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const found = await caller(params);
    if (found instanceof NextResponse) return found;
    const goal = await polarGoal(found.user.id, found.threadId);
    return NextResponse.json({ goal }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const found = await caller(params);
    if (found instanceof NextResponse) return found;
    if (found.user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const goal = await clearPolarGoal(found.user.id, found.threadId);
    return NextResponse.json({ goal });
}

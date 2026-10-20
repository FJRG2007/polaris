/**
 * POST /api/polar/threads/:id/branch - a new conversation holding the path up
 * to one message of this one ("Branch into new chat"). Answers the new
 * thread's row so the screen can list and open it. Another person's thread, or
 * a message that is not in it, answers as a thread that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { branchPolarThread } from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({ messageId: z.string().trim().min(1).max(64) }).strict();

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-branch:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const thread = await branchPolarThread(user.id, id.data, body.data.messageId);
    return thread
        ? NextResponse.json({ thread })
        : NextResponse.json({ error: "not_found" }, { status: 404 });
}

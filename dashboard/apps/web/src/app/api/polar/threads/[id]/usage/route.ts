/**
 * GET /api/polar/threads/:id/usage - what one of the caller's chats has spent:
 * tokens in and out, answers, and the estimated cost of the priced ones.
 * Another person's chat, or one that was never saved, is not found.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarThreadUsage } from "@/lib/polar/usage";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const thread = await prisma.polarThread.findFirst({
        where: { id: id.data, userId: user.id },
        select: { id: true }
    });
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await polarThreadUsage(user.id, id.data));
}

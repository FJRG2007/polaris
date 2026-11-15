/**
 * GET /api/polar/threads/[id]/subagents - the subagents a chat started, for
 * its panel and the cards in its transcript, with their live status. None for
 * a chat that is not the caller's.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { listSubagentRuns, settleInterrupted } from "@/lib/polar/subagents/store";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    await settleInterrupted(user.id, id.data);
    return NextResponse.json(
        { subagents: await listSubagentRuns(user.id, id.data) },
        { headers: { "cache-control": "no-store" } }
    );
}

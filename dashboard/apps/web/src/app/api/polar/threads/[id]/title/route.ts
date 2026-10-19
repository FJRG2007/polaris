/**
 * GET /api/polar/threads/:id/title - the thread's title, once the model has
 * finished naming it (or given up). The screen asks after a new thread's first
 * answer and swaps the placeholder it shows for this. Another person's id
 * answers as a thread that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { settledPolarTitle } from "@/lib/polar/titles";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const title = await settledPolarTitle(user.id, id.data);
    return title === null
        ? NextResponse.json({ error: "not_found" }, { status: 404 })
        : NextResponse.json({ title });
}

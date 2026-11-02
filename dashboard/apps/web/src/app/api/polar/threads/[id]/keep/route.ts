/** POST /api/polar/threads/:id/keep - keeps a temporary chat as an ordinary one. */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { keepPolarThread } from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const kept = await keepPolarThread(user.id, id.data);
    if (!kept) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
}

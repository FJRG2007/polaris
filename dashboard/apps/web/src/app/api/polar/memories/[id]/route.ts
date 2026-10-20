/**
 * One of the signed-in person's Polar memories: PATCH rewrites it, DELETE
 * removes it. Another person's id answers as a memory that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { memoryTextSchema } from "@/lib/polar/shared";
import { rateLimit } from "@/lib/rate-limit-service";
import { deletePolarMemory, editPolarMemory } from "@/lib/polar/memory";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const patchSchema = z.object({ text: memoryTextSchema }).strict();

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const limited = await rateLimit(`polar-memory:${user.id}`, 60, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const saved = await editPolarMemory(user.id, id.data, body.data.text);
    if (saved === null) return NOT_FOUND();
    if (typeof saved === "string") return NextResponse.json({ error: saved }, { status: 400 });
    return NextResponse.json({ memory: saved });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return (await deletePolarMemory(user.id, id.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}

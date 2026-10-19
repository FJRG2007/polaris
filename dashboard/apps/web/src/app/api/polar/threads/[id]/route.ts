/**
 * One of the signed-in person's Polar conversations: GET reads it, PATCH
 * renames it or replaces its queue of waiting messages, DELETE removes it.
 * Another person's id answers as a thread that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { queueSchema } from "@/lib/polar/shared";
import { deletePolarThread, getPolarThread, renamePolarThread, setPolarQueue } from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const patchSchema = z
    .object({
        title: z.string().trim().min(1).max(120).optional(),
        queue: queueSchema.optional()
    })
    .refine((value) => value.title !== undefined || value.queue !== undefined);

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const thread = await getPolarThread(user.id, id.data);
    return thread ? NextResponse.json({ thread }) : NOT_FOUND();
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    let found = true;
    if (body.data.title !== undefined) found = await renamePolarThread(user.id, id.data, body.data.title);
    if (found && body.data.queue !== undefined) found = await setPolarQueue(user.id, id.data, body.data.queue);
    return found ? NextResponse.json({ ok: true }) : NOT_FOUND();
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return (await deletePolarThread(user.id, id.data)) ? NextResponse.json({ ok: true }) : NOT_FOUND();
}

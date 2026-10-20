/**
 * One of the signed-in person's Polar conversations: GET reads it, PATCH
 * renames it, pins or archives it, files it in a project (or takes it out with
 * `projectId: null`), or replaces its queue of waiting messages; DELETE removes
 * it. Another person's id - or another person's project - answers as a thread
 * that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { stopPolarRun } from "@/lib/polar/runs";
import { queueSchema, threadTitleSchema } from "@/lib/polar/shared";
import {
    changePolarThread,
    deletePolarThread,
    getPolarThread,
    renamePolarThread,
    setPolarQueue
} from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const patchSchema = z
    .object({
        title: threadTitleSchema.optional(),
        queue: queueSchema.optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        projectId: z.string().uuid().nullable().optional()
    })
    .strict()
    .refine((value) => Object.values(value).some((field) => field !== undefined));

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const thread = await getPolarThread(user.id, id.data);
    return thread ? NextResponse.json({ thread }) : NOT_FOUND();
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const { title, queue, pinned, archived, projectId } = body.data;
    const changing = pinned !== undefined || archived !== undefined || projectId !== undefined;
    if (changing && user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    let found = true;
    if (changing)
        found = await changePolarThread(user.id, id.data, { pinned, archived, projectId });
    if (found && title !== undefined) found = await renamePolarThread(user.id, id.data, title);
    if (found && queue !== undefined) found = await setPolarQueue(user.id, id.data, queue);
    return found ? NextResponse.json({ ok: true }) : NOT_FOUND();
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    // An answer still running in a deleted chat has nowhere left to go.
    stopPolarRun(user.id, id.data);
    return (await deletePolarThread(user.id, id.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}

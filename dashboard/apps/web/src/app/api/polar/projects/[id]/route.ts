/**
 * One of the signed-in person's Polar projects: PATCH renames it or rewrites
 * its instructions, DELETE removes the folder (its chats are kept and go back
 * to Recents). Another person's id answers as a project that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { deletePolarProject, updatePolarProject } from "@/lib/polar/projects";
import { projectInstructionsSchema, projectNameSchema } from "@/lib/polar/shared";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const patchSchema = z
    .object({
        name: projectNameSchema.optional(),
        instructions: projectInstructionsSchema.optional()
    })
    .strict()
    .refine((value) => value.name !== undefined || value.instructions !== undefined);

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return (await updatePolarProject(user.id, id.data, body.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return (await deletePolarProject(user.id, id.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}

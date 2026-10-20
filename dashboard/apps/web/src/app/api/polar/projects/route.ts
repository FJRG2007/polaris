/**
 * POST /api/polar/projects - a new project (a folder of chats whose
 * instructions reach the model) for the signed-in person. The sidebar reads
 * the list with the conversations, from GET /api/polar/threads.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { createPolarProject } from "@/lib/polar/projects";
import { projectInstructionsSchema, projectNameSchema } from "@/lib/polar/shared";

export const dynamic = "force-dynamic";

const bodySchema = z
    .object({ name: projectNameSchema, instructions: projectInstructionsSchema.default("") })
    .strict();

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const project = await createPolarProject(user.id, body.data);
    return project
        ? NextResponse.json({ project })
        : NextResponse.json({ error: "too_many" }, { status: 409 });
}

/**
 * One of the signed-in person's Polar "/" commands: PATCH rewrites it (the
 * whole command, as the form sends it), DELETE removes it. Another person's id
 * answers as a command that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { polarCommandInputSchema } from "@/lib/polar/shared";
import { deletePolarCommand, updatePolarCommand } from "@/lib/polar/commands";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const STATUS = { too_many: 409, taken: 409, unknown_model: 409, not_found: 404 } as const;

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const body = polarCommandInputSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const command = await updatePolarCommand(user.id, id.data, body.data);
    return typeof command === "string"
        ? NextResponse.json({ error: command }, { status: STATUS[command] })
        : NextResponse.json({ command });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return (await deletePolarCommand(user.id, id.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}

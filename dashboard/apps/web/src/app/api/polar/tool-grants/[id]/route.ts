/**
 * DELETE revokes one of the signed-in person's Polar "Always allow" grants, so
 * the tool asks again. Another person's id answers as one that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { revokeGrant } from "@/lib/polar/tool-grants";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success || !(await revokeGrant(user.id, id.data)))
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
}

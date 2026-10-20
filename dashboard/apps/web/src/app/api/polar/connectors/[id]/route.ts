/**
 * PATCH  /api/polar/connectors/:id - turns it on or off, or sets one tool to
 *        always allow, needs approval, or blocked.
 * DELETE /api/polar/connectors/:id - removes it and everything stored with it.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import * as store from "@/lib/polar/connectors/store";
import { connectorPatchSchema } from "@/lib/polar/connectors/policy";
import { connectorGate, readJsonBody, refuse } from "@/lib/polar/connectors/caller";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user);
    if (refused) return refused;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return refuse("not_found", 404);
    const patch = connectorPatchSchema.safeParse(await readJsonBody(request));
    if (!patch.success) return refuse("invalid", 400);
    const { enabled, tool } = patch.data;
    if (enabled !== undefined && !(await store.setEnabled(user.id, id.data, enabled))) {
        return refuse("not_found", 404);
    }
    if (tool && !(await store.setToolPolicy(user.id, id.data, tool.name, tool.policy))) {
        return refuse("not_found", 404);
    }
    const found = await store.ownConnector(user.id, id.data);
    if (!found) return refuse("not_found", 404);
    return NextResponse.json({ connector: store.viewOf(found.row, found.secret) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user);
    if (refused) return refused;
    const id = idSchema.safeParse((await params).id);
    if (!id.success || !(await store.deleteConnector(user.id, id.data))) {
        return refuse("not_found", 404);
    }
    return NextResponse.json({ ok: true });
}

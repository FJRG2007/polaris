/** POST /api/polar/connectors/:id/test - connects, reads the tool list, and stores it. */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { checkConnector } from "@/lib/polar/connectors/session";
import { connectorGate, refuse } from "@/lib/polar/connectors/caller";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user, 20);
    if (refused) return refused;
    const id = z
        .string()
        .uuid()
        .safeParse((await params).id);
    if (!id.success) return refuse("not_found", 404);
    const view = await checkConnector(user.id, id.data);
    if (!view) return refuse("not_found", 404);
    return NextResponse.json({ connector: view });
}

/**
 * POST /api/polar/connectors/:id/sign-in - starts OAuth for the connector and
 * answers the authorization server's address for the browser to open.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { startSignIn } from "@/lib/polar/connectors/session";
import { connectorGate, refuse } from "@/lib/polar/connectors/caller";

// enigma:allow-unlimited-auth - limited per account in `connectorGate`, which every
// connector route calls first; it signs a connector in, not a person.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user, 10);
    if (refused) return refused;
    const id = z.string().uuid().safeParse((await params).id);
    if (!id.success) return refuse("not_found", 404);
    const started = await startSignIn(user.id, id.data);
    if (typeof started === "string") return refuse(started, started === "not_found" ? 404 : 409);
    return NextResponse.json(started);
}

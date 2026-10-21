/**
 * GET /api/polar/connectors/callback - where an authorization server sends
 * the person back. The state must be one this person started, still fresh;
 * either way they land on the connectors screen, which says how it went.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { appBaseUrl } from "@/lib/domain-service";
import { finishSignIn } from "@/lib/polar/connectors/session";
import { connectorGate } from "@/lib/polar/connectors/caller";

// enigma:allow-unlimited-auth - limited per account in `connectorGate`, which every
// connector route calls first; it signs a connector in, not a person.
export const dynamic = "force-dynamic";

const querySchema = z.object({
    state: z.string().min(1).max(200),
    code: z.string().min(1).max(4096)
});

export async function GET(request: Request): Promise<Response> {
    const back = new URL("/account/polar-tools", await appBaseUrl());
    const user = await polarCaller();
    const refused = user instanceof NextResponse ? user : await connectorGate(user, 20);
    if (user instanceof NextResponse || refused) {
        back.searchParams.set("connector", "failed");
        return NextResponse.redirect(back, 303);
    }
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    const id = query.success
        ? await finishSignIn(user.id, query.data.state, query.data.code)
        : null;
    back.searchParams.set("connector", id ? "signed_in" : "failed");
    return NextResponse.redirect(back, 303);
}

/**
 * POST /api/polar/connectors/:id/sign-in - starts OAuth for the connector and
 *      answers the authorization server's address for the browser to open.
 * GET  /api/polar/connectors/:id/sign-in - the same, as a page the connectors
 *      screen navigates to: it sends the window on to the authorization
 *      server, or back to the screen with why it could not. The desktop app
 *      keeps a round trip that starts on this address in its own window
 *      (`desktop/src/main/navigation.ts`), so the callback lands where the
 *      person is signed in instead of in their system browser.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { appBaseUrl } from "@/lib/domain-service";
import { settingsSection } from "@/lib/polar/settings-path";
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
    const id = z
        .string()
        .uuid()
        .safeParse((await params).id);
    if (!id.success) return refuse("not_found", 404);
    const started = await startSignIn(user.id, id.data);
    if (typeof started === "string") return refuse(started, started === "not_found" ? 404 : 409);
    return NextResponse.json(started);
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const back = new URL(settingsSection("connectors"), await appBaseUrl());
    back.searchParams.set("connector", "failed");
    const user = await polarCaller();
    if (user instanceof NextResponse) return NextResponse.redirect(back, 303);
    const refused = await connectorGate(user, 10);
    const id = z
        .string()
        .uuid()
        .safeParse((await params).id);
    if (refused || !id.success) return NextResponse.redirect(back, 303);
    const started = await startSignIn(user.id, id.data);
    return NextResponse.redirect(typeof started === "string" ? back : started.url, 303);
}

/**
 * GET  /api/polar/connectors - this person's connectors, without secrets.
 * POST /api/polar/connectors - adds one, then checks it once so the screen
 *      can show its tools straight away.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import * as store from "@/lib/polar/connectors/store";
import { checkConnector } from "@/lib/polar/connectors/session";
import { connectorInputSchema } from "@/lib/polar/connectors/policy";
import { connectorGate, readJsonBody, refuse } from "@/lib/polar/connectors/caller";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user);
    if (refused) return refused;
    return NextResponse.json({ connectors: await store.listConnectorViews(user.id) });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user, 10);
    if (refused) return refused;
    const input = connectorInputSchema.safeParse(await readJsonBody(request));
    if (!input.success) return refuse("invalid", 400);
    const created = await store.createConnector(user.id, input.data, await store.connectorPolicy());
    if (typeof created === "string") return refuse(created, created === "limit" ? 409 : 400);
    // An OAuth connector has nothing to check until it is signed in.
    const view =
        created.auth === "oauth"
            ? store.viewOf(created, null)
            : ((await checkConnector(user.id, created.id)) ?? store.viewOf(created, null));
    return NextResponse.json({ connector: view }, { status: 201 });
}

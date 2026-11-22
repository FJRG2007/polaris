/**
 * GET /api/polar/connectors/directory - one page of the connectors directory
 * (the catalog and this person's connections, each server once), searched and
 * filtered here, with this person's connections so the screen refreshes both
 * in one round trip. Never a secret: connections are `ConnectorView`s.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import * as store from "@/lib/polar/connectors/store";
import { connectorGate, refuse } from "@/lib/polar/connectors/caller";
import { buildDirectory, directoryQuerySchema, pageDirectory } from "@/lib/polar/connectors/directory";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const refused = await connectorGate(user);
    if (refused) return refused;
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const query = directoryQuerySchema.safeParse(params);
    if (!query.success) return refuse("invalid", 400);
    const [connectors, policy] = await Promise.all([
        store.listConnectorViews(user.id),
        store.connectorPolicy()
    ]);
    const { cursor, size, ...filters } = query.data;
    const page = pageDirectory(buildDirectory(connectors, policy.hosts), filters, cursor, size);
    return NextResponse.json({ ...page, connectors });
}

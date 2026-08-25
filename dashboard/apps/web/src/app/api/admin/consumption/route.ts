/**
 * Where the machine went, read after the screen has painted.
 *
 * Its own endpoint rather than data on the page, because it costs a listing from
 * the engine and a handful of queries across the whole deployment - a navigation
 * must not wait on either. The Consumption screen renders its chrome and asks for
 * this.
 *
 * Admin-only: it names every owner's services and installs, which is the whole
 * point of an operator screen and exactly what a member may not read. Node runtime
 * for Prisma and the Docker driver.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { readConsumption } from "@/lib/consumption-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const session = await getSession();
    const user = session?.user as { id?: string; isAdmin?: boolean } | undefined;
    if (!user?.isAdmin || !user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
        return NextResponse.json(await readConsumption(user.id));
    } catch (caught) {
        // There is nothing to get wrong in the request, so everything that fails
        // does so behind it: the engine unreachable, hostd refusing, a query
        // timing out. Reported as what it is, and left legible to logs and retries.
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read what the machine is using" },
            { status: 502 }
        );
    }
}

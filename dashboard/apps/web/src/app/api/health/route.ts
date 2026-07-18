/**
 * Liveness + readiness probe. Returns 200 only when the app is serving AND its
 * database answers a trivial query, so the container healthcheck, the installer's
 * post-deploy verification, and any external monitor can tell a truly-ready
 * deployment from one that is up but cannot reach Postgres (the exact failure
 * that otherwise surfaces only as a silent 502). Unauthenticated on purpose - it
 * exposes no data beyond a boolean status, and it is the probe every layer polls.
 */

import { prisma } from "@polaris/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return Response.json({ status: "ok" }, { status: 200 });
    } catch {
        // No error detail in the body: the probe must not leak connection strings
        // or driver internals to an unauthenticated caller.
        return Response.json({ status: "error", database: false }, { status: 503 });
    }
}

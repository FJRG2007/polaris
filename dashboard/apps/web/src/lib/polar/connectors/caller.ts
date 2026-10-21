/**
 * Who may reach the connector routes: somebody who uses Polar as themselves
 * (never through an administrator's view-as) on a deployment that lets them
 * connect servers. Every connector route asks this first.
 *
 * Server-only.
 */

import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/session";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarAccessFor } from "@/lib/polar/access";

export function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

/** Null when `user` (from `polarCaller()`) may go on; the refusal otherwise. */
export async function connectorGate(user: SessionUser, limit = 60): Promise<NextResponse | null> {
    if (user.viewingAs) return refuse("view_as", 403);
    if (!(await polarAccessFor(user.id)).connectors) return refuse("connectors_off", 403);
    const limited = await rateLimit(`polar-connectors:${user.id}`, limit, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);
    return null;
}

/** A small JSON body, or null for one too large or not JSON. */
export async function readJsonBody(request: Request, max = 16 * 1024): Promise<unknown> {
    const bytes = await readCappedBody(request, max);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

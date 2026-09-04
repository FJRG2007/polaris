/**
 * What exists here and is not being backed up yet.
 *
 * Loaded when somebody opens "Add resource" rather than with the console:
 * it asks every source to enumerate, which for game servers and deploy databases
 * is several queries, and nobody waiting for the table wants to pay for it.
 *
 * Admin-only. Node runtime for Prisma.
 */

import { RESOURCE_KINDS_INFO } from "@/lib/backups/kinds";
import { apiAdmin } from "@/lib/api-session";
import { discoverUnprotected } from "@/lib/backups/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const candidates = await discoverUnprotected(user.id);
    return Response.json({
        candidates: candidates.map((candidate) => ({
            ...candidate,
            kindLabel: RESOURCE_KINDS_INFO[candidate.kind].label,
            summary: RESOURCE_KINDS_INFO[candidate.kind].summary
        }))
    });
}

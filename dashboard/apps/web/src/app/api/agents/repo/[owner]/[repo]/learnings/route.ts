/**
 * Where a run writes back what it learned about the repository.
 *
 * The runtime seeds a notes file from the run context, lets the agent edit it,
 * and sends the whole file here once at the end of the run when it changed.
 * The next run starts from it, and the operator can read and correct it on the
 * repository's settings.
 *
 * Only a run may write, and only to the repository it belongs to - the same
 * identity check the run context makes. The body is the agent's own text, so it
 * is stored as data and never shown as anything but text.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { AGENT_LEARNINGS_MAX } from "@polaris/core";
import { authenticateRun } from "@/lib/agents/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
    learnings: z.string().max(AGENT_LEARNINGS_MAX),
    // Sent by the runtime for its own logs; not stored.
    model: z.string().max(200).optional()
});

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ owner: string; repo: string }> }
): Promise<Response> {
    const { owner, repo } = await params;
    const caller = await authenticateRun(request.headers);
    // i18n-ignore read by a machine, not shown to a person
    if (!caller) return Response.json({ error: "not a recognized run" }, { status: 401 });
    if (caller.repoFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
        // i18n-ignore read by a machine, not shown to a person
        return Response.json({ error: "this run is not for that repository" }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    // i18n-ignore read by a machine, not shown to a person
    if (!parsed.success) return Response.json({ error: "expected { learnings: string }" }, { status: 400 });

    await prisma.agentRepo.update({
        where: { id: caller.repoId },
        data: { learnings: parsed.data.learnings.trim() || null },
        select: { id: true }
    });
    return new Response(null, { status: 204 });
}

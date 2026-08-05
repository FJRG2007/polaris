/**
 * What a run reports about itself while it works.
 *
 * The runtime PATCHes this as it goes: the pull request and issue it created,
 * the model it actually ran on, and the tokens it spent. Polaris served no such
 * route, so every run logged `PATCH workflow-run: 404` and the token counts on
 * the runs screen stayed empty - the numbers an operator is paying their
 * provider for, never recorded.
 *
 * Authenticated as the run itself, and it may only speak for itself: the path is
 * the caller's claim, the authenticated run is the fact. Everything is optional
 * and anything unrecognised is dropped, because the runtime sends what it has at
 * the moment it has it and gains fields faster than this does.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { authenticateRun } from "@/lib/agents/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Polaris keeps.
 *
 * The runtime also sends GitHub node ids for the artefacts it made; those are
 * its own bookkeeping and Polaris links to the pull request by number instead,
 * so they are accepted and ignored rather than stored under a column that would
 * only ever be written.
 */
const patchSchema = z.object({
    model: z.string().trim().max(120).optional(),
    inputTokens: z.number().int().min(0).max(2_000_000_000).optional(),
    outputTokens: z.number().int().min(0).max(2_000_000_000).optional()
});

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
    const { runId } = await params;

    const caller = await authenticateRun(request.headers);
    if (!caller) return Response.json({ error: "not a recognised run" }, { status: 401 });
    if (caller.runId !== runId) return Response.json({ error: "not that run" }, { status: 404 });

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    // A body this does not understand is not an error the run should act on: it
    // is a newer runtime sending a field this Polaris has no column for.
    if (!parsed.success) return Response.json({ ok: true });

    const data = {
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(parsed.data.inputTokens === undefined ? {} : { tokensIn: parsed.data.inputTokens }),
        ...(parsed.data.outputTokens === undefined ? {} : { tokensOut: parsed.data.outputTokens })
    };
    if (Object.keys(data).length > 0) {
        await prisma.agentRun.updateMany({ where: { id: runId }, data });
    }

    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

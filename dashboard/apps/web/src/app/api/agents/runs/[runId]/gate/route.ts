/**
 * What the quality gate has got to, reported from inside the run.
 *
 * The pre-push hook calls this as it works so the run screen can show the
 * pipeline rather than a spinner. It is the run's own credential that authorizes
 * it - the same one every other call back uses - and the run may only report on
 * itself: the path is the caller's claim and the authenticated run is the fact.
 *
 * A report is never allowed to be the thing that fails a gate, so the hook
 * ignores whatever this answers. That cuts both ways: a refusal here has to be
 * safe to lose, which is why nothing downstream depends on these rows existing.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { authenticateRun } from "@/lib/agents/agent-auth";
import { GATE_STEPS, GATE_STEP_STATES, parseGateSteps } from "@/lib/agents/agent-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many steps one run may record. The gate has two, and a retry loop that
 *  somehow reported forever must not grow a row without bound. */
const MAX_STEPS = 40;

/** How much of a step's output is kept. Enough to act on, bounded because it is
 *  a command's stderr and a failing build can produce megabytes. */
const MAX_DETAIL = 4000;

const reportSchema = z.object({
    step: z.enum(GATE_STEPS),
    state: z.enum(GATE_STEP_STATES),
    detail: z.string().max(200_000).nullable().default(null)
});

export async function POST(
    request: Request,
    { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
    const { runId } = await params;

    const caller = await authenticateRun(request.headers);
    if (!caller) return Response.json({ error: "not a recognized run" }, { status: 401 });
    if (caller.runId !== runId) return Response.json({ error: "not that run" }, { status: 404 });

    const parsed = reportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "not a gate step" }, { status: 400 });

    const detail = parsed.data.detail?.trim().slice(-MAX_DETAIL) || null;

    // Read, append, write. A run reports its steps one at a time from a single
    // hook, so there is no second writer to lose an update to.
    const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { gateSteps: true } });
    if (!row) return Response.json({ error: "not that run" }, { status: 404 });

    const steps = parseGateSteps(row.gateSteps);
    // A step that reports again replaces its own last entry rather than adding
    // one, so "running" becomes "passed" instead of the screen showing both.
    const last = steps[steps.length - 1];
    const next =
        last && last.step === parsed.data.step && last.state === "running"
            ? [...steps.slice(0, -1), { ...parsed.data, detail, at: new Date().toISOString() }]
            : [...steps, { ...parsed.data, detail, at: new Date().toISOString() }];

    await prisma.agentRun.update({
        where: { id: runId },
        data: { gateSteps: JSON.stringify(next.slice(-MAX_STEPS)) }
    });

    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
